/**
 * Pure band math for the rows-hd detection algorithm: shelf rows → gap-free
 * bands, band-local → full-image coordinate mapping, and cross-band dedup.
 * Ported verbatim from whataisle-readshelf.
 *
 * Pure module — no server-only marker so node:test can import it directly.
 */

import type { Band, NormalizedBox } from './types';

export const BAND_OVERLAP = 0.03;
export const MAX_BANDS = 8;
export const DEDUP_IOU = 0.6;

/**
 * Rows → bands. Cut lines sit midway between consecutive rows, so the cores
 * tile [0,1] with no gaps: a detector that misses a row cannot leave any part
 * of the image unscanned. Each slice sent to the model is core ± overlap.
 */
export function buildBands(
  rows: { y0: number; y1: number }[],
  overlap = BAND_OVERLAP,
  maxBands = MAX_BANDS
): Band[] {
  const clean = rows
    .map((r) => ({
      y0: Math.max(0, Math.min(1, r.y0)),
      y1: Math.max(0, Math.min(1, r.y1)),
    }))
    .filter((r) => r.y1 - r.y0 > 0.02)
    .sort((a, b) => a.y0 - b.y0);
  if (clean.length === 0) return [{ core0: 0, core1: 1, y0: 0, y1: 1 }];

  // cut lines: 0, midpoints between consecutive rows, 1 — strictly increasing
  const cuts: number[] = [0];
  for (let i = 1; i < clean.length; i++) {
    const mid = (clean[i - 1].y1 + clean[i].y0) / 2;
    if (mid > cuts[cuts.length - 1] + 0.03) cuts.push(mid);
  }
  cuts.push(1);

  const bands: Band[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    bands.push({ core0: cuts[i], core1: cuts[i + 1], y0: 0, y1: 0 });
  }
  // cap band count by merging the smallest adjacent pair
  while (bands.length > maxBands) {
    let idx = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bands.length - 1; i++) {
      const merged = bands[i + 1].core1 - bands[i].core0;
      if (merged < best) {
        best = merged;
        idx = i;
      }
    }
    bands.splice(idx, 2, {
      core0: bands[idx].core0,
      core1: bands[idx + 1].core1,
      y0: 0,
      y1: 0,
    });
  }
  return bands.map((b) => ({
    ...b,
    y0: Math.max(0, b.core0 - overlap),
    y1: Math.min(1, b.core1 + overlap),
  }));
}

/** Band-local box fractions → full-image fractions. */
export function mapBandBox(box: NormalizedBox, band: Band): NormalizedBox {
  const bandH = band.y1 - band.y0;
  return {
    label: box.label,
    x: box.x,
    w: box.w,
    y: band.y0 + box.y * bandH,
    h: box.h * bandH,
  };
}

function iou(a: NormalizedBox, b: NormalizedBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Merge per-band detections: a box belongs to the band whose core contains
 * its center (drops overlap-margin duplicates), then IoU dedup keeps the
 * larger box.
 */
export function mergeBandBoxes(
  perBand: NormalizedBox[][],
  bands: Band[]
): { boxes: NormalizedBox[]; dropped: number } {
  const owned: NormalizedBox[] = [];
  let dropped = 0;
  perBand.forEach((boxes, bandIndex) => {
    for (const box of boxes) {
      const cy = box.y + box.h / 2;
      const owner = bands.findIndex(
        (b, i) => cy >= b.core0 && (cy < b.core1 || i === bands.length - 1)
      );
      if (owner === bandIndex || owner === -1) owned.push(box);
      else dropped++;
    }
  });
  owned.sort((a, b) => b.w * b.h - a.w * a.h);
  const kept: NormalizedBox[] = [];
  for (const box of owned) {
    if (kept.some((k) => iou(k, box) > DEDUP_IOU)) dropped++;
    else kept.push(box);
  }
  // restore top-to-bottom, left-to-right reading order
  kept.sort((a, b) => a.y - b.y || a.x - b.x);
  return { boxes: kept, dropped };
}

/**
 * Deterministic post-process: merge boxes with the same label that sit
 * adjacent to each other — the "one box per group of identical products"
 * requirement applied on top of models that fragment groups into per-item
 * boxes. Far-apart same-label groups (misplaced strays) stay separate.
 * NOTE: the champion rows-hd path deliberately does NOT run this (measured
 * better without); kept for callers that want it.
 */
export const LABEL_MERGE_MARGIN = 0.015;

export function mergeSameLabelGroups(
  boxes: NormalizedBox[],
  margin = LABEL_MERGE_MARGIN
): { boxes: NormalizedBox[]; merged: number } {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  };
  const near = (a: NormalizedBox, b: NormalizedBox) =>
    a.x - margin < b.x + b.w + margin &&
    b.x - margin < a.x + a.w + margin &&
    a.y - margin < b.y + b.h + margin &&
    b.y - margin < a.y + a.h + margin;
  for (let i = 0; i < boxes.length; i++) {
    const li = norm(boxes[i].label);
    if (!li) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      if (li === norm(boxes[j].label) && near(boxes[i], boxes[j])) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, NormalizedBox[]>();
  boxes.forEach((b, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(b);
    else groups.set(r, [b]);
  });
  const out = [...groups.values()].map((g) => {
    if (g.length === 1) return g[0];
    const x0 = Math.min(...g.map((b) => b.x));
    const y0 = Math.min(...g.map((b) => b.y));
    const x1 = Math.max(...g.map((b) => b.x + b.w));
    const y1 = Math.max(...g.map((b) => b.y + b.h));
    return { label: g[0].label, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
  out.sort((a, b) => a.y - b.y || a.x - b.x);
  return { boxes: out, merged: boxes.length - out.length };
}

/**
 * Row-detector output sanitation: swap reversed y pairs and auto-detect 0-1
 * fractional scale (the prompt asks for 0-1000 integers, but models regress).
 */
export function normalizeDetectedRows(
  rows: { y0: number; y1: number }[]
): { y0: number; y1: number }[] {
  if (rows.length === 0) return [];
  const allFractional = rows.every((r) => r.y0 <= 1 && r.y1 <= 1);
  const scale = allFractional ? 1 : 1000;
  return rows.map((r) => {
    const a = r.y0 / scale;
    const b = r.y1 / scale;
    return a <= b ? { y0: a, y1: b } : { y0: b, y1: a };
  });
}
