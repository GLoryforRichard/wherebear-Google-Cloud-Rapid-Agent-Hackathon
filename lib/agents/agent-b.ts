import { UsageTotals, EMPTY_USAGE, addUsage } from '@/lib/cost';
import { getDb } from '@/lib/mongodb';
import { AgentEvent } from './types';
import {
  execUnderstandIntent,
  execHybridSearch,
  synthesizeFinish,
} from './tools-b';

export interface AgentBInput {
  query: string;
}

/**
 * Find-the-aisle search as a FIXED pipeline (formerly an agentic loop):
 *   1. understand_intent      (LLM)  → language / kind / rewritten / name_zh
 *   2. vector_search          (Atlas) on the rewritten phrase
 *      2b. one fallback search on the RAW query if the first was weak/empty
 *   3. suggest_by_category    (static dict) only when vector is still weak
 *   4. synthesizeFinish       (LLM)  applies the exact finish decision rules
 *
 * Two LLM calls instead of ~7 Gemini "what tool next?" decision rounds — same
 * understand → search → answer logic, roughly 2× faster. Still yields the same
 * tool_call / tool_result / cost / done events, so the Find UI is unchanged.
 */
export async function* runAgentB(input: AgentBInput): AsyncGenerator<AgentEvent> {
  const db = await getDb();
  let usage: UsageTotals = { ...EMPTY_USAGE };
  const query = input.query;

  yield { type: 'plan_start', ts: Date.now(), message: `Looking up "${query}"…` };

  // 1 — understand intent
  yield { type: 'tool_call', ts: Date.now(), tool: 'understand_intent', args: { query } };
  const intent = await execUnderstandIntent({ query }) as Record<string, unknown> & {
    rewritten?: string; language?: string; kind?: string; _usage?: Partial<UsageTotals>;
  };
  if (intent._usage) usage = addUsage(usage, intent._usage);
  yield { type: 'tool_result', ts: Date.now(), tool: 'understand_intent', result: intent };

  const rewritten =
    typeof intent.rewritten === 'string' && intent.rewritten.trim()
      ? intent.rewritten.trim()
      : query;

  // 2 — hybrid search (vector + lexical/fuzzy, RRF-fused) on the rewritten phrase
  yield { type: 'tool_call', ts: Date.now(), tool: 'vector_search', args: { query_text: rewritten } };
  const vs1 = await execHybridSearch(db, { query_text: rewritten, limit: 10 });
  yield { type: 'tool_result', ts: Date.now(), tool: 'vector_search', result: { hits: vs1.hits, via: vs1.via } };
  let hits = vs1.hits;
  let topScore = hits[0]?.score ?? 0;

  // 2b — one fallback search on the raw query if the first was weak/empty
  const rawQ = query.trim();
  if ((hits.length === 0 || topScore < 0.55) && rawQ && rawQ !== rewritten) {
    yield { type: 'tool_call', ts: Date.now(), tool: 'vector_search', args: { query_text: rawQ } };
    const vs2 = await execHybridSearch(db, { query_text: rawQ, limit: 10 });
    yield { type: 'tool_result', ts: Date.now(), tool: 'vector_search', result: { hits: vs2.hits, via: vs2.via } };
    if ((vs2.hits[0]?.score ?? 0) > topScore) {
      hits = vs2.hits;
      topScore = vs2.hits[0]?.score ?? 0;
    }
  }

  // 3 — synthesize the final result: a list of every candidate above the bar
  //      (no category guesswork — nothing above the bar means "not found").
  yield { type: 'tool_call', ts: Date.now(), tool: 'finish', args: {} };
  const fin = await synthesizeFinish({
    query,
    intent: { rewritten: intent.rewritten, language: intent.language, kind: intent.kind },
    hits,
  });
  usage = addUsage(usage, fin.usage);

  // Enrich every candidate with its thumbnail + canonical aisle list from Mongo
  // (we don't make the LLM carry 25 KB base64 images or full aisle arrays).
  // Looked up by canonical_name (indexed), in parallel.
  const candidates = fin.candidates;
  const guesses = fin.guesses ?? [];
  await Promise.all([...candidates, ...guesses].map(async (c) => {
    if (!c.canonical_name) return;
    try {
      const enriched = await db.collection('products').findOne(
        { canonical_name: c.canonical_name },
        { projection: { thumbnail: 1, aisles: 1, latest_aisle: 1 } }
      );
      if (enriched) {
        if (typeof enriched.thumbnail === 'string') c.thumbnail = enriched.thumbnail;
        if (Array.isArray(enriched.aisles) && enriched.aisles.length > 0) {
          c.aisles = enriched.aisles as string[];
        } else if (typeof enriched.latest_aisle === 'string') {
          c.aisles = [enriched.latest_aisle];
        }
      }
    } catch {
      /* non-fatal — that card just won't show an image / extra aisles */
    }
  }));

  const finishData = {
    candidates,
    guesses,
    product: candidates[0] ?? null,   // back-compat for older readers
    answer_en: fin.answer_en,
    answer_zh: fin.answer_zh,
  };
  yield { type: 'tool_result', ts: Date.now(), tool: 'finish', result: finishData };

  yield { type: 'cost', ts: Date.now(), usage };
  yield {
    type: 'done',
    ts: Date.now(),
    summary: fin.answer_en || fin.answer_zh || 'Done.',
    data: finishData,
  };
}
