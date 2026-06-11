/**
 * The Wherebear "find the aisle" agent, built with the Google Agent Development
 * Kit (`@google/adk`).
 *
 * This is the ADK-orchestrated replacement for the legacy hand-rolled pipeline
 * in lib/agents/agent-b.ts. A single LlmAgent drives Gemini function-calling
 * over:
 *   - three app FunctionTools (understand_intent / vector_search /
 *     suggest_by_category) wrapping the existing executors, and
 *   - the official MongoDB MCP server mounted as an ADK MCPToolset, so the agent
 *     can talk to MongoDB Atlas through the Model Context Protocol — the
 *     hackathon's "agent ↔ partner MCP" integration, now framework-native.
 *
 * Model + Vertex config mirror lib/gemini.ts exactly (Gemini 3.x is only served
 * from the `global` Vertex location). Constructed lazily as a singleton so
 * importing this module never spawns the MCP subprocess on its own.
 */
import path from 'node:path';
import { ThinkingLevel } from '@google/genai';
import { LlmAgent, Gemini, MCPToolset } from '@google/adk';
import { VISION_MODEL } from '@/lib/gemini';
import { ADK_SEARCH_FUNCTION_TOOLS } from './tools';

/** Spawn the locally-installed MCP server binary directly. `npx -y …` re-runs
 *  the whole npm resolution machinery on every spawn (~1-2 s + lots of RAM),
 *  and ADK spawns the server far more often than once (see CachedMcpToolset). */
const MCP_SERVER_ENTRY = path.join(
  process.cwd(), 'node_modules', 'mongodb-mcp-server', 'dist', 'esm', 'index.js'
);

/**
 * ADK's stock MCPToolset spawns a FRESH stdio subprocess on every getTools()
 * call — and the Runner asks for the tool list on every LLM turn, so one search
 * (3-5 turns) spawned 3-5 short-lived `mongodb-mcp-server` processes. On the
 * 4 GB e2-medium VM this compounded into multi-minute searches and, under any
 * concurrency, wedged the whole machine (npm-cache lock contention + OOM).
 *
 * The MCP tool list is static for our server+filter, so list it once over a
 * real MCP session and reuse it. Actual tool INVOCATIONS (e.g. `count`) still
 * open a live MCP session per call — the ADK ⇄ MCP integration stays real.
 */
class CachedMcpToolset extends MCPToolset {
  private cachedTools: Awaited<ReturnType<MCPToolset['getTools']>> | null = null;

  override async getTools(...args: Parameters<MCPToolset['getTools']>) {
    if (!this.cachedTools) this.cachedTools = await super.getTools(...args);
    return this.cachedTools;
  }
}

const INSTRUCTION = `You are Wherebear's "find the aisle" search orchestrator for a multilingual grocery store. The query may be English, Chinese, Korean, Japanese, mixed, misspelled, or a free description.

Follow EXACTLY this protocol — it is optimized for speed:
1. In your FIRST reply, call BOTH understand_intent(query) AND vector_search(query) — two function calls in the SAME turn, with the raw query.
2. When the results come back:
   - If vector_search returned at least one hit with score ≥ 0.45 → reply with exactly the single word: DONE
   - Otherwise → call suggest_by_category once with the main product or category word, then reply: DONE

Rules:
- You MUST call the tools in step 1 before anything else. Replying DONE without having called vector_search and received its results is a protocol violation — DONE is ONLY valid after tool results have come back.
- vector_search is the ONLY way to locate a product. NEVER browse the database — no list-collections, no find, no count loops; collections like search_logs / search_history will not help.
- NEVER write a prose answer, summary, or translation — the application composes the final bilingual answer itself.`;

/** Gemini model, mirroring lib/gemini.ts: AI Studio when GEMINI_API_KEY is set,
 *  otherwise Vertex AI at the `global` location (required for Gemini 3.x). */
function buildModel(): Gemini {
  const apiKey = process.env.GEMINI_API_KEY;
  return apiKey
    ? new Gemini({ model: VISION_MODEL, apiKey })
    : new Gemini({
        model: VISION_MODEL,
        vertexai: true,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: 'global',
      });
}

/** Official MongoDB MCP server as a stdio child process, exposed to the agent
 *  as an ADK toolset. Same spawn config as lib/mcp/mongo-mcp.ts. Filtered to a
 *  few safe read-only tools so the agent leans on vector_search for retrieval. */
function buildMongoMcpToolset(): MCPToolset {
  return new CachedMcpToolset(
    {
      type: 'StdioConnectionParams',
      serverParams: {
        command: process.execPath,
        args: [MCP_SERVER_ENTRY],
        env: {
          ...process.env,
          MDB_MCP_CONNECTION_STRING: process.env.MONGODB_URI ?? '',
          MDB_MCP_LOG_PATH: '.mongodb-mcp-server',
        } as Record<string, string>,
      },
    },
    // Narrow allow-list: keep the MongoDB MCP toolset mounted (ADK ⇄ partner MCP
    // stays real and connects on getTools), but don't expose find/list-collections
    // — those tempt the agent to "browse the DB" instead of using vector_search.
    ['count'],
  );
}

let _agent: LlmAgent | null = null;
let _mcp: MCPToolset | null = null;

/** Lazily-built singleton search agent (reuses the MCP connection across calls). */
export function getSearchAgent(): LlmAgent {
  if (_agent) return _agent;
  _mcp = buildMongoMcpToolset();
  _agent = new LlmAgent({
    name: 'wherebear_search_agent',
    model: buildModel(),
    description: 'Finds which supermarket aisle a product is on, across languages.',
    instruction: INSTRUCTION,
    tools: [...ADK_SEARCH_FUNCTION_TOOLS, _mcp],
    generateContentConfig: {
      temperature: 0.2,
      // Tool routing is pattern work, not reasoning. Leaving thinking ON was
      // costing 2-12 s PER agent turn on gemini-3.5-flash (dynamic thinking).
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    },
  });
  return _agent;
}

/** The mounted MongoDB MCP toolset, available after getSearchAgent() runs.
 *  Exposed for graceful shutdown / diagnostics. */
export function getMongoMcpToolset(): MCPToolset | null {
  return _mcp;
}
