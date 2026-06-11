/**
 * Direct shelf-save pipeline — replaces the Agent A LLM-driven loop.
 *
 * Why: the old loop ran 4–5 generateContent calls + N serial MCP upserts
 * per shelf. A 10-product batch was 25–40 seconds and sometimes lost
 * items when Gemini decided to "skip" one. Field test failed at 72
 * detected items with the SSE dropping mid-stream.
 *
 * New flow (critical path):
 *   1. ONE find by canonical_name $in (~100 ms) to know which are new
 *   2. ONE MongoDB Node.js driver bulkWrite upsert for all products (~150 ms)
 *   3. ONE insert into shelf_evidence (~50 ms)
 *   → total ~300–500 ms, then `done` event closes the SSE
 *
 * Background (after SSE closes):
 *   - expand_aliases_batch (single LLM call, 3–8 s)
 *   - second bulkWrite to apply aliases + refresh search_text
 *   - Atlas Vector Search auto-embed picks up the updated search_text
 *
 * Reliability win: every detected item gets a bulkWrite op, so nothing
 * is silently dropped by an LLM "decision".
 */

import { BulkWriteResult, AnyBulkWriteOperation, Document } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { DetectedProduct } from '@/lib/gemini';
import { AgentEvent } from '@/lib/agents/types';
import { execExpandAliasesBatch } from '@/lib/agents/tools-a';
import { buildShelfContext } from '@/lib/shelves';
import { UsageTotals, EMPTY_USAGE } from '@/lib/cost';

// Rough character → token ratio for the rapid cost estimate we emit during
// the save phase. The actual alias-batch LLM call runs in the background
// AFTER the SSE closes, so we can't measure it live — we estimate from
// the canonical names we're about to ship to Gemini.
const CHARS_PER_TOKEN = 4;
const ALIAS_OUTPUT_TOKENS_PER_PRODUCT = 35; // 3-4 Chinese aliases, ~10 tokens each
const VOYAGE_TOKENS_PER_SEARCH_TEXT = 30;   // canonical + 3-4 aliases joined

export interface ShelfSaveInput {
  aisle: string;
  products: DetectedProduct[];
}

interface NormalizedProduct {
  canonical_name: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  /** 240px JPEG data URL — the best-lit crop chosen during Stage 2 dedup. */
  thumbnail?: string;
}

/** Strip parenthetical/bracket suffixes and collapse whitespace. */
function normalizeCanonicalName(raw: string): string {
  return raw
    .trim()
    .replace(/\s*[\[(][^\])]*[\])]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchText(canonical: string, aliases: string[]): string {
  return Array.from(
    new Set([canonical, ...aliases].map(s => s.trim()).filter(Boolean))
  ).join(' · ');
}

/** De-dupe by canonical_name, merging fields by latest non-empty value. */
function normalizeShelfProducts(products: DetectedProduct[]): NormalizedProduct[] {
  const byName = new Map<string, NormalizedProduct>();
  for (const p of products) {
    const canonical = normalizeCanonicalName(p?.name ?? '');
    if (!canonical) continue;
    const prior = byName.get(canonical);
    byName.set(canonical, {
      canonical_name: canonical,
      category: p.category ?? prior?.category,
      confidence: p.confidence ?? prior?.confidence,
      thumbnail: p.thumbnail ?? prior?.thumbnail,
    });
  }
  return Array.from(byName.values());
}

/**
 * Fast critical-path save. Emits the same SSE event shape ProgressScreen
 * already understands (`save_products` + `record_shelf_evidence`), so no
 * client changes are needed. Adds `via: "mongodb-driver"` and
 * `duration_ms` on the result so the UI can flex MongoDB usage on screen.
 */
