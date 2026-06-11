import { Db } from 'mongodb';
import { Type, FunctionDeclaration, ThinkingLevel } from '@google/genai';
import { generateContentWithHedge, VISION_MODEL } from '@/lib/gemini';
import { UsageTotals, extractGeminiUsage } from '@/lib/cost';
import { SearchLog } from '@/lib/types';
import { mcpAggregate, mcpInsertMany } from '@/lib/mcp/mongo-ops';
import { SHELVES } from '@/lib/shelves';

// ─────────────────────────────────────────────────────────────
// Tool declarations
// ─────────────────────────────────────────────────────────────

export const AGENT_B_TOOLS: FunctionDeclaration[] = [
  {
    name: 'understand_intent',
    description:
      'Analyze a customer\'s query using the LLM. ' +
      'Returns the detected language, the most likely standard English search phrase, ' +
      'and a brief reasoning trace (typo? mixed language? description? brand name?).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'The raw query string from the worker.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vector_search',
    description:
      'Run an Atlas Vector Search against the products collection using ' +
      'autoEmbed (voyage-4-large). Returns the top matches with similarity scores.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query_text: {
          type: Type.STRING,
          description: 'Text to embed and search for. Use the original query OR a rewritten phrase.',
        },
        limit: {
          type: Type.NUMBER,
          description: 'Max results to return. Default 5.',
        },
      },
      required: ['query_text'],
    },
  },
  {
    name: 'suggest_by_category',
    description:
      'Fallback when vector_search returns nothing useful (no hits, or all scores below ~0.45). ' +
      'Searches the static shelf-category dictionary (defined in lib/shelves.ts) for shelves whose ' +
      'category keyword list contains the query term. Works for English and Chinese keywords. ' +
      'Use this to give a best-guess aisle even when no one has scanned that exact product yet. ' +
      'Returns up to 5 matching shelves with their codes and descriptions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query_text: {
          type: Type.STRING,
          description: 'A normalized product name or category term (English or Chinese).',
        },
      },
      required: ['query_text'],
    },
  },
  {
    name: 'log_search',
    description:
      'Record this query into search_logs for future analysis. Always call this exactly once at the end, ' +
      'including the resolved_intent and whether any product was found.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        original_query: { type: Type.STRING },
        resolved_intent: { type: Type.STRING },
        results_found: { type: Type.NUMBER },
      },
      required: ['original_query', 'resolved_intent', 'results_found'],
    },
  },
  {
    name: 'finish',
    description:
      'Hand the final answer to the worker. Provide BOTH an English and a Chinese (简体) answer so ' +
      'the worker can read whichever the customer needs. Include the canonical product name, latest ' +
      'aisle, all aisles where this SKU has been seen, and match score (0..1). If nothing matches, ' +
      'set product to null and write a polite apology in both answer_en and answer_zh.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        product: {
          type: Type.OBJECT,
          nullable: true,
          properties: {
            canonical_name: { type: Type.STRING },
            latest_aisle: { type: Type.STRING },
            aisles: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description:
                'All shelves this SKU has been seen on (from the vector hit\'s "aisles" field). ' +
                'Same SKU often appears in multiple aisles when different brand origins overlap.',
            },
            score: { type: Type.NUMBER },
            evidence_count: { type: Type.NUMBER },
            aliases: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
        },
        answer_en: {
          type: Type.STRING,
          description: 'One short sentence in ENGLISH for the worker. Example: "Looks like Samyang Buldak Ramen on shelf B6."',
        },
        answer_zh: {
          type: Type.STRING,
          description: 'Same answer in 简体中文. Example: "应该是 B6 货架的三养火鸡面。"',
        },
        answer: {
          type: Type.STRING,
          description:
            'DEPRECATED — single-language answer. Only fill this in if you cannot produce both ' +
            'answer_en and answer_zh. The client prefers answer_en + answer_zh whenever both exist.',
        },
      },
      required: ['answer_en', 'answer_zh'],
    },
  },
];

// ─────────────────────────────────────────────────────────────
// Tool executors
// ─────────────────────────────────────────────────────────────

