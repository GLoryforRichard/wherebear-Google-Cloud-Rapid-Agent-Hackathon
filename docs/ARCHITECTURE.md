# Architecture

Project-wide development constraints are documented in `AGENTS.md`.

## Commands

```bash
npm run dev      # next dev - local server on http://localhost:3000 (spawns MCP subprocess)
npm run build    # next build - also runs the TypeScript compile; use this to verify before deploy
npm start        # next start - production server (PM2 runs this on the VM)
npx tsc --noEmit # type-check only, no build artifacts
```

There is **no test runner and no linter configured** (no `test`/`lint` scripts, no eslint/jest/vitest config). "Verify before commit" means `npm run build` passes with no TypeScript errors. Deployment is **not** Vercel; see `AGENTS.md` and `docs/DEPLOYMENT.md` for the GCP VM deployment process.

## Architecture

Wherebear turns shelf photos into a multilingual, searchable aisle index. Two user flows are streamed to the UI as **Server-Sent Events** so each step and its MongoDB call are visible live.

### Flow 1 - Snap-to-memory (write path)

1. `POST /api/vision` calls `detectAndIdentifyProducts` in `lib/gemini.ts`: a **two-stage** Gemini vision pipeline. Stage 1 detects SKU bounding boxes, `sharp` crops them, and Stage 2 batch-identifies each crop. The endpoint returns products and 240px thumbnail data URLs.
2. The client edits the list, picks an aisle, then calls `POST /api/shelf-evidence`, which invokes `saveShelfDirect` in `lib/shelf-save.ts`. The critical path performs one indexed `find` and one `bulkWrite` upsert into `products`, then `enhanceShelfBackground` expands Chinese aliases after the SSE closes and refreshes `search_text`, which Atlas auto-embeds.

`lib/agents/agent-a.ts` and `lib/agents/tools-a.ts` contain the superseded LLM-loop version of this flow. The live write path is `lib/shelf-save.ts`.

### Flow 2 - Find-the-aisle (search path)

`POST /api/search` calls `runAgentBAdk` in `lib/agents/adk/run-search.ts`. A Google ADK `LlmAgent` (`@google/adk`) drives Gemini function calling over three app FunctionTools (`understand_intent`, `vector_search`, and `suggest_by_category` in `lib/agents/adk/tools.ts`) and the MongoDB MCP server mounted as an ADK `MCPToolset` in `lib/agents/adk/search-agent.ts`.

The adapter translates ADK events back into the existing `AgentEvent` shape and reuses `synthesizeFinish` from `lib/agents/tools-b.ts` for keep/guess/discard bucketing and the bilingual answer, so the SSE contract and UI remain unchanged. Every search is logged to `search_history` for the `/searchlog` feedback UI.

- The legacy hand-rolled pipeline (`runAgentB` in `lib/agents/agent-b.ts`) remains behind `SEARCH_ENGINE=legacy` as a one-line demo rollback. The ADK path is the default and canonical compliance path.
- ADK's `Runner.runEphemeral({ newMessage })` requires `newMessage.role === 'user'`. Without it, Gemini drops the content and never sees the query. See the comment in `run-search.ts`.

### Data layer

- **Direct driver** (`lib/mongodb.ts` `getDb()`): hot paths including `saveShelfDirect`, `/api/health`, `/api/activity`, and candidate enrichment.
- **MCP layer** (`lib/mcp/mongo-mcp.ts`, `mongo-ops.ts`): wraps `mongodb-mcp-server` as a stdio child process with direct-SDK fallback. The search agent's `vector_search` and `log_search` use this layer, and the ADK search agent also mounts the server as an `MCPToolset`.
- **Vector search** uses Atlas `autoEmbed` (`voyage-4-large`) on `products.search_text`. Embeddings are managed by Atlas. The index is named `vector_index`.

### Vision and LLM configuration

- The default model is `gemini-3.5-flash` through Vertex AI.
- The location is hardcoded to `global` because Gemini 3.x is unavailable through the VM's configured regional endpoint.
- `generateContentWithRetry` uses exponential backoff on 429, 503, and 500 responses.
- Vision and search calls use minimal thinking for latency.

## Gotchas

- **Customized Next.js 16**: APIs differ from earlier versions. Read `node_modules/next/dist/docs/` before changing route or configuration conventions.
- **MCP is a child process**: the app requires a long-lived Node host and cannot run on a serverless deployment.
- **Thumbnails are stored inline** in `products` as 240px JPEG data URLs. At larger product counts, check `db.stats()` before assuming Atlas M0 has enough headroom.
- Components are inline-styled with tokens from `lib/theme.ts`; there is no CSS module or styled-components layer.