export async function* saveShelfDirect(
  input: ShelfSaveInput
): AsyncGenerator<AgentEvent> {
  const db = await getDb();
  const items = normalizeShelfProducts(input.products);

  yield {
    type: 'plan_start',
    ts: Date.now(),
    message: `Saving ${items.length} product${items.length === 1 ? '' : 's'} to ${input.aisle}.`,
  };

  if (items.length === 0) {
    yield {
      type: 'done',
      ts: Date.now(),
      summary: 'Nothing to save — no valid product names.',
    };
    return;
  }

  // STEP 1: tell client we're saving (matches existing TOOL_LABELS).
  const tCall = Date.now();
  yield {
    type: 'tool_call',
    ts: tCall,
    tool: 'save_products',
    args: {
      aisle: input.aisle,
      // ProgressScreen reads args.products.length — only canonical_name needs
      // to be present, so we don't pad the SSE event with full product data.
      products: items.map(p => ({ canonical_name: p.canonical_name })),
    },
  };

  // STEP 2: figure out new vs existing for accurate inserted/updated counts.
  const names = items.map(p => p.canonical_name);
  const existingDocs = await db
    .collection('products')
    .find({ canonical_name: { $in: names } }, { projection: { canonical_name: 1 } })
    .toArray();
  const existingNames = new Set(existingDocs.map(d => d.canonical_name as string));

  // STEP 3: one bulkWrite with all upserts.
  const now = new Date();
  const ops: AnyBulkWriteOperation<Document>[] = items.map(p => ({
    updateOne: {
      filter: { canonical_name: p.canonical_name },
      update: {
        $set: {
          latest_aisle: input.aisle,
          updated_at: now,
          ...(p.category ? { category: p.category } : {}),
          ...(p.confidence ? { last_confidence: p.confidence } : {}),
          // Always refresh thumbnail with the latest best-quality crop —
          // a clearer photo of the same SKU on a re-scan replaces the old one.
          ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
        },
        // Many SKUs legitimately appear on multiple shelves — the same
        // ramen brand can sit in both B6 (instant noodles) and B3
        // (Philippine sauce/noodle aisle) depending on origin. We track
        // every distinct shelf a SKU was seen on so Find can list them
        // all instead of only the most recent.
        $addToSet: { aisles: input.aisle },
        $setOnInsert: {
          canonical_name: p.canonical_name,
          aliases: [p.canonical_name],
          search_text: p.canonical_name,
          created_at: now,
        },
        $inc: { evidence_count: 1 },
      },
      upsert: true,
    },
  }));

  let writeResult: BulkWriteResult;
  try {
    writeResult = await db
      .collection('products')
      .bulkWrite(ops, { ordered: false });
  } catch (err) {
    // Even on partial failure, MongoDB driver throws — but the successful
    // ops did land. Yield an error event so the UI knows something went
    // wrong, then continue (the user can re-upload if needed).
    yield {
      type: 'error',
      ts: Date.now(),
      error: `bulkWrite failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    return;
  }

  const tCallEnd = Date.now();
  const inserted = items.filter(p => !existingNames.has(p.canonical_name)).length;
  const updated = items.length - inserted;

  yield {
    type: 'tool_result',
    ts: tCallEnd,
    tool: 'save_products',
    result: {
      totals: { inserted, updated },
      via: 'mongodb-driver',
      duration_ms: tCallEnd - tCall,
      matched: writeResult.matchedCount,
      upserted: writeResult.upsertedCount,
    },
  };

  // STEP 4: shelf_evidence row — small, fast, fire-and-await for clarity.
  yield {
    type: 'tool_call',
    ts: Date.now(),
    tool: 'record_shelf_evidence',
    args: { aisle: input.aisle, products_detected: names },
  };
  await db.collection('shelf_evidence').insertOne({
    photo_url: '',
    aisle: input.aisle,
    products_detected: names,
    timestamp: now,
  });
  yield {
    type: 'tool_result',
    ts: Date.now(),
    tool: 'record_shelf_evidence',
    result: { inserted: 1, via: 'mongodb-driver' },
  };

  // Emit estimated cost for the background alias batch + Voyage embed.
  // The actual LLM call fires AFTER the SSE closes (fire-and-forget), so
  // we estimate from canonical-name lengths. Tiny number — usually well
  // under a cent for a full shelf — but the demo studies pricing so we
  // expose it instead of swallowing.
  const aliasUsage = estimateAliasUsage(items);
  yield {
    type: 'cost',
    ts: Date.now(),
    usage: aliasUsage,
  };

  yield {
    type: 'done',
    ts: Date.now(),
    summary: `Saved to ${input.aisle} — ${inserted} new, ${updated} updated.`,
  };
}

function estimateAliasUsage(items: NormalizedProduct[]): Partial<UsageTotals> {
  const inputChars = items.reduce((s, p) => s + p.canonical_name.length, 0) + 400;
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const outputTokens = items.length * ALIAS_OUTPUT_TOKENS_PER_PRODUCT;
  const voyageTokens = items.length * VOYAGE_TOKENS_PER_SEARCH_TEXT;
  return {
    ...EMPTY_USAGE,
    geminiInputTokens: inputTokens,
    geminiOutputTokens: outputTokens,
    voyageEmbedTokens: voyageTokens,
  };
}

/**
 * Background enhancement. Runs after the SSE stream closes. Generates
 * Chinese aliases for the saved products in ONE batched LLM call and
 * applies them via a second bulkWrite. Any failure is logged but does
 * not affect the user — the products are already saved and searchable
 * by canonical_name through vector search.
 */
export async function enhanceShelfBackground(input: ShelfSaveInput): Promise<void> {
  try {
    const db = await getDb();
    const items = normalizeShelfProducts(input.products);
    if (items.length === 0) return;

    const shelfContext = buildShelfContext(input.aisle);
    const { aliases_by_name } = await execExpandAliasesBatch({
      canonical_names: items.map(p => p.canonical_name),
      shelf_context: shelfContext,
    });

    const ops: AnyBulkWriteOperation<Document>[] = [];
    const now = new Date();
    for (const item of items) {
      const generated = aliases_by_name[item.canonical_name] ?? [];
      if (generated.length === 0) continue;
      const finalAliases = Array.from(
        new Set([item.canonical_name, ...generated].map(s => s.trim()).filter(Boolean))
      );
      ops.push({
        updateOne: {
          filter: { canonical_name: item.canonical_name },
          update: {
            $set: {
              aliases: finalAliases,
              search_text: buildSearchText(item.canonical_name, finalAliases),
              updated_at: now,
            },
          },
        },
      });
    }

    if (ops.length === 0) return;
    const result = await db
      .collection('products')
      .bulkWrite(ops, { ordered: false });
    console.log(
      `[shelf-save:bg] aliases applied for ${input.aisle} — ` +
        `${result.modifiedCount} products updated (Atlas autoEmbed will re-index)`
    );
  } catch (err) {
    console.warn(
      '[shelf-save:bg] alias enhancement failed:',
      err instanceof Error ? err.message : err
    );
  }
}
