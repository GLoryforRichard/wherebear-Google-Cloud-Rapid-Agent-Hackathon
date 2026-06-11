# Wherebear 🐻

> **Wherebear knows where.**
>
> A store-memory assistant that turns casual shelf photos into a searchable, multilingual aisle index — built for grocery workers who keep getting asked "where can I find this?"

Submission for the **Google Cloud Rapid Agent Hackathon** — **MongoDB track**.

🌐 **Live demo:** [wherebear.help](https://wherebear.help)

---

## Why

Every multilingual grocery store has knowledge that only lives in employees' heads. Customers ask in mixed languages, misspell brands, or describe things ("the black paper for sushi"). New employees can't help. Existing employees get interrupted. Nobody has time to maintain a real product database.

Wherebear lets a worker:
1. **Snap a shelf** when they're already walking past one.
2. **Search any way the customer asked** — typo, mixed language, description, brand.
3. **Get an aisle-level answer in the customer's language.**

The system builds itself by reading shelves. No data entry, no SKUs.

---

## What makes this an agent, not an app

This is the part the hackathon judges care about. Two autonomous agents drive the experience:

- **Agent A** (write flow): given products detected on a shelf, plans tool calls to look up each item, generate multilingual aliases for new ones, save them, and record evidence. It picks the order and which tools to skip.
- **Agent B** (search flow): given a customer query, understands the language and intent, runs a vector search, logs the query, and answers in the worker's language.

Both agents are real Gemini function-calling loops. Every tool call streams to the UI as a Server-Sent Event, so the worker (and the demo viewers) can see the agent's plan unfold in real time — including how long each step took and which steps went through MongoDB MCP.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  Next.js (App Router)                                                  │
│                                                                        │
│  ┌──────────────┐    ┌────────────────┐    ┌─────────────────────┐    │
│  │ SnapScreen   │ ─► │ Vertex AI      │    │ Agent A             │    │
│  │ (camera UI)  │    │ Gemini Vision  │ ─► │ (function calling)  │    │
│  └──────────────┘    └────────────────┘    └─────────┬───────────┘    │
│                                                      │ SSE             │
│                                                      │ tool calls      │
│  ┌──────────────┐                          ┌─────────▼───────────┐    │
│  │ FindScreen   │ ─────────────────────► │ Agent B             │    │
│  │ (search UI)  │                          │ (function calling)  │    │
│  └──────────────┘                          └─────────┬───────────┘    │
│                                                      │                  │
│                                            ┌─────────▼──────────────┐  │
│                                            │ MongoDB MCP Client     │  │
│                                            │ (@modelcontextprotocol)│  │
│                                            └─────────┬──────────────┘  │
└──────────────────────────────────────────────────────┼─────────────────┘
                                                       │ stdio
                                          ┌────────────▼────────────┐
                                          │ mongodb-mcp-server      │
                                          │ (npx subprocess)        │
                                          └────────────┬────────────┘
                                                       │
                                          ┌────────────▼────────────┐
                                          │ MongoDB Atlas           │
                                          │ • shelf_evidence        │
                                          │ • products  (vector idx)│
                                          │ • search_logs           │
                                          └─────────────────────────┘
```

Atlas Vector Search is configured with `autoEmbed` against `voyage-4-large`, so neither the agent nor our backend code has to manage embeddings — every product alias string is embedded and indexed automatically.

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 App Router, TypeScript, DM Sans, inline-styled components matching a custom design |
| Vision | Vertex AI Gemini 3.5 Flash (two-stage detect → identify; uses Google Cloud credits, not AI Studio) |
| Agent loop | Gemini function calling, custom SSE streaming |
| Database | MongoDB Atlas M0, Vector Search with autoEmbed (`voyage-4-large`) |
| **MongoDB integration** | **`mongodb-mcp-server` via `@modelcontextprotocol/sdk`** |

---

## Tools each agent exposes to Gemini

**Agent A — store memory writer**

| Tool | What it does | Goes through MCP? |
|---|---|---|
| `find_existing_product(canonical_name)` | Look up product by name | ✅ MCP `find` |
| `expand_aliases(canonical_name, category?)` | LLM-generate multilingual aliases (EN / 中 / 한 / 日 / romanized / misspellings) | — (Gemini sub-call) |
| `save_product(canonical_name, aliases, category, aisle)` | Upsert into `products`, bump `evidence_count` | ✅ MCP `find` + `update-many` / `insert-many` |
| `record_shelf_evidence(aisle, products_detected)` | Insert one row into `shelf_evidence` | ✅ MCP `insert-many` |
| `finish(summary)` | Stop the loop | — |

**Agent B — find-the-aisle**

| Tool | What it does | Goes through MCP? |
|---|---|---|
| `understand_intent(query)` | LLM classifies language, kind (typo/description/standard), rewrites | — (Gemini sub-call) |
| `vector_search(query_text, limit?)` | Atlas Vector Search via autoEmbed | ✅ MCP `aggregate` |
| `log_search(original_query, resolved_intent, results_found)` | Insert into `search_logs` | ✅ MCP `insert-many` |
| `finish(product, answer)` | Return final answer in worker's language | — |

The UI surfaces a small monospace **MCP** pill next to every step whose result came back via MongoDB MCP Server, so the integration is visible on screen.

---

## Try the demo flows

### Find item — no login needed

1. Open [wherebear.help](https://wherebear.help) → tap **Find item**.
2. Search the way a customer would ask, in **any language**. All of these are real indexed products — try:
   - `老干妈` — Chinese brand name
   - `gochujang` — romanized Korean
   - `鱼露` — Chinese query that finds English-named products (cross-language)
   - `wrapper for spring rolls` — pure description, no product name
   - `oister sauce` — misspelled on purpose (fuzzy/lexical leg of hybrid search)
3. Watch the **Agent thinking** panel stream each tool call — the blue **MCP** pill marks calls that went through the MongoDB MCP Server. The answer comes back bilingually: "It should be in Aisle 4 · 应该在 4 号过道。"

### Snap a shelf — staff side (judge access)

1. Scroll to the bottom of the home page → **Staff workspace** → passcode **2627** (the passcode is also shown on the lock screen).
2. Tap **Snap shelf**. No grocery shelf around? Tap **"No shelf around? Try a sample photo"** — it loads a real photo of our shelf B10 and selects that aisle automatically.
3. Wait 5–10 s while the two-stage Gemini Vision pass detects every product. Review the list (tap × to drop wrong ones), then **Save to memory**.
4. The **Agent thinking** panel walks each product through `find_existing_product` → `expand_aliases` → `save_product`, with **MCP** pills marking every database call. Saving the sample photo is safe — it just re-saves the same shelf (B10). Product edit/delete in the admin list is sandboxed on this public deployment.

The **DB DEBUG** link at the bottom of the home screen opens `/debug`, which renders the raw contents of the MongoDB collections. Useful for in-store testing on a phone where you can't open Compass.

---

## Local setup

You need:

- Node 20.19+
- A MongoDB Atlas cluster with a database called `wherebear` and a Vector Search index named `vector_index` on `products.search_text` (autoEmbed, `voyage-4-large`, plus a `filter` field on `latest_aisle`)
- Optional but recommended: the lexical/fuzzy leg of hybrid search needs an Atlas Search index named `text_index` — create it with `node --env-file=.env.local scripts/create-search-index.mjs` (additive and fail-open; search degrades to vector-only without it)
- A Google Cloud project with **Vertex AI API** enabled and a service-account JSON saved as `gcp-key.json`

`.env.local`:

```env
MONGODB_URI=mongodb+srv://USER:PASS@your-cluster.../wherebear?retryWrites=true&w=majority
MONGODB_DB=wherebear

GOOGLE_CLOUD_PROJECT=your-gcp-project-id
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=./gcp-key.json
```

Then:

```bash
npm install
npm run dev
```

Open http://localhost:3000.

> **Heads-up:** the MongoDB MCP server is launched as a child process from the API route via `npx mongodb-mcp-server`. This works in `next dev` and in self-hosted Node. It won't work on Vercel serverless — you'd need to run it on a long-lived host or swap the stdio transport for a hosted MCP gateway.

---

## Repo layout

```
app/
├── api/
│   ├── activity/      # GET — merged shelf_evidence + search_logs feed
│   ├── debug/         # GET — raw dump of all collections
│   ├── health/        # GET — DB connectivity check
│   ├── search/        # POST — Agent B (SSE)
│   ├── shelf-evidence/# POST — Agent A (SSE)
│   └── vision/        # POST — Gemini Vision standalone call
├── debug/             # /debug raw JSON page (handy on a phone)
└── page.tsx           # screen state machine for the SPA
components/            # all UI components, inline-styled
lib/
├── agents/            # Agent A + B loops, tool declarations + executors
├── mcp/               # MCP client + ergonomic mongo ops
├── gemini.ts          # Vertex AI client
├── mongodb.ts         # SDK client (used by /api/activity and /api/health)
├── theme.ts           # Meadow color tokens
└── types.ts           # collection schemas
```

---

## License

MIT
