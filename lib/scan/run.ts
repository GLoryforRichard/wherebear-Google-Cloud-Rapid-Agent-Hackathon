/**
 * Shared rows-hd orchestration — whataisle's FINAL chosen scanning algorithm
 * (the whataisle-readshelf benchmark champion): row detect → high-resolution
 * band detection at full reasoning → grid name readout with reasoning off →
 * label dedup. Stage-BARRIERED exactly like the champion pipeline: all bands
 * finish before any readout starts, and grid chunks are formed over the
 * globally-sorted deduped box list.
 *
 * Consumed by BOTH the /compare paradigms (lib/compare/run-whataisle.ts) and
 * the production shelf intake (lib/scan/intake.ts). This file only hosts
 * orchestration — prompts, resolutions, reasoning config, timeouts, and
 * retry policy live in the algorithm files and stay byte-identical to the
 * benchmark champion.
 *
 * Latency work here is restricted to changes that CANNOT shift model-output
 * distributions (lesson from the reverted 2dc0013 round, where hedged
 * "first-response-wins" racing and per-band chunking cost real accuracy):
 *  - decode the full-res photo to raw pixels ONCE and extract every band
 *    slice / grid cell / thumbnail from it (identical pixels, pure CPU);
 *  - share image prep + raw decode + the row-detect RESULT across callers /
 *    prewarm requests by content hash (same single call, made earlier —
 *    never raced, never duplicated);
 *  - full fan-out concurrency (bounded by the caller's provider gates).
 * NO hedging, NO tightened timeouts, NO streaming — model calls run exactly
 * once (plus the champion's own failure retries) with stock 120s windows.
 */

import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  type RowBandsResult,
  ScanFailedError,
  detectBoxes,
  detectRowBands,
} from './detect';
import { cropRect } from './grid';
import { type PreparedScanImages, prepareScanImages } from './image';
import { applyReadoutNames, extractEntries } from './names';
import { type RawImage, decodeRaw, extractFromRaw } from './raw';
import { readProductNames } from './readout';
import type { CallModelFn, CallOutcome } from './transport';
import type { NormalizedBox } from './types';

export interface ScanEntry {
  name: string;
  /** Distinct spots this product was seen at on the shelf. */
  count: number;
  /** Largest box, wire format [ymin, xmin, ymax, xmax] on 0–1000. */
  box_2d: [number, number, number, number];
  /** Every box for this product. */
  boxes_2d: [number, number, number, number][];
  /** 240px q80 JPEG data URL cropped from the full-res photo. */
  thumbnail?: string;
}

export interface RowsHdConfig {
  callModel: CallModelFn;
  modelId: string;
  bandConcurrency: number;
  gridConcurrency: number;
  /** Rows-cache namespace + log prefix, e.g. 'whataisle-vertex', 'vision-intake'. */
  tag: string;
  /** Progress hook for the async job queue — observation only, fired at the
   *  existing stage boundaries. Never alters model inputs. */
  onStage?: (stage: 'rows' | 'detect' | 'readout' | 'post') => void;
}

export interface RowsHdRunResult {
  entries: ScanEntry[];
  /** Every call attempt, for usage metering. */
  outcomes: CallOutcome[];
  /** Per-stage wall times (ms): prep, rows, detect, readout, post. */
  stages: Record<string, number>;
}

/** Concurrent callers (e.g. compare's B and C) receive the SAME upload as
 *  separate requests; share one image prep + raw decode by content hash
 *  (5-min TTL, failures evicted). The two promises are separate so callers
 *  can start the row-detect model call as soon as `images` lands while the
 *  raw decode still runs underneath it. */
interface SharedPrep {
  images: Promise<PreparedScanImages>;
  /** undefined = raw decode failed; pipelines fall back to JPEG crops. */
  raw: Promise<RawImage | undefined>;
}

const prepCache = new Map<string, SharedPrep>();