/**
 * Deterministic intent analysis — script-range language detection plus light
 * shape heuristics, NO LLM call.
 *
 * This used to be a Gemini JSON call (~1.1-2 s per search). Two things made
 * the LLM redundant here:
 *   - search_text aliases are already multilingual (EN/zh/ko/ja/romanized/
 *     misspellings/descriptions), so the raw query embeds straight into the
 *     same space — translation before vector search stopped paying for itself.
 *   - the lexical $search leg of hybrid retrieval handles typos via fuzzy
 *     matching, which was the other job of the LLM rewrite.
 * The tool stays on the agent (the panel step is real), it just answers in
 * microseconds now.
 */
export async function execUnderstandIntent(args: { query: string }) {
  const q = (args.query || '').trim();
  const count = (re: RegExp) => (q.match(re) ?? []).length;
  const han = count(/[一-鿿]/g);
  const kana = count(/[぀-ヿ]/g);
  const hangul = count(/[가-힯]/g);
  const latinWords = q.split(/\s+/).filter(w => /[a-z]/i.test(w)).length;

  const language =
    kana > 0 ? 'ja'
    : hangul > 0 ? 'ko'
    : han > 0 ? (latinWords > 0 ? 'mixed' : 'zh')
    : 'en';

  const kind =
    language === 'en'
      ? (latinWords >= 3 ? 'description' : 'standard_name')
      : (language === 'mixed' ? 'mixed_language' : 'standard_name');

  return {
    language,
    kind,
    // Pass-through: the multilingual alias space + fuzzy lexical leg make the
    // raw query the best search key (see doc comment above).
    rewritten: q,
    // No LLM ⇒ no translation guess. Empty means the zh-mode "likely product"
    // teaser simply doesn't render — at the new total latency it added nothing.
    name_zh: '',
    reasoning: 'script-range language detection (deterministic, no LLM)',
    _usage: {} as Partial<UsageTotals>,
  };
}

interface VectorHit {
  _id: string;
  canonical_name: string;
  aliases: string[];
  latest_aisle: string;
  /** All distinct shelves this SKU was seen on. May be undefined for legacy
   *  docs that pre-date the multi-aisle migration. */
  aisles?: string[];
  category?: string;
  evidence_count: number;
  score: number;
}

export async function execVectorSearch(
  _db: Db,
  args: { query_text: string; limit?: number }
): Promise<{ hits: VectorHit[]; via: 'mcp' | 'sdk' }> {
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 10);
  const result = await mcpAggregate<VectorHit>({
    collection: 'products',
    pipeline: [
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'search_text',
          query: args.query_text,
          numCandidates: 100,
          limit,
        },
      },
      {
        $project: {
          _id: { $toString: '$_id' },
          canonical_name: 1,
          aliases: 1,
          latest_aisle: 1,
          aisles: 1,
          category: 1,
          evidence_count: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ],
  });
  return { hits: result.data, via: result.via };
}

/**
 * Lexical Atlas Search ($search) over the products text fields, with fuzzy
 * matching so brand typos ("samyung" → "Samyang", "fish butter" → "...batter")
 * surface even when the vector neighbour is off. Needs an Atlas Search index
 * named `text_index` on `products` (see scripts/create-search-index.mjs).
 *
 * FAIL-OPEN: if the index doesn't exist yet (or $search errors) this returns no
 * hits instead of throwing, so search degrades to vector-only and never breaks.
 */
export async function execTextSearch(
  args: { query_text: string; limit?: number }
): Promise<{ hits: VectorHit[]; via: 'mcp' | 'sdk' }> {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 20);
  try {
    const result = await mcpAggregate<VectorHit>({
      collection: 'products',
      pipeline: [
        {
          $search: {
            index: 'text_index',
            text: {
              query: args.query_text,
              path: ['canonical_name', 'aliases', 'search_text'],
              fuzzy: { maxEdits: 2, prefixLength: 1, maxExpansions: 50 },
            },
          },
        },
        { $limit: limit },
        {
          $project: {
            _id: { $toString: '$_id' },
            canonical_name: 1,
            aliases: 1,
            latest_aisle: 1,
            aisles: 1,
            category: 1,
            evidence_count: 1,
            score: { $meta: 'searchScore' },
          },
        },
      ],
    });
    return { hits: result.data, via: result.via };
  } catch (err) {
    // Index missing / Search unavailable → degrade to vector-only.
    console.warn('[execTextSearch] $search failed, degrading to vector-only:', (err as Error)?.message);
    return { hits: [], via: 'sdk' };
  }
}

