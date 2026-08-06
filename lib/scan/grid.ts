/**
 * Pure geometry + parsing for the grid readout stage: crop rectangles,
 * grid-cell layout, and grid-response validation. Ported verbatim from
 * whataisle-readshelf.
 *
 * Pure module — no server-only marker so node:test can import it directly.
 */

import { extractJson } from './box-parser';
import type { NormalizedBox } from './types';

/** Context margin around the box, as a fraction of the box's own size. */
export const CROP_PAD = 0.15;

const GRID_COLS = 2;
const CELL = 600;
const GAP = 32;
const LABEL_H = 48;

export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Fractional box → clamped pixel rect on a W×H image, with padding. */
export function cropRect(
  b: NormalizedBox,
  width: number,
  height: number,
  pad = CROP_PAD
): CropRect {
  const px = b.w * pad;
  const py = b.h * pad;
  const x0 = Math.max(0, (b.x - px) * width);
  const y0 = Math.max(0, (b.y - py) * height);
  const x1 = Math.min(width, (b.x + b.w + px) * width);
  const y1 = Math.min(height, (b.y + b.h + py) * height);
  // Enforce the 8px minimum by shifting the rect back inside the image —
  // expanding past the edge makes sharp.extract throw (`bad extract area`)
  // for sliver boxes hugging the right/bottom edge.
  const w = Math.min(width, Math.max(8, Math.ceil(x1 - x0)));
  const h = Math.min(height, Math.max(8, Math.ceil(y1 - y0)));
  const left = Math.max(0, Math.min(Math.floor(x0), width - w));
  const top = Math.max(0, Math.min(Math.floor(y0), height - h));
  return { left, top, width: w, height: h };
}

export interface GridCell {
  x: number;
  y: number;
  w: number;
  h: number;
  labelX: number;
  labelY: number;
}

/**
 * Pure layout math for n cells in a GRID_COLS-wide grid: white gaps, a label
 * strip above each cell for the index number.
 */
export function gridLayout(
  n: number,
  cols = GRID_COLS
): { width: number; height: number; cells: GridCell[] } {
  const rows = Math.ceil(n / cols);
  const cells: GridCell[] = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = GAP + col * (CELL + GAP);
    const y = GAP + row * (CELL + LABEL_H + GAP) + LABEL_H;
    cells.push({ x, y, w: CELL, h: CELL, labelX: x + 4, labelY: y - 10 });
  }
  return {
    width: cols * (CELL + GAP) + GAP,
    height: rows * (CELL + LABEL_H + GAP) + GAP,
    cells,
  };
}

export const GRID_CELL_SIZE = CELL;

/** Parse + validate one grid call's response; null = unusable (retry). */
export function parseGridNames(
  rawText: string,
  expected: number
): (string | null)[] | null {
  const data = extractJson(rawText) as { names?: unknown[] } | null;
  if (!data || !Array.isArray(data.names) || data.names.length !== expected) {
    return null;
  }
  return data.names.map((n) =>
    typeof n === 'string' && n.trim() ? n.trim() : null
  );
}
