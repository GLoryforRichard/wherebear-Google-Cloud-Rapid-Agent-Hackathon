import { runRowsHd, prewarmRowsHd } from '@/lib/scan/run';
import {
  type CallModelFn,
  callModelOpenRouter,
  callModelVertex,
  sumCost,
  sumTokens,
} from '@/lib/scan/transport';
import {
  COMPARE_MODEL,
  OPENROUTER_COMPARE_MODEL,
  type CompareRunResult,
} from '@/lib/compare/types';

/**
 * Paradigms B & C — the shared rows-hd pipeline (lib/scan/run.ts) on two
 * transports. Identical algorithm both times; only the transport differs.
 * The orchestration (and its accuracy lessons) lives in lib/scan/run.ts;
 * this file just binds paradigm configs and shapes CompareRunResult.
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

/** Warm the caches before the user hits Run: the client calls this the
 *  moment a file is picked. HEIC conversion + resize + raw decode complete,
 *  and both paradigms' row-detect calls are already in flight when the
 *  paradigm requests arrive. */
export async function prewarmScan(imageBuffer: Buffer): Promise<void> {
  await prewarmRowsHd(
    imageBuffer,
    (['whataisle-openrouter', 'whataisle-vertex'] as const).map((tag) => ({
      callModel: CONFIGS[tag].callModel,
      modelId: CONFIGS[tag].modelId,
      tag,
    }))
  );
}

export async function runWhatAisleParadigm(
  imageBuffer: Buffer,
  _mimeType: string,
  paradigm: 'whataisle-openrouter' | 'whataisle-vertex'
): Promise<CompareRunResult> {
  const cfg = CONFIGS[paradigm];
  const t0 = Date.now();

  const { entries, outcomes, stages } = await runRowsHd(imageBuffer, {
    callModel: cfg.callModel,
    modelId: cfg.modelId,
    bandConcurrency: cfg.bandConcurrency,
    gridConcurrency: cfg.gridConcurrency,
    tag: paradigm,
  });

  const tokens = sumTokens(outcomes);
  return {
    ok: true,
    paradigm,
    model: cfg.modelId,
    provider: cfg.provider,
    products: entries,
    count: entries.length,
    elapsedMs: Date.now() - t0,
    stages,
    usage: {
      inputTokens: tokens.prompt,
      // reasoning tokens bill (and count) as output
      outputTokens: tokens.completion + tokens.reasoning,
      calls: outcomes.length,
      images: outcomes.length, // one image per call in this pipeline
    },
    costUSD: sumCost(outcomes),
    costBasis: cfg.costBasis,
  };
}
