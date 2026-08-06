import { createHash } from 'node:crypto';
import { type RowBandsResult, ScanFailedError, detectRowBands } from '@/lib/scan/detect';
import { cropRect } from '@/lib/scan/grid';
import { type PreparedScanImages, prepareScanImages } from '@/lib/scan/image';
import { extractEntries } from '@/lib/scan/names';
import { type RawImage, decodeRaw, extractFromRaw } from '@/lib/scan/raw';
import { detectAndReadStreaming } from '@/lib/scan/stream';
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
 * label dedup. Identical algorithm both times; only the transport differs.
 *
 * Latency work (accuracy-neutral by construction — no prompt, resolution,
 * reasoning-effort, or grid-size change; every model input is byte-identical
 * to the champion pipeline):
 *  - prepareScanImages + raw decode are shared across the two paradigms via
 *    a content-hash cache (the page fires B and C with the same photo).
 *  - The full-res image is decoded to raw pixels ONCE; band slices, grid
 *    cells, fallback crops, and thumbnails all extract from it (was: one
 *    full 12MP JPEG decode per crop — tens of CPU-seconds on the VM).
 *  - Raw decode runs concurrently with the row-detect model call.
 *  - Bands and grid chunks fan out fully (≤8 bands, all grid chunks at
 *    once) instead of trickling through a 2-slot pool.
 *  - Tail-latency hedges: identical duplicate call fired only when the
 *    first exceeds the hedge window (Vertex serves identical requests
 *    anywhere from 18s to 150s+; the hedge converts that tail into a
 *    second-chance draw).
 */

interface ParadigmConfig {
  callModel: CallModelFn;
  modelId: string;
  provider: string;
  bandConcurrency: number;
  gridConcurrency: number;
  rowHedgeMs: number;
  bandHedgeMs: number;
  gridHedgeMs: number;
  bandTimeoutMs?: number;
  gridTimeoutMs?: number;
  costBasis: CompareRunResult['costBasis'];
}

const CONFIGS: Record<'whataisle-openrouter' | 'whataisle-vertex', ParadigmConfig> = {
  'whataisle-openrouter': {
    callModel: callModelOpenRouter,
    modelId: OPENROUTER_COMPARE_MODEL,
    provider: 'OpenRouter',
    bandConcurrency: 8,
    gridConcurrency: 16,
    // OpenRouter's tail is milder and its cost is real billed dollars —
    // hedge at ~p75 so duplicates stay the exception.
    rowHedgeMs: 7_000,
    bandHedgeMs: 20_000,
    gridHedgeMs: 9_000,
    costBasis: 'openrouter-actual',
  },
  'whataisle-vertex': {
    callModel: callModelVertex,
    modelId: COMPARE_MODEL,
    provider: 'Vertex AI (Google Cloud free trial)',
    // Full fan-out; the process-wide Vertex gate (GEMINI_MAX_CONCURRENT) is
    // the actual in-flight ceiling and the 429-retry loop absorbs bursts.
    bandConcurrency: 8,
    gridConcurrency: 16,
    // Vertex serves identical requests anywhere from 1s to 150s+. Hedge
    // TAIL-ONLY: median-level hedging doubled the in-flight count, tripped
    // DSQ 429s and made runs SLOWER (72s vs 53s) — this project's quota,
    // not the latency tail, is the binding constraint. Band body is 15-20s,
    // so 25s only rescues genuine stragglers; grids body 4-7s → 10s.
    // Rows fires while the gate is empty (prewarm, before any other call),
    // so an aggressive 3s hedge is free contention-wise; min-of-two draws
    // pull the 8-15s rows body down to ~5-7s on the critical path.
    rowHedgeMs: 3_000,
    // Uncontended band calls run 9-19s; under 7-way fan-out DSQ shares the
    // project's token throughput and each call stretches to 15-25s. A hedge
    // duplicate STEALS that shared throughput, so 30s fires only on genuine
    // transport stalls, not on throughput-stretched calls.
    bandHedgeMs: 30_000,
    gridHedgeMs: 10_000,
    // Clean Vertex latencies: bands 15-20s, grids 2-3s. Tight timeouts turn
    // the pathological stragglers (an 87s grid call was observed while its
    // 10s hedge was ALSO stuck in 429 backoff) into abort + fresh retry.
    bandTimeoutMs: 60_000,
    gridTimeoutMs: 25_000,
    costBasis: 'list-price-estimate',
  },
};

