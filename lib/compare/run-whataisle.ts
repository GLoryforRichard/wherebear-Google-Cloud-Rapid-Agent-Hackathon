import sharp from 'sharp';
import { ScanFailedError, detectBoxes, detectRowBands } from '@/lib/scan/detect';
import { cropRect } from '@/lib/scan/grid';
import { prepareScanImages } from '@/lib/scan/image';
import { applyReadoutNames, extractEntries } from '@/lib/scan/names';
import { readProductNames } from '@/lib/scan/readout';
import {
  type CallModelFn,
  type CallOutcome,
  callModelOpenRouter,
  callModelVertex,
  sumCost,
  sumTokens,
} from '@/lib/scan/transport';
import type { NormalizedBox, PreparedImage } from '@/lib/scan/types';
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
 * label dedup. Identical algorithm both times; only the transport differs:
 *
 *  B `whataisle-openrouter` — OpenRouter HTTP API (google/gemini-3.6-flash),
 *    whataisle's original production transport and concurrency (band 6 /
 *    grid 6). Cost is OpenRouter's actual billed usage.cost.
 *  C `whataisle-vertex`     — Vertex AI on the Google Cloud free-trial
 *    project (gemini-3.6-flash), whataisle-store's transport with its
 *    DSQ-safe concurrency (band 2 / grid 2 behind the 4-slot gate). Cost is
 *    estimated from the list-price table.
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
    bandConcurrency: 6,
    gridConcurrency: 6,
    costBasis: 'openrouter-actual',
  },
  'whataisle-vertex': {
    callModel: callModelVertex,
    modelId: COMPARE_MODEL,
    provider: 'Vertex AI (Google Cloud free trial)',
    bandConcurrency: 2,
    gridConcurrency: 2,
    costBasis: 'list-price-estimate',
  },
};

/** Crop a box (with context padding) to a 240px JPEG data URL. */
async function makeThumbnail(
  source: PreparedImage,
  box: NormalizedBox
): Promise<string | undefined> {
  try {
    const rect = cropRect(box, source.width, source.height);
    const buf = await sharp(source.jpeg)
      .extract(rect)
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
  const allOutcomes: CallOutcome[] = [];

  const images = await prepareScanImages(imageBuffer);

  // Stage 0: shelf rows → gap-free bands (degrades to one band on failure).
  const rows = await detectRowBands(cfg.callModel, cfg.modelId, images.processed);
  if (rows.outcome) allOutcomes.push(rows.outcome);
  if (rows.warning) console.warn(`[compare] ${paradigm}: ${rows.warning}`);

  // Stage 1: rows-hd band detection at full reasoning (the reasoning is the
  // source of correct product grouping — do not lower it here).
  let det: Awaited<ReturnType<typeof detectBoxes>>;
  try {
    det = await detectBoxes(cfg.callModel, cfg.modelId, images.full, rows.bands, {
      bandConcurrency: cfg.bandConcurrency,
    });
  } catch (err) {
    if (err instanceof ScanFailedError) allOutcomes.push(...err.outcomes);
    throw err;
  }
  allOutcomes.push(...det.outcomes);

  // Stage 2: grid readout fixes copy-paste mislabels from band detection.
  const readout = await readProductNames(
    cfg.callModel,
    cfg.modelId,
    images.full,
    det.boxes,
    { gridConcurrency: cfg.gridConcurrency }
  );
  allOutcomes.push(...readout.outcomes);
  if (readout.fallbackChunks > 0) {
    console.warn(
      `[compare] ${paradigm}: ${readout.fallbackChunks} grid chunk(s) fell back to per-crop readout`
    );
  }

  // Stage 3: names + within-photo dedup → uniform compare products.
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
        thumbnail: await makeThumbnail(images.full, labeled[largest]),
      };
    })
  );

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
