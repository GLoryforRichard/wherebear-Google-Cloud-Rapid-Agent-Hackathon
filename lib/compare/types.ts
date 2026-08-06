/**
 * Shared contract for the /compare page: three scanning paradigms run over
 * the same shelf photo and must come back in ONE uniform shape so the UI can
 * lay them out side by side.
 *
 * Paradigms:
 *  A `wherebear`            — wherebear's two-stage pipeline (stage-1 detect →
 *                             sharp crop → stage-2 batch identify → dedupe),
 *                             Vertex AI, model forced to gemini-3.6-flash.
 *  B `whataisle-openrouter` — whataisle's final single-shot pipeline, called
 *                             through OpenRouter (google/gemini-3.6-flash).
 *  C `whataisle-vertex`     — whataisle's same algorithm, but on Google Cloud
 *                             Vertex AI (free-trial credits), gemini-3.6-flash.
 */

export type CompareParadigm = 'wherebear' | 'whataisle-openrouter' | 'whataisle-vertex';

export const COMPARE_MODEL = 'gemini-3.6-flash';
export const OPENROUTER_COMPARE_MODEL = 'google/gemini-3.6-flash';

/** gemini-3.6-flash list price (USD per token). Matches OpenRouter's
 *  passthrough pricing for google/gemini-3.6-flash as of 2026-08. Used to
 *  ESTIMATE Vertex-side cost; OpenRouter reports actual cost per request. */
export const G36_FLASH_PRICE_IN = 1.5 / 1_000_000;
export const G36_FLASH_PRICE_OUT = 7.5 / 1_000_000;

export interface CompareProduct {
  name: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  /** [y_min, x_min, y_max, x_max] normalized 0–1000 (upright image space).
   *  The representative (largest) box for this product. */
  box_2d?: [number, number, number, number];
  /** ALL detected boxes for this product (the whataisle pipeline can find the
   *  same product in several shelf spots). Overlay draws these; falls back to
   *  [box_2d] when absent. */
  boxes_2d?: [number, number, number, number][];
  /** How many separate spots this product was detected in. */
  count?: number;
  /** Small crop data URL when the paradigm produces one. */
  thumbnail?: string;
}

export interface CompareUsage {
  inputTokens: number;
  outputTokens: number;
  /** Number of model API calls made. */
  calls: number;
  /** Number of images sent to the model. */
  images: number;
}

export interface CompareRunResult {
  ok: boolean;
  paradigm: CompareParadigm;
  model: string;
  provider: string;
  products: CompareProduct[];
  count: number;
  /** Server-side wall time for the whole pipeline, ms. */
  elapsedMs: number;
  usage: CompareUsage;
  /** USD. Actual for OpenRouter (from its usage accounting), estimated from
   *  list price for Vertex. Null if unknown. */
  costUSD: number | null;
  costBasis: 'openrouter-actual' | 'list-price-estimate';
  error?: string;
}

export function estimateVertexCost(usage: CompareUsage): number {
  return usage.inputTokens * G36_FLASH_PRICE_IN + usage.outputTokens * G36_FLASH_PRICE_OUT;
}
