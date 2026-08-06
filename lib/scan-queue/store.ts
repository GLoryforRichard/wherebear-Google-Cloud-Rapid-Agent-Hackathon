'use client';

/**
 * Global scan queue — a module-level singleton OUTSIDE the React tree.
 *
 * Why: a queue living in SnapScreen's useState dies when the component
 * unmounts, throwing away every in-flight detection (the server finishes
 * the expensive work and the result is discarded). Next.js client-side
 * navigation never unloads the JS context, so a module singleton keeps
 * scanning and uploading no matter where staff navigate. Components
 * subscribe via useSyncExternalStore and are pure views.
 *
 * Hard-kill cases (reload, tab close, iOS killing a backgrounded page) are
 * covered by the IndexedDB outbox + QueueBoot restore, not by this store.
 */

import { useSyncExternalStore } from 'react';
import type { DetectedProduct } from '@/lib/gemini';
import type { QueueErrorCode } from './outbox';

export type QueueStatus =
  | 'queued'
  | 'detecting'
  | 'detected'   // detection done; being chained into the auto-save
  | 'saving'
  | 'saved'
  | 'failed';

export interface QueueItem {
  id: string;
  aisle: string;
  status: QueueStatus;
  /** Object URL for the photo preview (recreated from the blob on restore). */
  previewUrl: string;
  /** Detection result once status reaches 'detected'. */
  products: DetectedProduct[];
  /** Which stage a failure happened in, for retry routing. */
  failedStage?: 'detect' | 'save';
  /** Machine-readable failure class for i18n copy + retry policy. */
  errorCode?: QueueErrorCode;
  /** Epoch ms before which the pump must not re-attempt (backoff). */
  nextAttemptAt?: number;
  /** True = retrying can never succeed (photo over the size cap). */
  permanent?: boolean;
  error?: string;
  attempts: number;
  createdAt: number;
}

interface QueueState {
  items: QueueItem[];
}

/** Marathon sessions: keep at most this many finished items around as the
 *  "recently saved" confidence trail. Beyond it the oldest saved item is
 *  evicted (its object URL revoked) — the durable record is Shelf admin. */
const MAX_SAVED_ITEMS = 12;

let state: QueueState = { items: [] };
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): QueueState {
  return state;
}

export function getItems(): QueueItem[] {
  return state.items;
}

export function getItem(id: string): QueueItem | undefined {
  return state.items.find((i) => i.id === id);
}

export function addItem(item: QueueItem): void {
  state = { items: [...state.items, item] };
  emit();
}

export function updateItem(id: string, patch: Partial<QueueItem>): void {
  let changed = false;
  let items = state.items.map((i) => {
    if (i.id !== id) return i;
    changed = true;
    return { ...i, ...patch };
  });
  if (!changed) return;
  if (patch.status === 'saved') items = pruneSaved(items);
  state = { items };
  emit();
}

/** Evict the oldest saved items beyond the cap, revoking their previews. */
function pruneSaved(items: QueueItem[]): QueueItem[] {
  const saved = items.filter((i) => i.status === 'saved');
  if (saved.length <= MAX_SAVED_ITEMS) return items;
  const evict = new Set(
    saved
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, saved.length - MAX_SAVED_ITEMS)
      .map((i) => i.id)
  );
  for (const i of items) {
    if (evict.has(i.id)) URL.revokeObjectURL(i.previewUrl);
  }
  return items.filter((i) => !evict.has(i.id));
}

export function removeItem(id: string): void {
  const item = getItem(id);
  if (item) URL.revokeObjectURL(item.previewUrl);
  state = { items: state.items.filter((i) => i.id !== id) };
  emit();
}

/** Drop finished items from the in-memory list (their outbox rows are gone). */
export function clearSaved(): void {
  for (const i of state.items) {
    if (i.status === 'saved') URL.revokeObjectURL(i.previewUrl);
  }
  state = { items: state.items.filter((i) => i.status !== 'saved') };
  emit();
}

/** React binding. Returns the whole queue state; select in the component. */
export function useScanQueue(): QueueState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