/**
 * Reciprocal Rank Fusion of two ranked lists. RRF score = Σ 1/(k + rank);
 * k=60 is the standard constant. Dedupes by canonical_name. Keeps each doc's
 * vector cosine score when it has one (so the 0.45 relevance floor + the UI
 * score keep behaving); a text-ONLY rescue (a typo the vector missed) gets a
 * constant so it clears the floor and reaches the finish LLM, which makes the
 * real keep/guess/discard call.
 */
const RRF_K = 60;
const TEXT_ONLY_SCORE = 0.6;

function rrfFuse(vector: VectorHit[], text: VectorHit[]): VectorHit[] {
  const byKey = new Map<string, VectorHit & { _rrf: number }>();
  const merge = (list: VectorHit[], isVector: boolean) => {
    list.forEach((h, rank) => {
      const key = h.canonical_name || h._id;
      const contrib = 1 / (RRF_K + rank + 1);
      const existing = byKey.get(key);
      if (existing) {
        existing._rrf += contrib;
        if (isVector) existing.score = h.score; // prefer the true cosine score
      } else {
        byKey.set(key, { ...h, _rrf: contrib, score: isVector ? h.score : TEXT_ONLY_SCORE });
      }
    });
  };
  merge(vector, true);
  merge(text, false);
  return [...byKey.values()].sort((a, b) => b._rrf - a._rrf);
}

/**
 * Hybrid retrieval: Atlas $vectorSearch (semantic, cross-language) + $search
 * (lexical/fuzzy, catches exact tokens & typos the vector misses), fused with
 * RRF. Runs both legs in parallel; if the text index isn't built yet,
 * execTextSearch fails open and this is effectively vector-only.
 */
export async function execHybridSearch(
  db: Db,
  args: { query_text: string; limit?: number }
): Promise<{ hits: VectorHit[]; via: 'mcp' | 'sdk' }> {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 10);
  const [vec, txt] = await Promise.all([
    execVectorSearch(db, { query_text: args.query_text, limit }),
    execTextSearch({ query_text: args.query_text, limit }),
  ]);
  const hits = rrfFuse(vec.hits, txt.hits).slice(0, limit);
  // 'mcp' if either leg went through MCP — keeps the UI's MCP pill honest.
  const via: 'mcp' | 'sdk' = vec.via === 'mcp' || txt.via === 'mcp' ? 'mcp' : 'sdk';
  return { hits, via };
}

interface CategorySuggestion {
  code: string;
  description: string;
  matched_keyword: string;
}

export async function execSuggestByCategory(
  args: { query_text: string }
): Promise<{ matches: CategorySuggestion[]; total_searched: number }> {
  const q = (args.query_text || '').toLowerCase().trim();
  if (!q) return { matches: [], total_searched: SHELVES.length };

  // Only consider main shelves (A1-A12, B1-B11) for category lookup — the
  // L/R side faces and C-zone entries inherit (or have no) categories.
  const mainShelves = SHELVES.filter(
    s => /^[AB]\d+$/.test(s.code) && s.categories.length > 0
  );

  const matches: CategorySuggestion[] = [];
  for (const s of mainShelves) {
    const hit = s.categories.find(c => {
      const cl = c.toLowerCase();
      return cl.includes(q) || q.includes(cl);
    });
    if (hit) {
      matches.push({ code: s.code, description: s.description, matched_keyword: hit });
    }
  }

  return { matches: matches.slice(0, 5), total_searched: mainShelves.length };
}

// ─────────────────────────────────────────────────────────────
// Finish synthesis — one LLM call applying the exact decision rules the
// agentic system prompt enforced on its final turn. Replaces the agent
// "deciding" to call finish, removing a whole decision round.
// ─────────────────────────────────────────────────────────────