/** A raw buffer is ~3 bytes/pixel — 73MB for a 24MP iPhone shot — and the
 *  compare page prewarms on EVERY file selection. Cap the cache at the 2
 *  most recent photos so a browse-several-photos session can't pin hundreds
 *  of MB on the 4GB VM. (Map preserves insertion order → first key = oldest.) */
const PREP_CACHE_MAX = 2;

function prepareShared(imageBuffer: Buffer): SharedPrep {
  const key = createHash('sha1').update(imageBuffer).digest('hex');
  let pending = prepCache.get(key);
  if (!pending) {
    const images = prepareScanImages(imageBuffer);
    // Raw decode can fail under memory pressure — degrade to the per-crop
    // JPEG-decode path (detect/readout treat raw as optional) instead of
    // failing the whole run.
    const raw = images.then((i) => decodeRaw(i.full)).catch((err) => {
      console.warn('[scan] raw decode failed, falling back to JPEG crops:', err);
      return undefined;
    });
    pending = { images, raw };
    prepCache.set(key, pending);
    images.catch(() => prepCache.delete(key));
    for (const k of prepCache.keys()) {
      if (prepCache.size <= PREP_CACHE_MAX) break;
      prepCache.delete(k);
    }
    setTimeout(() => prepCache.delete(key), 5 * 60_000).unref();
  }
  return pending;
}

/** Row-detect results shared between prewarm and the actual run. The rows
 *  call sits alone on the critical path — prewarming it at file-select time
 *  removes ~5-15s from every run. It is the IDENTICAL single call (same
 *  image, same prompt, no racing, no duplicate): the run consumes whatever
 *  this one call returns, exactly as if it had made the call itself. */
const rowsCache = new Map<string, Promise<RowBandsResult>>();

function rowsShared(
  cacheKey: string,
  thunk: () => Promise<RowBandsResult>
): Promise<RowBandsResult> {
  let pending = rowsCache.get(cacheKey);
  if (!pending) {
    pending = thunk();
    rowsCache.set(cacheKey, pending);
    pending.catch(() => rowsCache.delete(cacheKey));
    for (const k of rowsCache.keys()) {
      if (rowsCache.size <= 8) break;
      rowsCache.delete(k);
    }
    setTimeout(() => rowsCache.delete(cacheKey), 3 * 60_000).unref();
  }
  return pending;
}

/** Consume-once handoff from prewarm to run: the first Run uses the
 *  prewarmed draw, then the entry is dropped so a REPEAT Run of the same
 *  photo makes a fresh row-detect call — matching the baseline's fresh
 *  draw per run instead of pinning one (possibly unlucky) banding for the
 *  whole TTL. */
function consumeRows(cacheKey: string): void {
  rowsCache.delete(cacheKey);
}

/** Warm the caches before a run: image prep + raw decode complete, and each
 *  target's row-detect call is already in flight when the run arrives. */
export async function prewarmRowsHd(
  imageBuffer: Buffer,
  targets: Array<Pick<RowsHdConfig, 'callModel' | 'modelId' | 'tag'>>
): Promise<void> {
  const key = createHash('sha1').update(imageBuffer).digest('hex');
  const prep = prepareShared(imageBuffer);
  const images = await prep.images;
  for (const t of targets) {
    rowsShared(`${t.tag}:${key}`, () =>
      detectRowBands(t.callModel, t.modelId, images.processed)
    ).catch(() => {});
  }
  await prep.raw;
}

