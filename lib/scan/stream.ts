/**
 * Streaming detect+readout for the rows-hd pipeline.
 *
 * The stock orchestration is stage-barriered: ALL bands must finish before
 * ANY grid readout starts, so wall time = rows + max(band) + readout. On
 * Vertex (band body 15-20s, grid ~5s) that sums to 35-45s. This module
 * interleaves them: as soon as ONE band's boxes parse, its grid readout
 * starts while other bands are still detecting. Wall time collapses to
 * rows + max(band + its own readout).
 *
 * Accuracy posture (the hard constraint):
 * - Band calls: byte-identical inputs (same slices, prompt, schema, full
 *   reasoning).
 * - Readout calls: identical crop rects, prompt, schema, K=6, reasoning off.
 *   The ONLY difference is grid-cell GROUPING: chunks are formed per band
 *   (reading order within the band) instead of over the globally-sorted
 *   deduped list. The grid prompt treats cells as strictly unrelated, so
 *   neighbor identity is not load-bearing — and readout now covers the few
 *   overlap-margin duplicate boxes that global dedup would have dropped
 *   (extra cost, not less coverage).
 * - Cross-band dedup: the EXACT champion `mergeBandBoxes` (ownership by
 *   core, area-sorted greedy IoU, reading-order sort) still runs at the
 *   end, over boxes that already carry their read names.
 */

import pLimit from 'p-limit';
import sharp from 'sharp';
import { mapBandBox, mergeBandBoxes } from './bands';
import { MAX_BAND_SIDE, ScanFailedError } from './detect';
import { parseBoxes } from './box-parser';
import { cropRect } from './grid';
import { BAND_PROMPT, BOX_SCHEMA } from './prompts';
import { type RawImage, extractFromRaw } from './raw';
import { readProductNames } from './readout';
import type { CallModelFn, CallOutcome } from './transport';
import type { Band, NormalizedBox, PreparedImage } from './types';

export interface StreamScanOptions {
  bandConcurrency?: number;
  gridConcurrency?: number;
  bandHedgeMs?: number;
  gridHedgeMs?: number;
  /** Tight per-call timeouts turn pathological stragglers into abort+retry
   *  (fresh calls usually land at body latency). Defaults keep the stock
   *  120s ceilings. */
  bandTimeoutMs?: number;
  gridTimeoutMs?: number;
  gridK?: number;
  raw?: RawImage;
}

export interface StreamScanResult {
  /** Final deduped boxes in reading order, labels already overridden by
   *  the grid readout (null reads keep the detection label). */
  boxes: NormalizedBox[];
  outcomes: CallOutcome[];
  warnings: string[];
  fallbackChunks: number;
  /** Wall time of the whole interleaved detect+readout block. */
  latencyMs: number;
}