// The LLM ONLY writes the bilingual summary line for an already-decided mode.
// Candidate selection is done in code (by score threshold) — see synthesizeFinish.
const ANSWER_PROMPT = `You are finishing a grocery-store "find the aisle" search. You get the shopper's QUERY and CANDIDATES — vector neighbours (closest in meaning, NOT guaranteed right). Sort the candidates into THREE buckets by index:

1. "keep" — candidates that ARE what the shopper asked for (same product; any brand or flavour counts). Real matches.
2. "guess" — NOT the item itself, but a useful LOCATION CLUE because it is either:
     • SAME CATEGORY (query "Kikkoman soy sauce" → a different brand of soy sauce), or
     • SAME BRAND (query "Lee Kum Kee XO sauce" → a different Lee Kum Kee product).
   A guess only hints at roughly where to look — it is NOT what they want.
3. discard — neither the same product, nor same category, nor same brand.

Rules:
- Each candidate goes in exactly ONE bucket (keep OR guess OR discard).
- If there are any keep, guess may be empty.
- If there are no keep, put any same-brand / same-category items in guess.
- If nothing shares product, category, or brand → both lists empty (a true not-found).

Then write a bilingual answer:
- keep ≥ 2: EN "Found a few possibilities — most likely {first} on shelf {aisle}." ZH "找到几个可能，最相符的是 {aisle} 货架的 {first}。"
- keep = 1: EN "Looks like {name} on shelf {aisle}." ZH "应该是 {aisle} 货架的 {name}。"
- keep = 0, guess ≥ 1: EN "Couldn't find {query} — it may not be stocked. Same brand/category items are around shelf {codes} (a guess, not the item)." ZH "没找到{query}，店里可能没有。同品牌或同类商品在 {codes} 货架附近（只是猜测参考，不是你要找的东西）。"
- both empty: EN "Couldn't find this product yet." ZH "暂时没有找到这个商品的位置记录。"

Keep product names in their original language. Return ONLY JSON (no prose, no code fence):
{"keep": [indices], "guess": [indices], "answer_en": "...", "answer_zh": "..."}`;

export interface FinishCandidate {
  canonical_name: string;
  latest_aisle?: string;
  aisles?: string[];
  score?: number;
  evidence_count?: number;
  aliases?: string[];
  thumbnail?: string;
}

export interface FinishResult {
  /** Every vector hit that cleared the relevance bar, best first. Ambiguous
   *  queries return several; the UI shows them all and the worker picks. */
  candidates: FinishCandidate[];
  /** NOT the item, but same-brand / same-category location hints — populated
   *  only when there are no real matches, clearly flagged as guesses in the UI. */
  guesses: FinishCandidate[];
  answer_en: string;
  answer_zh: string;
}

/** Score floor for showing a hit as a candidate. voyage-4-large cosine scores
 *  for real matches cluster around ~0.50; well below that is off-topic. Tune
 *  here if recall/precision needs shifting. */
const CANDIDATE_MIN_SCORE = 0.45;   // coarse vector floor — the LLM does the real filtering
const POOL_SIZE = 8;                // how many neighbours the LLM judges for relevance
const MAX_CANDIDATES = 5;           // how many we ultimately show

function pickCandidate(h: VectorHit): FinishCandidate {
  return {
    canonical_name: h.canonical_name,
    latest_aisle: h.latest_aisle,
    aisles: h.aisles && h.aisles.length ? h.aisles : [h.latest_aisle],
    score: h.score,
    evidence_count: h.evidence_count,
    aliases: h.aliases,
  };
}

/**
 * Decide the final result. voyage-4-large cosine can't separate a true match
 * (~0.50) from noise (~0.50), so the LLM sorts the pool into THREE buckets:
 *   keep   — real matches (same product)        → candidates
 *   guess  — same brand OR same category         → location hints (only when nothing matched)
 *   discard— unrelated
 * A "not found" that still has same-brand/category items returns those as
 * guesses (the UI flags them clearly as a guess, not the item). Nothing related
 * → genuinely empty. Fail-open: a garbled reply keeps the pool as candidates.
 */