/** Crop a box (with context padding) to a 240px JPEG data URL. */
async function makeThumbnail(
  raw: RawImage | undefined,
  full: { jpeg: Buffer; width: number; height: number },
  box: NormalizedBox
): Promise<string | undefined> {
  try {
    const rect = cropRect(box, full.width, full.height);
    const source = raw ? extractFromRaw(raw, rect) : sharp(full.jpeg).extract(rect);
    const buf = await source
      .resize(240, 240, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch (err) {
    console.warn('[scan] thumbnail crop failed:', err);
    return undefined;
  }
}

/** Fractional box → wire-format [ymin, xmin, ymax, xmax] on 0–1000. */
function toBox2d(b: NormalizedBox): [number, number, number, number] {
  return [
    Math.round(b.y * 1000),
    Math.round(b.x * 1000),
    Math.round((b.y + b.h) * 1000),
    Math.round((b.x + b.w) * 1000),
  ];
}

export async function runRowsHd(
  imageBuffer: Buffer,
  cfg: RowsHdConfig
): Promise<RowsHdRunResult> {
  const t0 = Date.now();
  const stages: Record<string, number> = {};
  const allOutcomes: CallOutcome[] = [];

  const imageKey = createHash('sha1').update(imageBuffer).digest('hex');
  const prep = prepareShared(imageBuffer);
  const images = await prep.images;
  stages.prep = Date.now() - t0;

  // Stage 0: shelf rows → gap-free bands (degrades to one band on failure).
  // Possibly already resolved: a prewarm may have fired this identical call
  // earlier. The raw pixel decode is pure CPU and runs UNDER the row-detect
  // network call instead of after it.
  const tRows = Date.now();
  cfg.onStage?.('rows');
  const rowsKey = `${cfg.tag}:${imageKey}`;
  const rows = await rowsShared(rowsKey, () =>
    detectRowBands(cfg.callModel, cfg.modelId, images.processed)
  );
  consumeRows(rowsKey);
  const raw = await prep.raw;
  stages.rows = Date.now() - tRows;
  if (rows.outcome) allOutcomes.push(rows.outcome);
  if (rows.warning) console.warn(`[scan] ${cfg.tag}: ${rows.warning}`);

  // Stage 1: rows-hd band detection at full reasoning (the reasoning is the
  // source of correct product grouping — do not lower it here).
  const tDet = Date.now();
  cfg.onStage?.('detect');
  let det: Awaited<ReturnType<typeof detectBoxes>>;
  try {
    det = await detectBoxes(cfg.callModel, cfg.modelId, images.full, rows.bands, {
      bandConcurrency: cfg.bandConcurrency,
      raw,
    });
  } catch (err) {
    // Carry the FULL outcome set (rows + the failed bands') so the caller
    // can meter a failed run honestly.
    if (err instanceof ScanFailedError) {
      throw new ScanFailedError(err.message, [...allOutcomes, ...err.outcomes]);
    }
    throw err;
  }
  allOutcomes.push(...det.outcomes);
  stages.detect = Date.now() - tDet;

  // Stage 2: grid readout fixes copy-paste mislabels from band detection.
  // Barrier semantics preserved: chunks are formed over the full deduped,
  // reading-order-sorted box list, exactly like the champion pipeline.
  const tRead = Date.now();
  cfg.onStage?.('readout');
  const readout = await readProductNames(
    cfg.callModel,
    cfg.modelId,
    images.full,
    det.boxes,
    { gridConcurrency: cfg.gridConcurrency, raw }
  );
  allOutcomes.push(...readout.outcomes);
  stages.readout = Date.now() - tRead;
  if (readout.fallbackChunks > 0) {
    console.warn(
      `[scan] ${cfg.tag}: ${readout.fallbackChunks} grid chunk(s) fell back to per-crop readout`
    );
  }

  // Stage 3: names + within-photo dedup → uniform entries.
  const tPost = Date.now();
  cfg.onStage?.('post');
  const labeled = applyReadoutNames(det.boxes, readout.names);
  const rawEntries = extractEntries(labeled);
  const entries: ScanEntry[] = await Promise.all(
    rawEntries.map(async (e) => {
      const largest = e.boxIndices.reduce((best, i) =>
        labeled[i].w * labeled[i].h > labeled[best].w * labeled[best].h ? i : best
      );
      return {
        name: e.name,
        count: e.count,
        box_2d: toBox2d(labeled[largest]),
        boxes_2d: e.boxIndices.map((i) => toBox2d(labeled[i])),
        thumbnail: await makeThumbnail(raw, images.full, labeled[largest]),
      };
    })
  );
  stages.post = Date.now() - tPost;

  return { entries, outcomes: allOutcomes, stages };
}
