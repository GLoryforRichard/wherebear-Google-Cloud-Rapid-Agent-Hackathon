/**
 * Label normalization + within-photo dedup of detected boxes into product
 * entries. Ported from whataisle-readshelf.
 *
 * Pure module — no server-only marker so node:test can import it directly.
 */

import type { NormalizedBox } from './types';

export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // fold accents: Nestlé ≈ Nestle
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Readout names (stage-2 crop reading) override detection labels per box;
 * a null name keeps the detection label.
 */
export function applyReadoutNames(
  boxes: NormalizedBox[],
  names: (string | null)[]
): NormalizedBox[] {
  if (names.length !== boxes.length) return boxes;
  return boxes.map((b, i) => {
    const n = names[i];
    return n ? { ...b, label: n } : b;
  });
}

export interface NameEntry {
  name: string;
  boxIndices: number[];
  count: number;
}

/**
 * Deterministic within-photo dedup: group boxes by normalized label. Display
 * name = the label of the largest box in the group (most likely the group
 * box rather than a single-item fragment).
 */
export function extractEntries(boxes: NormalizedBox[]): NameEntry[] {
  const groups = new Map<string, number[]>();
  boxes.forEach((b, i) => {
    const key = normalizeLabel(b.label || '(unlabeled)');
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  return [...groups.values()].map((indices) => {
    const largest = indices.reduce((best, i) =>
      boxes[i].w * boxes[i].h > boxes[best].w * boxes[best].h ? i : best
    );
    return {
      name: boxes[largest].label || '(unlabeled)',
      boxIndices: indices,
      count: indices.length,
    };
  });
}
