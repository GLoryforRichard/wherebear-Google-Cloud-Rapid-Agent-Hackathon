/**
 * Per-run resource USAGE tracking for a Wherebear shelf-upload / search.
 *
 * Tracks the token / byte counts each operation consumed (Gemini tokens,
 * Voyage embed tokens, thumbnail storage bytes) so op_events can record *what
 * was used*. Monetary cost accounting (USD/CAD pricing) was intentionally
 * removed — we keep the usage counters, never any dollar figures.
 */

export interface UsageTotals {
  /** Sum of promptTokenCount across all Gemini calls in this run. */
  geminiInputTokens: number;
  /** Sum of candidatesTokenCount across all Gemini calls in this run. */
  geminiOutputTokens: number;
  /** Number of distinct images sent to Gemini (Stage 1 full shelf + N crops). */
  geminiImages: number;
  /** Tokens sent through Voyage for vector embedding (Atlas autoEmbed). */
  voyageEmbedTokens: number;
  /** Bytes of new thumbnail JPEGs persisted in MongoDB Atlas. */
  storageBytes: number;
}

export const EMPTY_USAGE: UsageTotals = Object.freeze({
  geminiInputTokens: 0,
  geminiOutputTokens: 0,
  geminiImages: 0,
  voyageEmbedTokens: 0,
  storageBytes: 0,
});

export function addUsage(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    geminiInputTokens: (a.geminiInputTokens ?? 0) + (b.geminiInputTokens ?? 0),
    geminiOutputTokens: (a.geminiOutputTokens ?? 0) + (b.geminiOutputTokens ?? 0),
    geminiImages: (a.geminiImages ?? 0) + (b.geminiImages ?? 0),
    voyageEmbedTokens: (a.voyageEmbedTokens ?? 0) + (b.voyageEmbedTokens ?? 0),
    storageBytes: (a.storageBytes ?? 0) + (b.storageBytes ?? 0),
  };
}

/** Pull token counts off a Gemini SDK response, defensively. */
export function extractGeminiUsage(
  resp: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } } | undefined | null,
  images: number = 0
): Partial<UsageTotals> {
  const meta = resp?.usageMetadata;
  return {
    geminiInputTokens: meta?.promptTokenCount ?? 0,
    geminiOutputTokens: meta?.candidatesTokenCount ?? 0,
    geminiImages: images,
  };
}
