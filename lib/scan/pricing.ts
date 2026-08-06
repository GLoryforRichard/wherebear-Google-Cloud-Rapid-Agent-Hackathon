/**
 * Gemini price table for per-call cost estimation.
 *
 * Vertex AI returns no billed-cost field (unlike OpenRouter's usage.cost), so
 * costUsd is ESTIMATED here from token counts. Thinking tokens bill at the
 * output rate. Unknown model → null, preserving cost.ts's sumCost semantics:
 * "unmetered" must stay distinguishable from "genuinely $0".
 *
 * Prices are USD per 1M tokens, verified 2026-08-03 against public pricing
 * pages. If Google changes pricing, override via env instead of redeploying:
 *   SCAN_PRICE_IN_PER_M / SCAN_PRICE_OUT_PER_M (apply to GEMINI_SCAN_MODEL).
 */

interface ModelPrice {
  inPerM: number;
  outPerM: number;
}

const PRICE_TABLE: Record<string, ModelPrice> = {
  'gemini-3.6-flash': { inPerM: 1.5, outPerM: 7.5 },
  'gemini-3.5-flash': { inPerM: 1.5, outPerM: 9.0 },
};

function envPrice(): ModelPrice | null {
  const inPerM = Number(process.env.SCAN_PRICE_IN_PER_M);
  const outPerM = Number(process.env.SCAN_PRICE_OUT_PER_M);
  if (Number.isFinite(inPerM) && inPerM > 0 && Number.isFinite(outPerM) && outPerM > 0) {
    return { inPerM, outPerM };
  }
  return null;
}

export function estimateCostUsd(
  modelId: string,
  tokens: { prompt: number; completion: number; reasoning: number } | null
): number | null {
  if (!tokens) return null;
  const price =
    (modelId === (process.env.GEMINI_SCAN_MODEL || 'gemini-3.6-flash') ? envPrice() : null) ??
    PRICE_TABLE[modelId] ??
    null;
  if (!price) return null;
  const inputUsd = (tokens.prompt / 1_000_000) * price.inPerM;
  const outputUsd = ((tokens.completion + tokens.reasoning) / 1_000_000) * price.outPerM;
  return inputUsd + outputUsd;
}
