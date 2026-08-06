'use client';

/**
 * IndexedDB-backed outbox for the global scan queue, so an in-progress scan
 * survives a screen lock, app switch, tab close, or full page reload. Ported
 * from whataisle-store's scan-queue outbox, with two schema additions over
 * that version: `failedStage` is persisted (so a save-failure retried after
 * a reload re-runs ONLY the save instead of re-billing detection) and the
 * retry engine's `errorCode`/`nextAttemptAt`/`permanent` survive reloads.
 *
 * Record lifecycle: written on enqueue, updated on every status transition,
 * deleted once the item reaches 'saved' (or is removed by staff).
 */

const DB_NAME = 'wherebear-scan';
const STORE = 'queue';
const DB_VERSION = 1;

export type QueueErrorCode =
  | 'network'
  | 'too_large'
  | 'nothing_detected'
  | 'server'
  | 'save';

export interface OutboxRecord {
  id: string;
  aisle: string;
  blob: Blob;
  /** Persisted queue status. In-flight statuses are rolled back on restore. */
  status: 'queued' | 'detecting' | 'detected' | 'saving' | 'saved' | 'failed';
  /** JSON-serialized DetectedProduct[] once detection has completed. */
  productsJson?: string;
  /** Which stage the last failure happened in — drives retry routing. */
  failedStage?: 'detect' | 'save';
  /** Machine-readable failure class for i18n copy + retry policy. */
  errorCode?: QueueErrorCode;
  /** Epoch ms before which the pump must not re-attempt (backoff). */
  nextAttemptAt?: number;
  /** True = retrying can never succeed (e.g. photo over the 20 MB cap). */
  permanent?: boolean;
  attempts: number;
  error?: string;
  createdAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function outboxPut(record: OutboxRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(record));
}

/** Merge a partial update into an existing record (no-op if it's gone). */
export async function outboxUpdate(
  id: string,
  patch: Partial<Omit<OutboxRecord, 'id'>>
): Promise<void> {
  const existing = await tx<OutboxRecord | undefined>('readonly', (s) => s.get(id));
  if (!existing) return;
  await tx('readwrite', (s) => s.put({ ...existing, ...patch, id }));
}

export async function outboxDelete(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

export async function outboxListAll(): Promise<OutboxRecord[]> {
  const all = await tx<OutboxRecord[]>('readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

export function outboxSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}