export async function detectAndReadStreaming(
  callModel: CallModelFn,
  modelId: string,
  full: PreparedImage,
  bands: Band[],
  opts: StreamScanOptions = {}
): Promise<StreamScanResult> {
  const started = performance.now();
  const bandLimit = pLimit(Math.max(1, opts.bandConcurrency ?? 8));
  // One shared grid pool across all bands, so early bands' readouts flow
  // while later bands still detect, without ever bursting past the cap.
  const gridConcurrency = Math.max(1, opts.gridConcurrency ?? 8);
  const outcomes: CallOutcome[] = [];
  const warnings: string[] = [];
  let fallbackChunks = 0;

  const slices = await Promise.all(
    bands.map(async (b) => {
      const top = Math.round(b.y0 * full.height);
      const height = Math.max(1, Math.round((b.y1 - b.y0) * full.height));
      const rect = {
        left: 0,
        top: Math.min(top, full.height - 1),
        width: full.width,
        height: Math.min(height, full.height - top),
      };
      const source = opts.raw ? extractFromRaw(opts.raw, rect) : sharp(full.jpeg).extract(rect);
      const buf = await source
        .resize(MAX_BAND_SIDE, MAX_BAND_SIDE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      const meta = await sharp(buf).metadata();
      return { buf, width: meta.width ?? full.width, height: meta.height ?? height };
    })
  );

  /** Detect one band (2 attempts), then immediately read names for its
   *  owned boxes. Returns the band's labeled boxes (pre cross-band dedup). */
  const runBand = async (
    slice: (typeof slices)[number],
    bandIndex: number
  ): Promise<NormalizedBox[] | null> => {
    const attempts: CallOutcome[] = [];
    let parsed: ReturnType<typeof parseBoxes> | null = null;
    for (let n = 0; n < 2 && !parsed; n++) {
      if (n > 0) await new Promise((r) => setTimeout(r, 2000));
      const o = await callModel({
        modelId,
        imageJpeg: slice.buf,
        prompt: BAND_PROMPT,
        schema: BOX_SCHEMA,
        schemaName: 'shelf_product_boxes',
        timeoutMs: opts.bandTimeoutMs ?? 120_000,
        hedgeAfterMs: opts.bandHedgeMs,
      });
      attempts.push(o);
      outcomes.push(o);
      if (!o.ok) continue;
      const p = parseBoxes(o.rawText ?? '', slice.width, slice.height);
      if (p.ok) parsed = p;
    }
    if (!parsed) return null;
    warnings.push(...parsed.warnings.map((w) => `band${bandIndex}: ${w}`));
    if (attempts.length > 1) {
      warnings.push(
        `band${bandIndex}: first attempt failed, retry succeeded (${attempts[0].error ?? 'parse failure'})`
      );
    }

    // Ownership filter (same predicate mergeBandBoxes applies): keeps this
    // band's own boxes, drops overlap-margin duplicates owned by neighbors.
    const band = bands[bandIndex];
    const mapped = parsed.boxes.map((b) => mapBandBox(b, band));
    const owned = mapped.filter((box) => {
      const cy = box.y + box.h / 2;
      const owner = bands.findIndex(
        (bb, i) => cy >= bb.core0 && (cy < bb.core1 || i === bands.length - 1)
      );
      return owner === bandIndex || owner === -1;
    });
    if (owned.length === 0) return [];

    // Immediate readout for this band's boxes — identical rects/prompt/K,
    // chunked in the band's reading order.
    owned.sort((a, b) => a.y - b.y || a.x - b.x);
    const readout = await readProductNames(callModel, modelId, full, owned, {
      gridConcurrency,
      gridHedgeMs: opts.gridHedgeMs,
      gridTimeoutMs: opts.gridTimeoutMs,
      gridK: opts.gridK,
      raw: opts.raw,
    });
    outcomes.push(...readout.outcomes);
    fallbackChunks += readout.fallbackChunks;
    return owned.map((box, i) => {
      const n = readout.names[i];
      return n ? { ...box, label: n } : box;
    });
  };

  const perBand = await Promise.all(
    slices.map((s, i) => bandLimit(() => runBand(s, i)))
  );

  const failed = perBand
    .map((r, i) => (r === null ? `band${i}: failed after retry` : null))
    .filter((x): x is string => x !== null);
  if (failed.length > 0) {
    throw new ScanFailedError(
      `some bands failed after retry (coverage incomplete): ${failed.join('; ')}`,
      outcomes
    );
  }

  // Exact champion cross-band dedup over the labeled boxes. Ownership was
  // already applied per band (idempotent here); this adds the global
  // area-sorted greedy-IoU pass and restores reading order.
  const { boxes, dropped } = mergeBandBoxes(
    perBand.map((b) => b ?? []),
    bands
  );
  if (dropped > 0) warnings.push(`merged: dropped ${dropped} overlap/duplicate boxes`);

  return {
    boxes,
    outcomes,
    warnings,
    fallbackChunks,
    latencyMs: Math.round(performance.now() - started),
  };
}
