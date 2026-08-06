/**
 * Tolerant parsing of vision-model box output into normalized fractional
 * boxes. Ported verbatim from whataisle-readshelf (unit-tested against real
 * model output quirks: Gemini y-first vs Qwen x-first, 0-1 / 0-1000 /
 * absolute-pixel scales, code fences, chatty preambles).
 *
 * Pure module — no server-only marker so node:test can import it directly.
 */

import type { NormalizedBox, ParseInfo } from './types';

export interface ParseResult extends ParseInfo {
  boxes: NormalizedBox[];
}

const COORD_KEYS_YX = ['box_2d'];
const COORD_KEYS_XY = ['bbox_2d', 'bbox', 'box', 'coordinates', 'bounding_box'];
const LABEL_KEYS = ['label', 'name', 'product', 'description', 'title'];

export function extractJson(text: string): unknown | null {
  const attempts: string[] = [text.trim()];
  // strip ``` fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1].trim());
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* keep trying */
    }
  }
  // balanced-bracket scan: first { or [ that parses
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (c === '\\' && inStr) {
        esc = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1));
          } catch {
            break; // try next opener
          }
        }
      }
    }
  }
  return null;
}

function findItemArray(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    if (data.every((it) => typeof it === 'object' && it !== null)) {
      return data as Record<string, unknown>[];
    }
    return null;
  }
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.boxes)) return findItemArray(obj.boxes);
    // Prefer a non-empty sibling: replies like {"shelf_labels":[],"products":
    // [...]} must not short-circuit on the first (empty) array and silently
    // drop the whole band's detections.
    let empty: Record<string, unknown>[] | null = null;
    for (const v of Object.values(obj)) {
      const found = findItemArray(v);
      if (found && found.length > 0) return found;
      if (found && empty === null) empty = found;
    }
    return empty;
  }
  return null;
}

interface RawBox {
  label: string;
  coords: number[];
  keyKind: 'yx' | 'xy' | null;
}

function extractRawBox(
  item: Record<string, unknown>,
  warnings: string[]
): RawBox | null {
  let label = '';
  for (const k of LABEL_KEYS) {
    if (typeof item[k] === 'string') {
      label = item[k] as string;
      break;
    }
  }

  for (const k of [...COORD_KEYS_YX, ...COORD_KEYS_XY]) {
    const v = item[k];
    const keyKind: 'yx' | 'xy' | null = COORD_KEYS_YX.includes(k) ? 'yx' : 'xy';
    if (
      Array.isArray(v) &&
      v.length === 4 &&
      v.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return { label, coords: v as number[], keyKind };
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const asNum = (x: unknown) =>
        typeof x === 'number' && Number.isFinite(x) ? x : null;
      const ymin = asNum(o.ymin ?? o.y_min ?? o.y1 ?? o.top);
      const xmin = asNum(o.xmin ?? o.x_min ?? o.x1 ?? o.left);
      const ymax = asNum(o.ymax ?? o.y_max ?? o.y2 ?? o.bottom);
      const xmax = asNum(o.xmax ?? o.x_max ?? o.x2 ?? o.right);
      if (ymin !== null && xmin !== null && ymax !== null && xmax !== null) {
        return { label, coords: [ymin, xmin, ymax, xmax], keyKind: 'yx' };
      }
    }
  }
  // coords directly on the item object ({ymin,...} at top level)
  const asNum = (x: unknown) =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;
  const ymin = asNum(item.ymin ?? item.y_min ?? item.y1);
  const xmin = asNum(item.xmin ?? item.x_min ?? item.x1);
  const ymax = asNum(item.ymax ?? item.y_max ?? item.y2);
  const xmax = asNum(item.xmax ?? item.x_max ?? item.x2);
  if (ymin !== null && xmin !== null && ymax !== null && xmax !== null) {
    return { label, coords: [ymin, xmin, ymax, xmax], keyKind: 'yx' };
  }
  warnings.push(
    `item without usable coordinates: ${JSON.stringify(item).slice(0, 120)}`
  );
  return null;
}

export function parseBoxes(
  rawText: string,
  imageWidth: number,
  imageHeight: number
): ParseResult {
  const warnings: string[] = [];
  const fail = (msg: string): ParseResult => ({
    ok: false,
    coordOrderUsed: null,
    scaleDetected: null,
    warnings: [...warnings, msg],
    boxes: [],
  });

  const data = extractJson(rawText);
  if (data === null) return fail('no parseable JSON found in model output');
  const items = findItemArray(data);
  if (items === null) return fail('no array of box objects found in JSON');
  if (items.length === 0) {
    return {
      ok: true,
      coordOrderUsed: null,
      scaleDetected: null,
      warnings: ['model returned zero boxes'],
      boxes: [],
    };
  }

  const rawBoxes = items
    .map((it) => extractRawBox(it, warnings))
    .filter((b): b is RawBox => b !== null);
  if (rawBoxes.length === 0) return fail('no items had usable coordinates');

  // Axis order: key-name hint from the majority of items (models are
  // consistent within one reply).
  const kinds = rawBoxes
    .map((b) => b.keyKind)
    .filter((k): k is 'yx' | 'xy' => k !== null);
  const yxCount = kinds.filter((k) => k === 'yx').length;
  const coordOrderUsed: 'yx' | 'xy' =
    yxCount >= kinds.length - yxCount ? 'yx' : 'xy';

  // Scale: decided over the whole result set, not per box.
  const allVals = rawBoxes.flatMap((b) => b.coords);
  const maxVal = Math.max(...allVals);
  let scaleDetected: ParseResult['scaleDetected'];
  let toThousand: (v: number, axis: 'x' | 'y') => number;
  if (maxVal <= 1.0 && allVals.some((v) => !Number.isInteger(v))) {
    scaleDetected = '0-1';
    toThousand = (v) => v * 1000;
  } else if (maxVal <= 1000) {
    scaleDetected = '0-1000';
    toThousand = (v) => v;
  } else {
    scaleDetected = 'pixels';
    toThousand = (v, axis) =>
      axis === 'x' ? (v / imageWidth) * 1000 : (v / imageHeight) * 1000;
  }

  const boxes: NormalizedBox[] = [];
  for (const rb of rawBoxes) {
    const [a, b, c, d] = rb.coords;
    let ymin: number;
    let xmin: number;
    let ymax: number;
    let xmax: number;
    if (coordOrderUsed === 'yx') {
      ymin = a;
      xmin = b;
      ymax = c;
      xmax = d;
    } else {
      xmin = a;
      ymin = b;
      xmax = c;
      ymax = d;
    }
    ymin = toThousand(ymin, 'y');
    ymax = toThousand(ymax, 'y');
    xmin = toThousand(xmin, 'x');
    xmax = toThousand(xmax, 'x');
    if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
    if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
    ymin = Math.max(0, Math.min(1000, ymin));
    ymax = Math.max(0, Math.min(1000, ymax));
    xmin = Math.max(0, Math.min(1000, xmin));
    xmax = Math.max(0, Math.min(1000, xmax));
    const w = (xmax - xmin) / 1000;
    const h = (ymax - ymin) / 1000;
    if (w * h < 1e-5) {
      warnings.push(`dropped near-zero-area box "${rb.label}"`);
      continue;
    }
    boxes.push({ label: rb.label, x: xmin / 1000, y: ymin / 1000, w, h });
  }
  if (boxes.length === 0) return fail('all boxes dropped during sanitization');

  return { ok: true, coordOrderUsed, scaleDetected, warnings, boxes };
}
