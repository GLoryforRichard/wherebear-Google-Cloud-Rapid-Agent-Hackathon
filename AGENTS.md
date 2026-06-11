<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Agent orchestration — Google ADK is the canonical path

The "find the aisle" search agent runs on the **Google Agent Development Kit** (`@google/adk`), code-first path of Google Cloud Agent Builder. This is the compliant orchestration for the Rapid Agent Hackathon and the default at `/api/search`. The legacy hand-rolled pipeline is only kept behind `SEARCH_ENGINE=legacy` for one-line rollback during demos.

- ADK agent definition: `lib/agents/adk/search-agent.ts` — single `LlmAgent` with Vertex Gemini (`location:'global'`), three FunctionTools, and MongoDB MCP mounted as `MCPToolset` (stdio, reuses the same `mongodb-mcp-server@1.10.0` config as `lib/mcp/mongo-mcp.ts`).
- Tool params use **`@google/genai` Schema** (not zod) — ADK ships its own `zod@4` while the app uses `zod@3`, so a zod object built against the app's zod fails ADK's internal `instanceof` checks. genai Schema is a plain object and survives the version boundary.
- When mounting any new MCP server as a toolset, **narrow the tool allow-list**. A wide-open toolset lets the agent "browse the database" with `list-collections` / `find` instead of using domain tools like `vector_search`.
- `Runner.runEphemeral({ newMessage })` requires **`role: 'user'`** on the message. Without it Gemini drops the content and the agent replies "what are you looking for?".

Do NOT introduce LangChain, LangGraph, LlamaIndex, or any other third-party agent orchestrator — they are explicitly disallowed by the hackathon rules.

# Deployment — GCP VM, NOT Vercel

**Do NOT use Vercel for this project.** The user's global preference says "deploy to Vercel" — that does not apply here. This project runs on a Google Compute Engine VM behind Caddy + PM2.

- Live: <https://wherebear.help>
- VM: `wherebear-vm`, zone `northamerica-northeast2-b`
- Pushing to GitHub `main` does NOT auto-deploy — you must SSH in and rebuild.

**One-shot deploy command** (run from local Mac after `git push`):

```bash
gcloud compute ssh wherebear-vm --zone=northamerica-northeast2-b \
  --command "cd ~/wherebear && git pull && npm install && npm run build && pm2 restart wherebear"
```

Full infra map, secrets, rollback, logs: see `docs/DEPLOYMENT.md`.
