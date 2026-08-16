'use client';

/**
 * Worker loop for the global scan queue.
 *
 * Each photo: persist to IndexedDB FIRST → submit to /api/vision/jobs
 * (async detect: 202 + jobId, idempotent by photo hash) → poll the job
 * every POLL_MS until done → persist products → auto-chain the save
 * (POST /api/shelf-evidence, SSE drain + server-side verification) →
 * saved. Everything runs in the module scope, so navigation anywhere in
 * the app never interrupts it; a reload re-enters through
 * restoreFromOutbox — and an item that already has a jobId RESUMES POLLING
 * instead of re-running detection (no re-bill on hard kills anymore).
 *
 * Detection runs server-side in a background worker (flex half-price tier
 * capable, minutes-long per photo is normal); the phone only holds cheap
 * short requests. DETECT_CONCURRENCY bounds how many jobs this client
 * keeps in flight; the server's own queue cap (429 + retryAfterMs) is the
 * real governor and is treated as backpressure, not failure.
 *
 * Retry engine: transient failures — network drops, 5xx, poll-expiry —
 * auto-retry up to MAX_ATTEMPTS per stage with backoff (re-submits are
 * hash-idempotent server-side, so retries can't double-bill); a window
 * 'online' listener revives network casualties immediately. Non-retryable
 * failures (413 too large, zero products detected) go straight to 'failed'
 * for manual action.
 *
 * Multi-tab caveat (accepted): two open tabs would both restore and process
 * the same outbox rows. This is a single-staff-device app; submits are
 * hash-idempotent and the save is upsert-based, so double-processing costs
 * duplicate polls at worst.
 */

import type { DetectedProduct } from '@/lib/gemini';
import {
  type OutboxRecord,
  type QueueErrorCode,
  outboxDelete,
  outboxListAll,
  outboxPut,
  outboxSupported,
  outboxUpdate,
} from './outbox';
import {
  addItem,
  getItem,
  getItems,
  removeItem as storeRemoveItem,
  updateItem,
} from './store';
import { preparePhoto, reviveBlob } from './prepare-photo';

// Outstanding server jobs this client keeps in flight (submitted, not yet
// done). Submissions are cheap 202s — the server's queue cap + worker
// concurrency govern actual pipeline load, and a full queue answers 429
// backpressure which we wait out without burning an attempt.
const DETECT_CONCURRENCY = 4;
/** Tries per stage, counting the first one. */
const MAX_ATTEMPTS = 3;
/** Backoff before auto-retry attempt 2 and 3. */
const BACKOFF_MS = [5_000, 15_000];
/** Job status poll cadence while any detection is in flight. */
const POLL_MS = 5_000;

const blobs = new Map<string, Blob>();
let pumping = false;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── public API ─────────────────────────────────────────────────────────────

/** Add photos for a shelf. Persisted before any network I/O. */
export async function enqueuePhotos(files: File[] | Blob[], aisle: string): Promise<void> {
  for (const file of files) {
    const id = newId();
    const createdAt = Date.now();
    let blob: Blob;
    try {
      blob = await preparePhoto(file);
    } catch (e) {
      console.warn('[queue] preparePhoto failed, keeping original:', e);
      blob = reviveBlob(file);
    }
    const record: OutboxRecord = {
      id,
      aisle,
      blob,
      status: 'queued',
      attempts: 0,
      createdAt,
    };
    if (outboxSupported()) {
      // Quota/private-mode failures degrade to in-memory-only (upload still
      // runs; only reload-survival is lost).
      await outboxPut(record).catch((err) => console.warn('[queue] outbox put failed:', err));
    }
    blobs.set(id, blob);
    addItem({
      id,
      aisle,
      status: 'queued',
      previewUrl: URL.createObjectURL(blob),
      products: [],
      attempts: 0,
      createdAt,
    });
  }
  void pump();
}

/** Manually retry a failed item from the stage it failed in (attempts reset).
 *  A 'detected' zero-result item may also be retried — it re-runs detection. */
