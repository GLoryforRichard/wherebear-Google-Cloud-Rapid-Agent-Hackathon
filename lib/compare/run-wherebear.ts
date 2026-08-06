import { detectAndIdentifyProducts } from '@/lib/gemini';
import {
  CompareRunResult,
  COMPARE_MODEL,
  estimateVertexCost,
} from '@/lib/compare/types';

/**
 * Paradigm A — wherebear's production two-stage pipeline (Stage-1 box detect
 * → sharp crop → Stage-2 batch identify → name dedupe), unchanged except the
 * model is forced to gemini-3.6-flash. Runs on Vertex AI with the same auth
 * as the main app.
 */
export async function runWherebearParadigm(
  imageBuffer: Buffer,
  mimeType: string
): Promise<CompareRunResult> {
  const t0 = Date.now();
  const { products, usage } = await detectAndIdentifyProducts(
    imageBuffer,
    mimeType,
    undefined,
    COMPARE_MODEL
  );
  const elapsedMs = Date.now() - t0;

  const compareUsage = {
    inputTokens: usage.geminiInputTokens,
    outputTokens: usage.geminiOutputTokens,
    // Nominal call count: 1 Stage-1 + ceil(crops/40) Stage-2. Hedge/retry
    // duplicates aren't observable from here, so this is a lower bound.
    calls: 1 + Math.max(1, Math.ceil(Math.max(1, usage.geminiImages - 1) / 40)),
    images: usage.geminiImages,
  };

  return {
    ok: true,
    paradigm: 'wherebear',
    model: COMPARE_MODEL,
    provider: 'Vertex AI (Google Cloud)',
    products: products.map(p => ({
      name: p.name,
      category: p.category,
      confidence: p.confidence,
      box_2d: p.box_2d,
      thumbnail: p.thumbnail,
    })),
    count: products.length,
    elapsedMs,
    usage: compareUsage,
    costUSD: estimateVertexCost(compareUsage),
    costBasis: 'list-price-estimate',
  };
}
