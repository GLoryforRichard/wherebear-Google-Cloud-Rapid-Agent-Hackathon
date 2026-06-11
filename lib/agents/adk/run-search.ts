/**
 * ADK-orchestrated "find the aisle" search, exposed with the SAME streaming
 * contract as the legacy lib/agents/agent-b.ts `runAgentB`, so the SSE route and
 * the Find UI need no changes.
 *
 * Division of labour:
 *   - The ADK LlmAgent (getSearchAgent) drives Gemini function-calling over the
 *     app FunctionTools + the MongoDB MCPToolset. This is the part that makes the
 *     project "built with ADK + integrated with a partner MCP server".
 *   - The proven `synthesizeFinish` still produces the final bilingual answer and
 *     keep/guess/discard buckets, so output quality and the client payload are
 *     identical to before — LLM nondeterminism is kept out of the final answer.
 *
 * We translate ADK `Event`s into the existing `AgentEvent` shape:
 *   plan_start → tool_call/tool_result (per function call) → finish → cost → done.
 */
import {
  Runner,
  InMemorySessionService,
  getFunctionCalls,
  getFunctionResponses,
} from '@google/adk';
import type { Db } from 'mongodb';
import { getDb } from '@/lib/mongodb';
import { AgentEvent } from '../types';
import { UsageTotals, EMPTY_USAGE, addUsage, extractGeminiUsage } from '@/lib/cost';
import { synthesizeFinish, execHybridSearch, FinishCandidate } from '@/lib/agents/tools-b';
import { getSearchAgent } from './search-agent';

export interface AgentBInput {
  query: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** Backfill thumbnail + canonical aisle list from Mongo for each candidate,
 *  mutating in place — same enrichment the legacy pipeline did (agent-b.ts). */
async function enrich(db: Db, list: FinishCandidate[]): Promise<void> {
  await Promise.all(
    list.map(async (c) => {
      if (!c.canonical_name) return;
      try {
        const e = await db.collection('products').findOne(
          { canonical_name: c.canonical_name },
          { projection: { thumbnail: 1, aisles: 1, latest_aisle: 1 } }
        );
        if (e) {
          if (typeof e.thumbnail === 'string') c.thumbnail = e.thumbnail;
          if (Array.isArray(e.aisles) && e.aisles.length > 0) c.aisles = e.aisles as string[];
          else if (typeof e.latest_aisle === 'string') c.aisles = [e.latest_aisle];
        }
      } catch {
        /* non-fatal — that card just won't show an image / extra aisles */
      }
    })
  );
}

export async function* runAgentBAdk(input: AgentBInput): AsyncGenerator<AgentEvent> {
  const query = input.query;
  const db = await getDb();
  let usage: UsageTotals = { ...EMPTY_USAGE };

  // Collected from the agent's tool calls as it runs.
  let intent: { rewritten?: string; language?: string; kind?: string } = {};
  let hits: unknown[] = [];
  // Final-answer synthesis only needs query+hits, so the moment a confident
  // retrieval lands we start it IN PARALLEL with the agent's closing turn —
  // by the time the agent replies DONE the answer is (nearly) ready.
  let finishEarly: ReturnType<typeof synthesizeFinish> | null = null;

  yield { type: 'plan_start', ts: Date.now(), message: `Looking up "${query}"…` };

  const runner = new Runner({
    appName: 'wherebear',
    agent: getSearchAgent(),
    sessionService: new InMemorySessionService(),
  });

  // Drive the ADK agent. It calls understand_intent → vector_search (and maybe
  // suggest_by_category / MongoDB MCP tools) via Gemini function-calling.
  for await (const event of runner.runEphemeral({
    userId: 'worker',
    // role:'user' is required — without it Gemini drops the content and the
    // agent never sees the query (it replies "what are you looking for?").
    newMessage: { role: 'user', parts: [{ text: query }] },
  })) {
    // Token usage from each agent LLM turn (function-calling decisions + reply).
    if ((event as { usageMetadata?: unknown }).usageMetadata) {
      usage = addUsage(usage, extractGeminiUsage(event as Parameters<typeof extractGeminiUsage>[0]));
    }

    for (const call of getFunctionCalls(event)) {
      yield { type: 'tool_call', ts: Date.now(), tool: call.name ?? 'tool', args: call.args ?? {} };
    }

    for (const resp of getFunctionResponses(event)) {
      const r = asRecord(resp.response);
      yield { type: 'tool_result', ts: Date.now(), tool: resp.name ?? 'tool', result: r };

      if (resp.name === 'understand_intent') {
        intent = {
          rewritten: typeof r.rewritten === 'string' ? r.rewritten : undefined,
          language: typeof r.language === 'string' ? r.language : undefined,
          kind: typeof r.kind === 'string' ? r.kind : undefined,
        };
        if (r._usage) usage = addUsage(usage, r._usage as Partial<UsageTotals>);
      }
      if (resp.name === 'vector_search' && Array.isArray(r.hits)) {
        hits = r.hits; // keep the latest non-empty retrieval
        // Under the 2-turn protocol the agent never re-searches, so the first
        // vector_search result is final — synthesis can always start now.
        // (A weak retrieval may add a suggest_by_category call, but its result
        // feeds the panel only, never the synthesized answer.)
        if (!finishEarly) {
          finishEarly = synthesizeFinish({
            query,
            intent,
            hits: hits as Parameters<typeof synthesizeFinish>[0]['hits'],
          });
        }
      }
    }
  }

  // Safety net: the LLM occasionally takes the lazy path and replies DONE
  // without calling any tool (seen in production as a "1 step" search that
  // finds nothing despite the product existing). Retrieval correctness must
  // not depend on the model's mood — if no vector_search ran, run the same
  // hybrid retrieval directly and surface it as a real step in the panel.
  if (!finishEarly && hits.length === 0) {
    yield { type: 'tool_call', ts: Date.now(), tool: 'vector_search', args: { query_text: query } };
    try {
      const direct = await execHybridSearch(db, { query_text: query });
      hits = direct.hits;
      yield { type: 'tool_result', ts: Date.now(), tool: 'vector_search', result: { hits: direct.hits, via: direct.via } };
    } catch (err) {
      yield { type: 'tool_result', ts: Date.now(), tool: 'vector_search', result: { hits: [], via: 'sdk', error: String(err) } };
    }
  }

  // Final synthesis: reuse the proven keep/guess/discard + bilingual logic.
  // Usually already running (started alongside the agent's closing turn).
  yield { type: 'tool_call', ts: Date.now(), tool: 'finish', args: {} };
  const fin = await (finishEarly ?? synthesizeFinish({
    query,
    intent,
    hits: hits as Parameters<typeof synthesizeFinish>[0]['hits'],
  }));
  usage = addUsage(usage, fin.usage);

  const candidates = fin.candidates;
  const guesses = fin.guesses ?? [];
  await enrich(db, [...candidates, ...guesses]);

  const finishData = {
    candidates,
    guesses,
    product: candidates[0] ?? null, // back-compat for older readers
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
