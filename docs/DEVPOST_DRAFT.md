# Devpost submission draft

> ⚠️ **SUPERSEDED (2026-06-11)** — do NOT paste from this file. The canonical, up-to-date copy for every Devpost form field is **`SUBMISSION_GUIDE.md` §3**. Known stale bits here: references the removed 👍/👎 feedback UI and `/searchlog` feedback, and the old sample-chip search words (the verified demo words live in `DEMO_SCRIPT.md`).

Use this as a starting point — tweak voice / length to taste before pasting into the submission form.

---

## Project name
Wherebear

## Tagline (one line, ~120 chars)
The store memory bear. Snap a shelf, ask in any language, get an aisle-level answer through MongoDB MCP.

## Elevator pitch (2–3 sentences for the listing card)
Wherebear is a multilingual store-memory assistant for grocery workers. Two flows — one turns casual shelf photos into a searchable product index, one is a Google ADK agent that answers customer questions in the asker's language, with the official MongoDB MCP Server mounted as its toolset.

---

## Try it (for judges)

Live at **https://wherebear.help** — no account needed.

1. **Find item** (home page): tap a sample query chip (`年糕`, `可乐`, `samyang`, `spicy noodle`) or type your own, in any language. Watch the agent panel stream each tool call — the blue **MCP** pill marks MongoDB MCP calls.
2. **Snap shelf**: tap **Staff workspace** at the bottom (passcode **2627**, shown on screen) → Snap shelf → tap **"No shelf around? Try a sample photo"**. It loads a real photo of our shelf B10, selects that shelf automatically, and runs the two-stage Gemini vision pipeline — no shelf knowledge needed.
3. `/debug` shows the raw MongoDB collections; `/searchlog` shows real search history with feedback.

## Inspiration

Anyone who's worked in an Asian or international grocery store knows the rhythm: customer walks up, mispronounces something, mixes English and their first language, or just describes the item ("the black paper for sushi", "韩式年糕", "samyung noodle"). Half the time the worker has to leave whatever they were doing to walk the aisles. The other half they apologetically say "I don't know."

The knowledge exists — it lives in one or two senior employees' heads. It just isn't searchable.

Wherebear's hypothesis: workers won't maintain a product database, but they will snap a photo when they're already walking past a shelf. If we can turn those photos into a multilingual, semantically searchable index, the store builds its own memory.

## What it does

For grocery workers, two screens:

- **Snap shelf**: take or upload a photo. A two-stage Gemini Vision pass detects every product (Stage 1 finds bounding boxes, Stage 2 batch-identifies each crop), displayed as a reviewable list with category and confidence. Pick an aisle, hit Save — the write lands in MongoDB in a few hundred milliseconds. Then a background Gemini agent expands each new product into multilingual aliases (English / Chinese / Korean / Japanese / romanized / common misspellings / descriptive phrases) and refreshes its `search_text`, which Atlas auto-embeds.
- **Find item**: type how the customer asked — `年糕`, `そば`, `samyung`, `the spicy red paste`. A **Google ADK `LlmAgent`** (`@google/adk`, code-first path of Google Cloud Agent Builder) drives Gemini function-calling to understand intent, rewrite the query, run a hybrid Atlas search (Vector + lexical/fuzzy, RRF-fused), and answer bilingually. The MongoDB MCP server is mounted on the agent as an ADK `MCPToolset`, so every database touch is a real ADK ↔ partner-MCP call. "应该在Aisle 7." / "It should be in Aisle 4."

Both flows render a live **Agent thinking** panel that streams each tool call as it happens. Each row shows the call duration in milliseconds and a blue **MCP** pill when MongoDB MCP was the path. This is how we make "agent, not chatbot" visible.

## How we built it

**Stack:** Next.js 16 (App Router, TypeScript), Google ADK (`@google/adk`) for search-agent orchestration, Vertex AI Gemini 3.5 Flash (location=global), MongoDB Atlas with Vector Search + autoEmbed (voyage-4-large), `mongodb-mcp-server` mounted via the ADK `MCPToolset` (and accessed by domain code via `@modelcontextprotocol/sdk` stdio).

