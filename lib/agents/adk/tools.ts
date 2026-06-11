/**
 * ADK FunctionTool wrappers around the existing Agent-B executors.
 *
 * These expose the *same* search primitives the legacy fixed pipeline used
 * (lib/agents/tools-b.ts), but as `@google/adk` FunctionTools so a real ADK
 * LlmAgent can call them via Gemini function-calling. The business logic is NOT
 * re-implemented here — each tool delegates to the proven executor.
 *
 * Parameter schemas use `@google/genai` Schema objects (the same `Type.OBJECT`
 * style tools-b.ts already uses) rather than zod, on purpose:
 *   - ADK ships its own zod@4 and genai@1.x; the app uses zod@3 (transitively)
 *     and genai@2.x. A zod object built against the app's zod would fail ADK's
 *     internal `instanceof` checks at runtime, and the ZodObject types don't
 *     line up at compile time either.
 *   - A genai Schema is a plain data object with no `instanceof` dependency, so
 *     it survives the version boundary cleanly. ADK uses it directly as the
 *     FunctionDeclaration parameters.
 * Because the params are a Schema, ADK types `execute`'s input as `unknown`, so
 * each tool destructures with a small local cast.
 */
import { FunctionTool } from '@google/adk';
import { Type } from '@google/genai';
import { getDb } from '@/lib/mongodb';
import {
  execUnderstandIntent,
  execHybridSearch,
  execSuggestByCategory,
} from '@/lib/agents/tools-b';

/** Stage 1 — deterministic language/shape detection (no LLM, sub-millisecond). */
export const understandIntentTool = new FunctionTool({
  name: 'understand_intent',
  description:
    'Analyze the shopper query: detected language, query kind, and the search ' +
    'phrase to use. Instant (no model call). Call it together with vector_search ' +
    'in your first turn.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: 'The raw query string from the worker.' },
    },
    required: ['query'],
  },
  execute: async (input) => {
    const { query } = input as { query: string };
    // Returns { language, kind, rewritten, name_zh, reasoning, _usage }.
    return execUnderstandIntent({ query });
  },
});

/** Stage 2 — hybrid Atlas retrieval (vector + lexical/fuzzy, RRF-fused). */
export const vectorSearchTool = new FunctionTool({
  name: 'vector_search',
  description:
    'Run a hybrid Atlas search (semantic $vectorSearch + lexical/fuzzy $search, ' +
    'RRF-fused) over the products collection. Pass the rewritten English phrase ' +
    'for best recall; you may call it again with the raw query if results look ' +
    'weak. Returns the top matches with similarity scores.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query_text: {
        type: Type.STRING,
        description: 'Text to embed and search for — the rewritten phrase or raw query.',
      },
      limit: {
        type: Type.NUMBER,
        description: 'Max results to return. Default 10, capped at 10.',
      },
    },
    required: ['query_text'],
  },
  execute: async (input) => {
    const { query_text, limit } = input as { query_text: string; limit?: number };
    const db = await getDb();
    const { hits, via } = await execHybridSearch(db, { query_text, limit });
    return { hits, via };
  },
});

/** Fallback — static shelf-category dictionary when retrieval is empty/weak. */
export const suggestByCategoryTool = new FunctionTool({
  name: 'suggest_by_category',
  description:
    'Fallback ONLY when vector_search returns nothing useful. Looks up the static ' +
    'shelf-category dictionary for shelves whose category keywords match the term ' +
    '(English or Chinese). Use it to give a best-guess aisle even when no one has ' +
    'scanned that exact product yet.',
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
  execute: async (input) => {
    const { query_text } = input as { query_text: string };
    return execSuggestByCategory({ query_text });
  },
});

/** All app FunctionTools the ADK search agent exposes (MCPToolset added separately). */
export const ADK_SEARCH_FUNCTION_TOOLS = [
  understandIntentTool,
  vectorSearchTool,
  suggestByCategoryTool,
];