export function retryItem(id: string): void {
  const item = getItem(id);
  if (!item || item.permanent) return;
  let backTo: 'queued' | 'detected';
  if (item.status === 'failed') {
    backTo = item.failedStage === 'save' ? 'detected' : 'queued';
  } else if (item.status === 'detected') {
    backTo = 'queued';
  } else {
    return;
  }
  const products = backTo === 'queued' ? [] : item.products;
  updateItem(id, {
    status: backTo,
    products,
    attempts: 0,
    error: undefined,
    errorCode: undefined,
    failedStage: undefined,
    nextAttemptAt: undefined,
  });
  void outboxUpdate(id, {
    status: backTo,
    attempts: 0,
    error: undefined,
    errorCode: undefined,
    failedStage: undefined,
    nextAttemptAt: undefined,
    productsJson: backTo === 'queued' ? undefined : JSON.stringify(products),
  });
  void pump();
}

/** Remove an item entirely (queue + outbox) — the queue page's Delete. The
 *  pump's `if (!getItem(id)) return` guards after every await make any
 *  in-flight response for this item a no-op. */
export function removeItem(id: string): void {
  blobs.delete(id);
  storeRemoveItem(id);
  void outboxDelete(id);
}

/** Rebuild the in-memory queue from IndexedDB after a reload. */
export async function restoreFromOutbox(): Promise<void> {
  if (!outboxSupported()) return;
  let records: OutboxRecord[] = [];
  try {
    records = await outboxListAll();
  } catch (e) {
    console.warn('[queue] outbox restore failed:', e);
    return;
  }
  for (const r of records) {
    if (getItem(r.id)) continue;
    // Roll interrupted in-flight statuses back to their last safe state.
    // A photo killed mid-detect WITH a jobId resumes polling — the server
    // job kept running, nothing is re-billed. Without a jobId (killed
    // between enqueue and submit) it re-queues; submits are hash-idempotent
    // anyway. One killed mid-save re-runs the save.
    const status =
      r.status === 'detecting' && !r.jobId ? 'queued'
      : r.status === 'saving' ? 'detected'
      : r.status;
    const products: DetectedProduct[] = r.productsJson
      ? (JSON.parse(r.productsJson) as DetectedProduct[])
      : [];
    const blob = reviveBlob(r.blob);
    blobs.set(r.id, blob);
    addItem({
      id: r.id,
      aisle: r.aisle,
      status,
      previewUrl: URL.createObjectURL(blob),
      products,
      jobId: r.jobId,
      failedStage: r.failedStage,
      errorCode: r.errorCode,
      nextAttemptAt: r.nextAttemptAt,
      permanent: r.permanent,
      attempts: r.attempts,
      error: r.error,
      createdAt: r.createdAt,
    });
  }
  if (getItems().some((i) => i.status === 'detecting' && i.jobId)) ensurePolling();
  void pump();
}

// ── worker loop ────────────────────────────────────────────────────────────

/** Eligible now = not waiting out a backoff window. */
function eligible(i: { nextAttemptAt?: number }): boolean {
  return !i.nextAttemptAt || i.nextAttemptAt <= Date.now();
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const items = getItems();
      // Saves are quick — run them before starting more detections.
      const toSave = items.find((i) => i.status === 'detected' && eligible(i));
      if (toSave) {
        await saveOne(toSave.id);
        continue;
      }
      const detecting = items.filter((i) => i.status === 'detecting').length;
      const next = items.find((i) => i.status === 'queued' && eligible(i));
      if (!next || detecting >= DETECT_CONCURRENCY) break;
      // Fire without awaiting so all submit slots fill; each submit settles
      // fast (202 + jobId) and re-enters pump (a no-op if a pump is already
      // looping — that loop re-reads the queue and picks up new work itself).
      updateItem(next.id, { status: 'detecting' });
      void outboxUpdate(next.id, { status: 'detecting' });
      void submitOne(next.id).finally(() => void pump());
    }
  } finally {
    pumping = false;
    armBackoffTimer();
  }
}

/** One shared timer that re-enters the pump when the earliest backoff
 *  window opens. Re-armed at the end of every pump pass. */
function armBackoffTimer(): void {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
  const now = Date.now();
  const waits = getItems()
    .filter((i) => (i.status === 'queued' || i.status === 'detected') && i.nextAttemptAt && i.nextAttemptAt > now)
    .map((i) => i.nextAttemptAt as number);
  if (waits.length === 0) return;
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    void pump();
  }, Math.max(250, Math.min(...waits) - now));
}