export async function synthesizeFinish(input: {
  query: string;
  intent: { rewritten?: string; language?: string; kind?: string };
  hits: VectorHit[];
}): Promise<FinishResult & { usage: Partial<UsageTotals> }> {
  const aislesOf = (c: FinishCandidate) =>
    c.aisles && c.aisles.length ? c.aisles : ([c.latest_aisle].filter(Boolean) as string[]);

  // Coarse pool of nearest neighbours; the LLM does the real bucketing.
  const pool = input.hits
    .filter(h => (h.score ?? 0) >= CANDIDATE_MIN_SCORE)
    .slice(0, POOL_SIZE)
    .map(pickCandidate);

  let candidates: FinishCandidate[] = pool.slice(0, MAX_CANDIDATES); // fail-open default
  let guesses: FinishCandidate[] = [];
  let answer_en = '', answer_zh = '';
  let usage: Partial<UsageTotals> = {};

  if (pool.length > 0) {
    const ctx = JSON.stringify({
      query: input.query,
      candidates: pool.map((c, i) => ({ i, name: c.canonical_name, aisles: aislesOf(c) })),
    });
    const result = await generateContentWithHedge({
      model: VISION_MODEL,
      contents: [{ role: 'user', parts: [{ text: ANSWER_PROMPT }, { text: ctx }] }],
      config: { responseMimeType: 'application/json', temperature: 0.2, thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
    });
    usage = extractGeminiUsage(result, 0);
    const fromIdx = (arr: unknown): FinishCandidate[] | null => Array.isArray(arr)
      ? arr.map((i: unknown) => pool[Number(i)])
          .filter((c: FinishCandidate | undefined): c is FinishCandidate => !!c)
          .slice(0, MAX_CANDIDATES)
      : null;
    try {
      const p = JSON.parse(result.text ?? '{}');
      const keep = fromIdx(p.keep);
      if (keep) candidates = keep;          // empty keep ⇒ genuine "not found"
      guesses = fromIdx(p.guess) ?? [];
      if (typeof p.answer_en === 'string') answer_en = p.answer_en;
      if (typeof p.answer_zh === 'string') answer_zh = p.answer_zh;
    } catch { /* fail-open: keep the pool, fall through to the code answer */ }
  }

  // Guesses only matter when nothing was actually found.
  if (candidates.length > 0) guesses = [];

  const mode: 'single' | 'multi' | 'guess' | 'none' =
    candidates.length === 0
      ? (guesses.length > 0 ? 'guess' : 'none')
      : candidates.length === 1 ? 'single' : 'multi';

  // Deterministic answer fallback so an LLM hiccup never blanks the summary.
  if (!answer_en || !answer_zh) {
    if (mode === 'none') {
      answer_en ||= "Couldn't find this product yet.";
      answer_zh ||= '暂时没有找到这个商品的位置记录。';
    } else if (mode === 'guess') {
      const codes = Array.from(new Set(guesses.flatMap(aislesOf))).join(', ');
      answer_en ||= `Couldn't find "${input.query}" — it may not be stocked. Same brand/category items are around shelf ${codes} (a guess, not the item).`;
      answer_zh ||= `没找到「${input.query}」，店里可能没有。同品牌或同类商品在 ${codes} 货架附近（只是猜测参考，不是你要找的东西）。`;
    } else {
      const first = candidates[0];
      const ais = aislesOf(first).join(', ');
      if (mode === 'single') {
        answer_en ||= `Looks like ${first.canonical_name} on shelf ${ais}.`;
        answer_zh ||= `应该是 ${ais} 货架的 ${first.canonical_name}。`;
      } else {
        answer_en ||= `Found ${candidates.length} possibilities — most likely ${first.canonical_name} on shelf ${ais}.`;
        answer_zh ||= `找到 ${candidates.length} 个可能，最相符的是 ${ais} 货架的 ${first.canonical_name}。`;
      }
    }
  }

  return { candidates, guesses, answer_en, answer_zh, usage };
}

export async function execLogSearch(
  _db: Db,
  args: { original_query: string; resolved_intent: string; results_found: number }
) {
  const result = await mcpInsertMany({
    collection: 'search_logs',
    documents: [{
      query: args.original_query,
      resolved_intent: args.resolved_intent,
      results_found: args.results_found,
      no_result_terms: args.results_found === 0 ? [args.original_query] : undefined,
      timestamp: { $date: new Date().toISOString() },
    }],
  });
  return { via: result.via, inserted: result.data.insertedCount };
}

// ─────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────

export type ToolNameB = 'understand_intent' | 'vector_search' | 'suggest_by_category' | 'log_search' | 'finish';

export async function dispatchToolB(
  db: Db,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name as ToolNameB) {
    case 'understand_intent':
      return execUnderstandIntent(args as { query: string });
    case 'vector_search':
      return execVectorSearch(db, args as { query_text: string; limit?: number });
    case 'suggest_by_category':
      return execSuggestByCategory(args as { query_text: string });
    case 'log_search':
      return execLogSearch(db, args as Parameters<typeof execLogSearch>[1]);
    case 'finish':
      return { ok: true, ...args };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
