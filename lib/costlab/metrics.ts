/**
 * "Same effect as baseline?" scoring: IoU box matching + fuzzy name
 * agreement between one lab run and the baseline reference run. The baseline
 * run twice against itself gives the noise floor (gemini-3.6-flash is not
 * deterministic even at temperature 0 with thinking enabled) — a scheme
 * whose metrics sit at or above the floor is indistinguishable from
 * "running the baseline again".
 */

import type { LabEntry, SchemeMetrics } from './types';

type Wire = [number, number, number, number];

interface FlatBox {
  name: string;
  box: Wire;
  entryIdx: number;
}

function flatten(entries: LabEntry[]): FlatBox[] {
  const out: FlatBox[] = [];
  entries.forEach((e, entryIdx) => {
    const boxes = e.boxes_2d?.length ? e.boxes_2d : [e.box_2d];
    for (const box of boxes) out.push({ name: e.name, box, entryIdx });
  });
  return out;
}

function iou(a: Wire, b: Wire): number {
  const y0 = Math.max(a[0], b[0]);
  const x0 = Math.max(a[1], b[1]);
  const y1 = Math.min(a[2], b[2]);
  const x1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, y1 - y0) * Math.max(0, x1 - x0);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

const STOP = new Set(['the', 'a', 'of', 'de', 'la', 'le', 'et', 'and', 'with', 'in']);

export function nameTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 0 && !STOP.has(t))
  );
}

export function namesAgree(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return ta.size === tb.size;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = inter / union;
  const containment = inter === Math.min(ta.size, tb.size);
  return jaccard >= 0.34 || (containment && inter > 0);
}

const IOU_MATCH = 0.45;

/**
 * Greedy best-first IoU matching between two box sets, then fuzzy name
 * comparison on matched pairs, plus a fuzzy entry-list Jaccard.
 */
export function compareRuns(scheme: LabEntry[], base: LabEntry[]): SchemeMetrics {
  const sBoxes = flatten(scheme);
  const bBoxes = flatten(base);

  const pairs: { s: number; b: number; v: number }[] = [];
  for (let s = 0; s < sBoxes.length; s++) {
    for (let b = 0; b < bBoxes.length; b++) {
      const v = iou(sBoxes[s].box, bBoxes[b].box);
      if (v >= IOU_MATCH) pairs.push({ s, b, v });
    }
  }
  pairs.sort((p, q) => q.v - p.v);
  const usedS = new Set<number>();
  const usedB = new Set<number>();
  let matched = 0;
  let agree = 0;
  for (const { s, b } of pairs) {
    if (usedS.has(s) || usedB.has(b)) continue;
    usedS.add(s);
    usedB.add(b);
    matched++;
    if (namesAgree(sBoxes[s].name, bBoxes[b].name)) agree++;
  }

  // Fuzzy entry-list matching (name-level, ignores geometry)
  const usedSchemeEntry = new Set<number>();
  let entryMatched = 0;
  const missedNames: string[] = [];
  for (const be of base) {
    const hit = scheme.findIndex(
      (se, i) => !usedSchemeEntry.has(i) && namesAgree(se.name, be.name)
    );
    if (hit >= 0) {
      usedSchemeEntry.add(hit);
      entryMatched++;
    } else {
      missedNames.push(be.name);
    }
  }
  const extraNames = scheme
    .filter((_, i) => !usedSchemeEntry.has(i))
    .map((e) => e.name);

  return {
    boxRecall: bBoxes.length ? matched / bBoxes.length : 1,
    boxPrecision: sBoxes.length ? matched / sBoxes.length : 1,
    nameAgreement: matched ? agree / matched : 0,
    entryJaccard:
      scheme.length + base.length - entryMatched > 0
        ? entryMatched / (scheme.length + base.length - entryMatched)
        : 1,
    matchedBoxes: matched,
    baseBoxes: bBoxes.length,
    schemeBoxes: sBoxes.length,
    missedNames: missedNames.slice(0, 12),
    extraNames: extraNames.slice(0, 12),
  };
}
