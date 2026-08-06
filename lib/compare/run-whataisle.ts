import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  type RowBandsResult,
  ScanFailedError,
  detectBoxes,
  detectRowBands,
} from '@/lib/scan/detect';
import { cropRect } from '@/lib/scan/grid';
import { type PreparedScanImages, prepareScanImages } from '@/lib/scan/image';
import { applyReadoutNames, extractEntries } from '@/lib/scan/names';
import { type RawImage, decodeRaw, extractFromRaw } from '@/lib/scan/raw';
import { readProductNames } from '@/lib/scan/readout';
import {
  type CallModelFn,
  type CallOutcome,
  callModelOpenRouter,
  callModelVertex,
  sumCost,
  sumTokens,
} from '@/lib/scan/transport';
import type { NormalizedBox } from '@/lib/scan/types';
import {
  COMPARE_MODEL,
  OPENROUTER_COMPARE_MODEL,
  type CompareProduct,
  type CompareRunResult,
} from '@/lib/compare/types';

/**
 * Paradigms B & C — whataisle's FINAL chosen scanning algorithm ("rows-hd",
 * the whataisle-readshelf benchmark champion): row detect → high-resolution
 * band detection at full reasoning → grid name readout with reasoning off →
 * label dedup. Stage-BARRIERED exactly like the champion pipeline: all bands
 * finish before any readout starts, and grid chunks are formed over the
 * globally-sorted deduped box list.
 *
 * Latency work here is restricted to changes that CANNOT shift model-output
 * distributions (lesson from the reverted 2dc0013 round, where hedged
 * "first-response-wins" racing and per-band chunking cost real accuracy):
 *  - decode the full-res photo to raw pixels ONCE and extract every band
 *    slice / grid cell / thumbnail from it (identical pixels, pure CPU);
 *  - share image prep + raw decode + the row-detect RESULT across the two
 *    paradigms / prewarm requests by content hash (same single call, made
 *    earlier — never raced, never duplicated);
 *  - full fan-out concurrency (all bands at once, all grid chunks at once,
 *    bounded by the provider gates).
 * NO hedging, NO tightened timeouts, NO streaming — model calls run exactly
 * once (plus the champion's own failure retries) with stock 120s windows.
 */

interface ParadigmConfig {
  callModel: CallModelFn;
  modelId: string;
  provider: string;
  bandConcurrency: number;
  gridConcurrency: number;
  costBasis: CompareRunResult['costBasis'];
}

const CONFIGS: Record<'whataisle-openrouter' | 'whataisle-vertex', ParadigmConfig> = {
  'whataisle-openrouter': {
    callModel: callModelOpenRouter,
    modelId: OPENROUTER_COMPARE_MODEL,
    provider: 'OpenRouter',
    // MAX_BANDS is 8, so 8 = every band in flight at once; grid chunks all
    // fan out under OpenRouter's process-wide 32-slot pool (pool ≥ fan-out,
    // so the per-call abort timer never ticks in a queue).
    bandConcurrency: 8,
    gridConcurrency: 16,
    costBasis: 'openrouter-actual',
  },
  'whataisle-vertex': {
    callModel: callModelVertex,
    modelId: COMPARE_MODEL,
    provider: 'Vertex AI (Google Cloud free trial)',
    // Sized to NEVER oversubscribe the process-wide Vertex gate
    // (GEMINI_MAX_CONCURRENT, prod 14) even with paradigm A's ~4 calls
    // sharing it: the per-call 120s abort timer starts BEFORE the gate slot
    // is acquired, so queueing would erode the generation window and abort
    // legitimately-slow calls — a load-induced version of the tightened-
    // timeout selection bias that degraded accuracy in the reverted round.
    // Bands run first (8+4 ≤ 14); grids start only after the barrier, when
    // band slots are free (6+4 ≤ 14).
    bandConcurrency: 8,
    gridConcurrency: 6,
    costBasis: 'list-price-estimate',
  },
};

/** B and C receive the SAME upload as separate requests; share one image
 *  prep + raw decode by content hash (5-min TTL, failures evicted). The two
 *  promises are separate so callers can start the row-detect model call as
 *  soon as `images` lands while the raw decode still runs underneath it. */
interface SharedPrep {
  images: Promise<PreparedScanImages>;
  /** undefined = raw decode failed; pipelines fall back to JPEG crops. */
  raw: Promise<RawImage | undefined>;
}

const prepCache = new Map<string, SharedPrep>();