/**
 * Record a stage failure. Retryable failures under the attempt cap roll the
 * item back to its safe state with a backoff window; everything else parks
 * at 'failed' for the queue page.
 */
function failItem(
  id: string,
  stage: 'detect' | 'save',
  code: QueueErrorCode,
  message: string,
  opts: { autoRetry: boolean; permanent?: boolean } = { autoRetry: true }
): void {
  const item = getItem(id);
  if (!item) return;
  const attempts = item.attempts + 1;
  const safeState: 'detected' | 'queued' = stage === 'save' ? 'detected' : 'queued';
  const willRetry = opts.autoRetry && !opts.permanent && attempts < MAX_ATTEMPTS;
  const patch = {
    status: willRetry ? safeState : ('failed' as const),
    attempts,
    failedStage: stage,
    errorCode: code,
    error: message,
    permanent: opts.permanent,
    nextAttemptAt: willRetry ? Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] : undefined,
  };
  updateItem(id, patch);
  void outboxUpdate(id, patch);
  armBackoffTimer();
}

/** Submit one photo as a server scan job (202 + jobId, hash-idempotent).
 *  The item stays 'detecting' while the poll loop tracks the job. */
async function submitOne(id: string): Promise<void> {
  const item = getItem(id);
  const raw = blobs.get(id);
  if (!item || !raw) return;
  try {
    let blob: Blob;
    try {
      blob = await preparePhoto(raw);
    } catch (err) {
      if (!getItem(id)) return;
      failItem(
        id,
        'detect',
        'unreadable',
        err instanceof Error ? err.message : String(err),
        { autoRetry: false }
      );
      return;
    }
    if (!getItem(id)) return;
    if (blob !== raw) {
      const prevUrl = getItem(id)?.previewUrl;
      blobs.set(id, blob);
      updateItem(id, { previewUrl: URL.createObjectURL(blob) });
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      void outboxUpdate(id, { blob });
    }
    const fd = new FormData();
    fd.append('image', blob, 'photo.jpg');
    fd.append('aisle', item.aisle);
    let res: Response;
    try {
      res = await fetch('/api/vision/jobs', { method: 'POST', body: fd });
    } catch (err) {
      if (!getItem(id)) return;
      failItem(id, 'detect', 'network', err instanceof Error ? err.message : String(err));
      return;
    }
    if (!getItem(id)) return; // removed while in flight
    if (res.status === 413) {
      failItem(id, 'detect', 'too_large', 'photo over 20 MB', { autoRetry: false, permanent: true });
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      ok: boolean;
      jobId?: string;
      status?: string;
      error?: string;
      retryAfterMs?: number;
    } | null;
    if (!getItem(id)) return;
    if (res.status === 429) {
      // Server queue full — backpressure, not a failure. Wait it out
      // WITHOUT consuming an attempt; the outbox is the deep buffer.
      const patch = { status: 'queued' as const, nextAttemptAt: Date.now() + (data?.retryAfterMs ?? 20_000) };
      updateItem(id, patch);
      void outboxUpdate(id, patch);
      armBackoffTimer();
      return;
    }
    if (!data?.ok || !data.jobId) {
      const msg = data?.error || `HTTP ${res.status}`;
      const unreadable = /unreadable|formdata|boundary/i.test(msg);
      failItem(id, 'detect', unreadable ? 'unreadable' : 'server', msg);
      return;
    }
    updateItem(id, { jobId: data.jobId, jobStage: undefined });
    void outboxUpdate(id, { jobId: data.jobId });
    ensurePolling();
  } catch (err) {
    if (!getItem(id)) return;
    failItem(id, 'detect', 'server', err instanceof Error ? err.message : String(err));
  }
}

// ── job polling ────────────────────────────────────────────────────────────

function ensurePolling(): void {
  if (pollTimer) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollJobs();
  }, POLL_MS);
}

async function pollJobs(): Promise<void> {
  const inFlight = getItems().filter((i) => i.status === 'detecting' && i.jobId);
  for (const item of inFlight) {
    await pollOne(item.id).catch(() => {});
  }
  if (getItems().some((i) => i.status === 'detecting' && i.jobId)) ensurePolling();
}