/** B and C receive the SAME upload as separate requests; share one image
 *  prep + raw decode by content hash (5-min TTL, failures evicted). The two
 *  promises are separate so callers can start the row-detect model call as
 *  soon as `images` lands while the raw decode still runs underneath it. */
interface SharedPrep {
  images: Promise<PreparedScanImages>;
  raw: Promise<RawImage>;
}

const prepCache = new Map<string, SharedPrep>();

function prepareShared(imageBuffer: Buffer): SharedPrep {
  const key = createHash('sha1').update(imageBuffer).digest('hex');
  let pending = prepCache.get(key);
  if (!pending) {
    const images = prepareScanImages(imageBuffer);
    const raw = images.then((i) => decodeRaw(i.full));
    pending = { images, raw };
    prepCache.set(key, pending);
    raw.catch(() => prepCache.delete(key));
    setTimeout(() => prepCache.delete(key), 5 * 60_000).unref();
  }
  return pending;
}

/** Row-detect results shared between prewarm and the actual run (and across
 *  the two paradigms' identical-input calls on their own transports). The
 *  rows call sits alone on the critical path — prewarming it at file-select
 *  time removes ~5-14s from every run. Same inputs, same call, just earlier. */
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
    setTimeout(() => rowsCache.delete(cacheKey), 3 * 60_000).unref();
  }
  return pending;
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
      detectRowBands(cfg.callModel, cfg.modelId, images.processed, cfg.rowHedgeMs)
    ).catch(() => {});
  }
  await prep.raw;
}

/** Crop a box (with context padding) to a 240px JPEG data URL. */
async function makeThumbnail(
  raw: RawImage,
  box: NormalizedBox
): Promise<string | undefined> {
  try {
    const rect = cropRect(box, raw.width, raw.height);
    const buf = await extractFromRaw(raw, rect)
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
  const rows = await rowsShared(`${paradigm}:${imageKey}`, () =>
    detectRowBands(cfg.callModel, cfg.modelId, images.processed, cfg.rowHedgeMs)
  );
  const raw = await prep.raw;
  stages.rows = Date.now() - tRows;
  if (rows.outcome) allOutcomes.push(rows.outcome);
  if (rows.warning) console.warn(`[compare] ${paradigm}: ${rows.warning}`);

  // Stages 1+2 interleaved: band detection at full reasoning (the reasoning
  // is the source of correct product grouping — do not lower it), with each
  // band's grid readout starting the moment that band parses instead of
  // behind an all-bands barrier.
  const tScan = Date.now();
  let scan: Awaited<ReturnType<typeof detectAndReadStreaming>>;
  try {
    scan = await detectAndReadStreaming(cfg.callModel, cfg.modelId, images.full, rows.bands, {
      bandConcurrency: cfg.bandConcurrency,
      gridConcurrency: cfg.gridConcurrency,
      bandHedgeMs: cfg.bandHedgeMs,
      gridHedgeMs: cfg.gridHedgeMs,
      bandTimeoutMs: cfg.bandTimeoutMs,
      gridTimeoutMs: cfg.gridTimeoutMs,
      raw,
    });
  } catch (err) {
    if (err instanceof ScanFailedError) allOutcomes.push(...err.outcomes);
    throw err;
  }
  allOutcomes.push(...scan.outcomes);
  stages.scan = Date.now() - tScan;
  if (scan.fallbackChunks > 0) {
    console.warn(
      `[compare] ${paradigm}: ${scan.fallbackChunks} grid chunk(s) fell back to per-crop readout`
    );
  }

  // Stage 3: within-photo dedup → uniform compare products (boxes already
  // carry their read names).
  const tPost = Date.now();
  const labeled = scan.boxes;
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
        thumbnail: await makeThumbnail(raw, labeled[largest]),
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