/** A raw buffer is ~3 bytes/pixel — 73MB for a 24MP iPhone shot — and the
 *  page prewarms on EVERY file selection. Cap the cache at the 2 most
 *  recent photos so a browse-several-photos session can't pin hundreds of
 *  MB on the 4GB VM. (Map preserves insertion order → first key = oldest.) */
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
      console.warn('[compare] raw decode failed, falling back to JPEG crops:', err);
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

/** Warm the caches before the user hits Run: the client calls this the
 *  moment a file is picked. HEIC conversion + resize + raw decode complete,
 *  and both paradigms' row-detect calls are already in flight when the
 *  paradigm requests arrive. */
export async function prewarmScan(imageBuffer: Buffer): Promise<void> {
  const key = createHash('sha1').update(imageBuffer).digest('hex');
  const prep = prepareShared(imageBuffer);
  const images = await prep.images;
  for (const paradigm of ['whataisle-openrouter', 'whataisle-vertex'] as const) {
    const cfg = CONFIGS[paradigm];
    rowsShared(`${paradigm}:${key}`, () =>
      detectRowBands(cfg.callModel, cfg.modelId, images.processed)
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
    console.warn('[compare] thumbnail crop failed:', err);
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

export async function runWhatAisleParadigm(
  imageBuffer: Buffer,
  _mimeType: string,
  paradigm: 'whataisle-openrouter' | 'whataisle-vertex'
): Promise<CompareRunResult> {
  const cfg = CONFIGS[paradigm];
  const t0 = Date.now();
  const stages: Record<string, number> = {};
  const allOutcomes: CallOutcome[] = [];

  const imageKey = createHash('sha1').update(imageBuffer).digest('hex');
  const prep = prepareShared(imageBuffer);
  const images = await prep.images;
  stages.prep = Date.now() - t0;

  // Stage 0: shelf rows → gap-free bands (degrades to one band on failure).
  // Usually already resolved: the prewarm fired this identical call at
  // file-select time. The raw pixel decode is pure CPU and runs UNDER the
  // row-detect network call instead of after it.
  const tRows = Date.now();
  const rowsKey = `${paradigm}:${imageKey}`;
  const rows = await rowsShared(rowsKey, () =>
    detectRowBands(cfg.callModel, cfg.modelId, images.processed)
  );
  consumeRows(rowsKey);
  const raw = await prep.raw;
  stages.rows = Date.now() - tRows;
  if (rows.outcome) allOutcomes.push(rows.outcome);
  if (rows.warning) console.warn(`[compare] ${paradigm}: ${rows.warning}`);

  // Stage 1: rows-hd band detection at full reasoning (the reasoning is the
  // source of correct product grouping — do not lower it here).
  const tDet = Date.now();
  let det: Awaited<ReturnType<typeof detectBoxes>>;
  try {
    det = await detectBoxes(cfg.callModel, cfg.modelId, images.full, rows.bands, {
      bandConcurrency: cfg.bandConcurrency,
      raw,
    });
  } catch (err) {
    if (err instanceof ScanFailedError) allOutcomes.push(...err.outcomes);
    throw err;
  }
  allOutcomes.push(...det.outcomes);
  stages.detect = Date.now() - tDet;

  // Stage 2: grid readout fixes copy-paste mislabels from band detection.
  // Barrier semantics preserved: chunks are formed over the full deduped,
  // reading-order-sorted box list, exactly like the champion pipeline.
  const tRead = Date.now();
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
      `[compare] ${paradigm}: ${readout.fallbackChunks} grid chunk(s) fell back to per-crop readout`
    );
  }

  // Stage 3: names + within-photo dedup → uniform compare products.
  const tPost = Date.now();
  const labeled = applyReadoutNames(det.boxes, readout.names);
  const entries = extractEntries(labeled);
  const products: CompareProduct[] = await Promise.all(
    entries.map(async (e) => {
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

  const elapsedMs = Date.now() - t0;
  const tokens = sumTokens(allOutcomes);
  return {
    ok: true,
    paradigm,
    model: cfg.modelId,
    provider: cfg.provider,
    products,
    count: products.length,
    elapsedMs,
    stages,
    usage: {
      inputTokens: tokens.prompt,
      // reasoning tokens bill (and count) as output
      outputTokens: tokens.completion + tokens.reasoning,
      calls: allOutcomes.length,
      images: allOutcomes.length, // one image per call in this pipeline
    },
    costUSD: sumCost(allOutcomes),
    costBasis: cfg.costBasis,
  };
}