async function pollOne(id: string): Promise<void> {
  const item = getItem(id);
  if (!item || item.status !== 'detecting' || !item.jobId) return;
  let res: Response;
  try {
    res = await fetch(`/api/vision/jobs/${item.jobId}`);
  } catch {
    return; // offline etc. — polls are free to skip; the job runs server-side
  }
  if (!getItem(id)) return;
  if (res.status === 404) {
    // TTL/ack race — the job doc is gone. Re-submit (hash-idempotent).
    updateItem(id, { jobId: undefined, jobStage: undefined });
    void outboxUpdate(id, { jobId: undefined });
    failItem(id, 'detect', 'server', 'job expired server-side');
    return;
  }
  const data = (await res.json().catch(() => null)) as {
    ok: boolean;
    status?: string;
    stage?: string;
    products?: DetectedProduct[];
    error?: string;
  } | null;
  if (!getItem(id) || !data?.ok) return;

  if (data.status === 'done') {
    const jobId = item.jobId;
    const blob = blobs.get(id);
    const raw = data.products ?? [];
    const products = blob ? await cropThumbnails(blob, raw).catch(() => raw) : raw;
    if (!getItem(id)) return;
    updateItem(id, {
      status: 'detected',
      products,
      jobId: undefined,
      jobStage: undefined,
      error: undefined,
      errorCode: undefined,
      nextAttemptAt: undefined,
    });
    await outboxUpdate(id, {
      status: 'detected',
      productsJson: JSON.stringify(products),
      jobId: undefined,
      error: undefined,
      errorCode: undefined,
      nextAttemptAt: undefined,
    });
    // Ack AFTER the products are safely in IndexedDB — the server frees the
    // job dir early; a crash between poll and ack just means TTL cleanup.
    void fetch(`/api/vision/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
    void pump(); // chain the save
    return;
  }

  if (data.status === 'failed') {
    updateItem(id, { jobId: undefined, jobStage: undefined });
    void outboxUpdate(id, { jobId: undefined });
    // failItem rolls back to 'queued'; the re-submit resets the failed
    // server job (hash match) instead of creating a duplicate.
    failItem(id, 'detect', 'server', data.error || 'scan failed server-side');
    return;
  }

  if (data.stage && data.stage !== item.jobStage) {
    updateItem(id, { jobStage: data.stage });
  }
}

/** Auto-save one detected photo's products (per-photo save, no cross-photo merge). */
async function saveOne(id: string): Promise<void> {
  const item = getItem(id);
  if (!item || item.status !== 'detected') return;
  if (item.products.length === 0) {
    // Gemini sometimes returns [] even on good shots — surface it as a
    // manually-retryable failure instead of silently "saving" nothing.
    // No auto-retry: an identical frame most likely yields [] again.
    failItem(id, 'detect', 'nothing_detected', 'nothing detected', { autoRetry: false });
    return;
  }
  updateItem(id, { status: 'saving' });
  void outboxUpdate(id, { status: 'saving' });
  const ok = await postSave(item.aisle, item.products);
  if (!getItem(id)) return;
  if (ok) {
    updateItem(id, { status: 'saved', error: undefined, errorCode: undefined });
    blobs.delete(id);
    void outboxDelete(id);
  } else {
    failItem(id, 'save', 'save', 'save failed');
  }
}

// ── save transport ─────────────────────────────────────────────────────────

/**
 * POST /api/shelf-evidence and drain its SSE stream. The server survives a
 * dropped stream (the write still lands — the route swallows enqueue errors
 * once the client is gone), so on a stream error we verify against the
 * aisle's recently-updated products before declaring failure — the same
 * reconciliation ProgressScreen did for iOS backgrounding.
 */
async function postSave(aisle: string, products: DetectedProduct[]): Promise<boolean> {
  const runStart = Date.now();
  try {
    const res = await fetch('/api/shelf-evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aisle, products }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawDone = false;
    let sawError: string | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const pieces = buf.split('\n\n');
      buf = pieces.pop() ?? '';
      for (const piece of pieces) {
        const line = piece.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5)) as { type?: string; error?: string };
          if (ev.type === 'done') sawDone = true;
          if (ev.type === 'error') sawError = ev.error ?? 'save error';
        } catch {
          /* ignore malformed frame */
        }
      }
    }
    if (sawError) throw new Error(sawError);
    if (sawDone) return true;
    throw new Error('stream ended without done event');
  } catch (err) {
    console.warn('[queue] save stream failed, verifying server-side:', err);
    return verifyServerSideSave(aisle, runStart);
  }
}

/** Did the save land anyway? Query the aisle for docs updated since runStart. */
async function verifyServerSideSave(aisle: string, runStartTime: number): Promise<boolean> {
  // Give the server a moment to finish the write the stream abandoned.
  await new Promise((r) => setTimeout(r, 2500));
  try {
    const res = await fetch(`/api/admin/products?aisle=${encodeURIComponent(aisle)}`);
    if (!res.ok) return false;
    const data = (await res.json()) as {
      ok: boolean;
      products?: Array<{ updated_at?: string }>;
    };
    if (!data.ok || !Array.isArray(data.products)) return false;
    const sinceMs = runStartTime - 5000;
    return data.products.some(
      (p) => p.updated_at && new Date(p.updated_at).getTime() >= sinceMs
    );
  } catch {
    return false;
  }
}

// ── connectivity revival ───────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // Backoff windows exist to wait out exactly this — skip them, and give
    // network-classified casualties a fresh set of attempts (the failure was
    // the connection, not the photo).
    for (const i of getItems()) {
      if ((i.status === 'queued' || i.status === 'detected') && i.nextAttemptAt) {
        updateItem(i.id, { nextAttemptAt: undefined });
        void outboxUpdate(i.id, { nextAttemptAt: undefined });
      }
      if (i.status === 'failed' && i.errorCode === 'network') {
        const backTo = i.failedStage === 'save' ? 'detected' : 'queued';
        updateItem(i.id, { status: backTo, attempts: 0, nextAttemptAt: undefined });
        void outboxUpdate(i.id, { status: backTo, attempts: 0, nextAttemptAt: undefined });
      }
    }
    void pump();
    void pollJobs(); // resume job polls immediately after reconnect
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Merge + dedupe across photos: prefer entries with a thumbnail, then confidence. */
export function mergeDetected(
  products: DetectedProduct[],
  excludeNames: Set<string>
): DetectedProduct[] {
  const rank = (c: string | undefined) =>
    c === 'high' ? 3 : c === 'medium' ? 2 : c === 'low' ? 1 : 0;
  const byName = new Map<string, DetectedProduct>();
  for (const prod of products) {
    if (excludeNames.has(prod.name)) continue;
    const prior = byName.get(prod.name);
    if (!prior) {
      byName.set(prod.name, prod);
      continue;
    }
    const better =
      (!prior.thumbnail && prod.thumbnail) || rank(prod.confidence) > rank(prior.confidence);
    if (better) byName.set(prod.name, prod);
  }
  return Array.from(byName.values());
}

/** Client-side canvas fallback for products the server returned no thumbnail
 *  for. Lives in the pump (not SnapScreen) so it still runs when no scan UI
 *  is mounted. */
async function cropThumbnails(blob: Blob, products: DetectedProduct[]): Promise<DetectedProduct[]> {
  const needsCrop = products.some(
    (p) => !p.thumbnail && Array.isArray(p.box_2d) && p.box_2d.length === 4
  );
  if (!needsCrop) return products;

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
    return products.map((p) => {
      if (p.thumbnail) return p;
      if (!p.box_2d || p.box_2d.length !== 4) return p;
      const [y0, x0, y1, x1] = p.box_2d;
      const sx = (Math.min(x0, x1) / 1000) * img.width;
      const sy = (Math.min(y0, y1) / 1000) * img.height;
      const sw = (Math.abs(x1 - x0) / 1000) * img.width;
      const sh = (Math.abs(y1 - y0) / 1000) * img.height;
      if (sw < 8 || sh < 8) return p;
      const TARGET = 160;
      const ratio = sh / sw;
      const canvas = document.createElement('canvas');
      canvas.width = TARGET;
      canvas.height = Math.max(40, Math.min(TARGET * 2, Math.round(TARGET * ratio)));
      const ctx = canvas.getContext('2d');
      if (!ctx) return p;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      return { ...p, thumbnail: canvas.toDataURL('image/jpeg', 0.78) };
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
