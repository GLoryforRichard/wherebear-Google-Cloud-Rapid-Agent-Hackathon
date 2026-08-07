/**
 * Production shelf-scan intake — the rows-hd pipeline (lib/scan/run.ts) on
 * Vertex AI (the free-trial-credit project), feeding /api/vision.
 *
 * Replaces the original two-stage detect→crop→identify pipeline
 * (lib/gemini.ts detectAndIdentifyProducts, which lives on as /compare
 * paradigm A): on the benchmark shelf photo rows-hd finds ~76 products
 * where the two-stage pipeline found ~24.
 */

import pLimit from 'p-limit';
import type { DetectedProduct } from '@/lib/gemini';
import type { UsageTotals } from '@/lib/cost';
import { type CallOutcome, callModelVertex, sumTokens } from './transport';
import { runRowsHd } from './run';

/** Same Vertex/AI-Studio serving note as VISION_MODEL: env-overridable so
 *  the intake model can be switched without a code change. */
export const SCAN_MODEL = process.env.GEMINI_SCAN_MODEL || 'gemini-3.6-flash';

// Champion fan-out per photo. Serialization happens at the intake level
// (below) so the process-wide Vertex gate (GEMINI_MAX_CONCURRENT, prod 14)
// is never oversubscribed: peak demand = max(8 bands, 6 grids) = 8, leaving
// slots for /compare paradigm A and customer find/voice traffic. The gate
// matters because the transport's per-call abort timer starts BEFORE a gate
// slot is acquired — queueing erodes generation windows and aborts
// legitimately-slow calls (a load-induced accuracy hazard).
const INTAKE_BAND_CONCURRENCY = 8;
const INTAKE_GRID_CONCURRENCY = 6;

/** One shelf photo through the pipeline at a time, process-wide. The queue
 *  client is serial too (pump DETECT_CONCURRENCY=1), but this is the hard
 *  guarantee when two phones scan simultaneously — the second request just
 *  waits (typ. 60-120s, inside the route's 300s budget). */
const intakeLimit = pLimit(1);

/** CallOutcome tokens → the app-wide UsageTotals ledger (lib/cost.ts).
 *  Reasoning tokens bill (and count) as output. One image per call in this
 *  pipeline, so images = call count. storageBytes mirrors the old
 *  pipeline's accounting: actual bytes of the thumbnails we hand onward. */
function usageFromOutcomes(outcomes: CallOutcome[], products: DetectedProduct[]): UsageTotals {
  const t = sumTokens(outcomes);
  return {
    geminiInputTokens: t.prompt,
    geminiOutputTokens: t.completion + t.reasoning,
    geminiImages: outcomes.length,
    voyageEmbedTokens: 0,
    storageBytes: products.reduce((s, p) => {
      if (!p.thumbnail) return s;
      const b64 = p.thumbnail.split(',')[1] ?? '';
      // base64 → bytes ratio is 3/4
      return s + Math.floor(b64.length * 0.75);
    }, 0),
  };
}

/**
 * Detect the products on one shelf photo. Returns the queue/save-path
 * DetectedProduct shape: name + largest box + thumbnail. rows-hd produces
 * no category/confidence — every consumer degrades gracefully without them
 * (Mongo fields are conditionally written, UI subtitles disappear, dedupe
 * falls back to first-wins + thumbnail preference).
 */
export async function runShelfIntake(
  imageBuffer: Buffer
): Promise<{ products: DetectedProduct[]; usage: UsageTotals }> {
  return intakeLimit(async () => {
    const { entries, outcomes } = await runRowsHd(imageBuffer, {
      callModel: callModelVertex,
      modelId: SCAN_MODEL,
      bandConcurrency: INTAKE_BAND_CONCURRENCY,
      gridConcurrency: INTAKE_GRID_CONCURRENCY,
      tag: 'vision-intake',
    });
    const products: DetectedProduct[] = entries.map((e) => ({
      name: e.name,
      box_2d: e.box_2d,
      thumbnail: e.thumbnail,
    }));
    return { products, usage: usageFromOutcomes(outcomes, products) };
  });
}