**Architecture:** the search agent is a code-first ADK `LlmAgent` with three FunctionTools (`understand_intent` / `vector_search` / `suggest_by_category`) plus a MongoDB `MCPToolset`. ADK's `Runner` drives Gemini function-calling; we translate ADK events back into our existing SSE `AgentEvent` shape so the UI stays unchanged. Database calls go Gemini → ADK tool dispatch → either an app FunctionTool (which routes through our MCP client for `vector_search`) or the mounted MongoDB MCPToolset → `mongodb-mcp-server` subprocess → MongoDB Atlas. The MCP server is spawned once per Node process and cached globally across requests.

**Streaming:** both agent endpoints (`/api/shelf-evidence` and `/api/search`) are Server-Sent Events. We emit a typed `AgentEvent` for each `plan_start`, `tool_call`, `tool_result`, `agent_message`, `done`, or `error`. The frontend renders these directly as the thinking-panel rows.

**autoEmbed:** instead of generating embeddings ourselves, we let MongoDB Atlas Vector Search call Voyage AI for us. The `search_text` field on every product is just a `·`-joined list of aliases — Atlas embeds it on write, and embeds the query on read. We never see a vector.

## Data sources

No third-party datasets. Every product in the index comes from shelf photos taken in a real store: Gemini Vision identifies the products, workers review the list, and the multilingual aliases are generated by Gemini at save time. Search feedback (👍/👎 on results) is collected in-app and stored alongside the search logs.

## Challenges we ran into

- **MongoDB MCP autoEmbed signature.** The MCP server's `aggregate` tool accepts `$vectorSearch` with either an explicit `queryVector`, or `query: { text, model }` (which makes MCP itself call Voyage AI), or `query: "string"` (which uses the index's autoEmbed config). The middle path tripped us up — it requires Voyage AI billing on a separate account. We landed on `query: "<text>"` so the embedding stays inside Atlas.
- **ADK + Gemini's silent `role` requirement.** `Runner.runEphemeral({ newMessage: { parts: [{ text: query }] } })` looks right but the agent kept replying "what are you looking for?" without calling any tool. Reading the Runner source showed our message was appended as a user event verbatim — and Gemini silently drops content without `role: 'user'`. One field fixed it.
- **ADK toolset scope matters.** Mounting the MongoDB MCPToolset with `find` and `list-collections` exposed let the LLM "browse the database" instead of using our `vector_search` tool. We narrowed the MCP allow-list and rewrote the agent instructions to be explicit ("`vector_search` is the only correct way to locate a product") to keep the agent on the right path.
- **Vercel serverless can't spawn subprocesses.** That's how MCP servers are typically run. We document this clearly: the demo runs on a long-lived Node host. A future path is a hosted MCP gateway.
- **Avoiding prompt injection from MCP output.** The MongoDB MCP Server wraps results in `<untrusted-user-data-…>` tags. We strip those before parsing.

## Accomplishments

- A real, populated store memory: **13,000+ products** indexed from **150+ shelf snapshots**, built entirely by snapping photos — no manual data entry.
- An ADK agent with non-trivial planning, not a glorified prompt — and a visible MCP integration that judges can literally see lighting up on screen.
- Bilingual responses without any per-language code — the agent prompt just says "answer in the user's language".
- Sub-second shelf saves: the hot path is one indexed `find` + one `bulkWrite`, with alias expansion moved to a background agent so workers never wait on an LLM.
- A debug page that renders the raw contents of every MongoDB collection, intended for in-store testing on a phone.

## What we learned

- Atlas autoEmbed is the right level of abstraction for hackathon-scale apps. Skipping the explicit embedding step shaved a whole day off the plan.
- Streaming agent steps to the UI matters more than agent quality for a 3-minute demo video. Watching the panel fill with `expand_aliases` chips is the moment the project becomes obviously an agent.
- A small monospace pill is enough UI to communicate an architectural decision (the MCP one).

## What's next

- Photo storage so historical evidence keeps thumbnails (skipped for MVP).
- A confidence threshold heuristic for Agent B that recommends "snap this aisle" when no match crosses 0.5.
- Hosted MCP gateway so the deploy story works on Vercel.
