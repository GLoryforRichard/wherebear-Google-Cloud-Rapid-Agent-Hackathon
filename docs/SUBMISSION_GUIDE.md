# Wherebear — Devpost 提交指导(Rapid Agent Hackathon · MongoDB track)

> 截止:**2026-06-11 14:00 PT**(太平洋时间)。北京时间 = 6/12 05:00,加拿大东部(EDT)= 6/11 17:00。
> 规则原文:https://rapid-agent.devpost.com/rules

---

## 0. ⚠️ 先确认两件「能不能交」的硬门槛

1. **居住国资格**:规则明确把 **China(中国大陆)等国列为 ineligible**(不可参赛)。表单里有 *Submitter Country of Residence* 和 *if reside in Canada, province*。
   - 你的部署、VM、域名都在加拿大。**如果你本人(及队友)居住国是加拿大或其它合格国家 → 没问题**,如实填。
   - **如果居住国是中国大陆 → 不符合资格**,提交会在 Stage 1 被刷。这点只有你自己能判断,先确认。
2. **新项目**:规则要求项目在 Contest Period(2026-05-05 之后)新建、原创。Wherebear 是这期间做的 → 选 **New**。

> 其余资格(成年、非政府雇员、非 Google/Partner 员工、team ≤ 4 人)按实际如实填即可。

---

## 1. 四大必交物料 + 当前状态

| # | 物料 | 规则要求 | 当前状态 |
|---|---|---|---|
| 1 | **Hosted Project URL** | 公开可测试 | ✅ https://wherebear.help(顾客搜索无需登录) |
| 2 | **Public Repo + OSI License** | 公开 + license 在 About 可见 | ✅ PUBLIC + MIT(已确认) |
| 3 | **Text Description** | 功能/技术/数据源/心得 | ✍️ 文案见 §3(直接复制) |
| 4 | **Demo Video ≤ 3:00** | YouTube/Vimeo 公开、英文或英文字幕、展示运行 | ⏳ 待录(脚本见 DEMO_SCRIPT.md) |

**Stage 1 通过条件(Pass/Fail)**:含全部物料 + 合理回应挑战 + **用了 Google Cloud 产品**(Vertex AI ✅)+ **用了所选 Partner 产品**(MongoDB ✅)。
**Stage 2 评分(四项等权)**:技术实现 / 设计 / 潜在影响 / 创意。每项都要在视频+文案里讲到。

---

## 2. 提交流程 — 五个 Tab 逐步走

Devpost 顶部进度条:**Manage team → Project overview → Project details → Additional info → Submit**。逐个填,每页底部 **Save & continue**。

### Tab 1 · Manage team
- 确认队伍成员(≤4 人)。单人就只有自己。已显示 ✅。

### Tab 2 · Project overview(公开页)
- **Project name** → 见 §3.1
- **Elevator pitch**(≤200 字符)→ 见 §3.2
- **Thumbnail**:点 Edit thumbnail 上传一张方图(建议 wherebear 橙色首页截图,或熊 logo)。3:2、≤5MB。

### Tab 3 · Project details(公开页)
- **About the project**(Markdown)→ 见 §3.3(整段复制)
- **Built with**(技术标签)→ 见 §3.4
- **"Try it out" links** → §3.5
- **Image gallery**:传 3–5 张截图(首页 / 搜索结果 / 拍货架识别 / Dashboard / Agent thinking 面板)
- **Video demo link**:YouTube/Vimeo 链接(录完填)

### Tab 4 · Additional info(给评委,不公开)
- 逐字段见 §3.6

### Tab 5 · Submit
- 检查 §4 清单 → 正式提交。**Draft 状态不算提交**,务必走到 Submit 并确认。

---

## 3. 逐字段文案(全部英文 — 规则要求 written parts 必须英文)

### 3.1 Project name
```
Wherebear
```

### 3.2 Elevator pitch（≤200 chars）
```
Snap a shelf, ask in any language, get an aisle-level answer. Wherebear turns shelf photos into a multilingual, searchable store memory — powered by MongoDB Atlas Vector Search + the MongoDB MCP Server.
```

### 3.3 About the project（Markdown，整段复制到 "About the project"）

```markdown
## Inspiration
Every multilingual grocery store runs on knowledge that only lives in a few
employees' heads. Customers ask in mixed languages, misspell brands, or just
describe things — "the black paper for sushi", "韩式年糕", "samyang noodle".
New staff can't help; senior staff get pulled off the floor. Nobody has time
to hand-maintain a product database with SKUs.

Wherebear's bet: workers won't enter data, but they *will* snap a photo when
they're already walking past a shelf. Turn those photos into a multilingual,
semantically searchable index and the store quietly builds its own memory.

## What it does
Two flows, both streamed live to the screen so every database call is visible:

- **Snap a shelf (write):** take/upload a shelf photo. A two-stage Gemini 3.5
  Flash vision pass detects every product's bounding box, crops each one, and
  batch-identifies them. The worker picks an aisle and saves. In the
  background the system expands each product into multilingual aliases
  (English / 中文 / 한국어 / 日本語 / romanized / common misspellings) and
  refreshes the searchable text, which MongoDB Atlas auto-embeds.
- **Find the aisle (search):** the worker types the question exactly how the
  customer asked — `年糕`, `そば`, `samyang`, `the spicy red paste`. A
  **Google ADK `LlmAgent`** (code-first path of Google Cloud Agent Builder)
  understands the language and intent via Gemini function-calling, rewrites
  the query, runs a **hybrid retrieval** (Atlas Vector Search + Atlas Search
  lexical/fuzzy, fused with Reciprocal Rank Fusion), then synthesizes a
  bilingual answer: "It should be in Aisle 4 · 应该在 4 号过道。" The agent
  also has the **MongoDB MCP server mounted as an ADK `MCPToolset`** — so
  every retrieval is a real ADK ↔ partner-MCP interaction.

A live **agent-thinking panel** streams each step as a Server-Sent Event, with
a blue **MCP** pill whenever a call went through the MongoDB MCP Server — so
"agent, not chatbot" is something judges can literally watch happen.

## How we built it
- **Google Cloud Agent Builder — Agent Development Kit (`@google/adk`):**
  the "find the aisle" agent is a code-first ADK `LlmAgent` that drives
  Gemini function-calling over three domain FunctionTools
  (`understand_intent` / `vector_search` / `suggest_by_category`) plus the
  MongoDB MCP server mounted as an ADK `MCPToolset` — so the agent talks to
  Atlas natively through the Model Context Protocol.
- **Google Cloud — Vertex AI (Gemini 3.5 Flash):** powers both the two-stage
  shelf vision and the ADK search agent. Thinking budget is disabled and
  detection runs concurrently for low latency.
- **Google Cloud — Compute Engine:** a long-lived Node host (Caddy + PM2)
  serves the app and spawns the MongoDB MCP subprocess — something serverless
  can't do.
- **MongoDB Atlas Vector Search with autoEmbed (voyage-4-large):** we never
  compute an embedding ourselves; Atlas embeds each product's alias string on
  write and the query on read.
- **MongoDB Atlas Search:** the lexical/fuzzy leg of hybrid search, catching
  brand typos the vector neighbour misses.
- **MongoDB MCP Server (`mongodb-mcp-server`):** the agent talks to Atlas
  through the official MCP server over stdio; the UI shows an MCP pill on
  those calls.
- **Frontend:** Next.js 16 (App Router, TypeScript), inline-styled
  neo-brutalist UI, Server-Sent Events for the live agent panel.

## Challenges we ran into
- **Gemini 3.x region quirk:** it 404s on `us-central1`; we pin `location =
  'global'` on Vertex AI.
- **Hybrid search that can't break:** the Atlas Search leg fails open — if the
  text index isn't built it silently degrades to vector-only, so search never
  errors.
- **MCP runs as a subprocess:** great for the "agent talks to MongoDB via MCP"
  story, impossible on Vercel — so we host on a Compute Engine VM.
- **Inline thumbnails vs the M0 512 MB ceiling:** product thumbnails are
  stored inline as 240px data URLs; we cap size and watch `db.stats()`.

## Accomplishments we're proud of
- A real two-flow agent system over **13,000+** real products already indexed.
- MCP integration the judges can *see* lighting up, not just read about.
- Bilingual answers with zero per-language code — the prompt just says
  "answer in the user's language".
- Hybrid (vector + lexical) retrieval that fixes the classic typo failure.

## What we learned
- Atlas autoEmbed is the right abstraction for hackathon speed — skipping the
  embedding step saved days.
- Streaming agent steps to the UI matters more for a 3-minute demo than raw
  model quality; watching the panel fill is the moment it reads as an agent.
- Reciprocal Rank Fusion is a tiny amount of code for a big recall win.

## What's next
- A Voyage reranker pass for top-1 accuracy.
- A confidence heuristic that suggests "snap this aisle" when nothing matches.
- Photo-level history so historical shelf evidence keeps its thumbnails.
```

### 3.4 Built with（标签，逗号分隔）
```
next.js, typescript, google-adk, agent-development-kit, agent-builder, vertex-ai, gemini, google-compute-engine, mongodb-atlas, atlas-vector-search, atlas-search, mongodb-mcp-server, model-context-protocol, voyage-ai, server-sent-events, sharp, caddy, pm2
```

### 3.5 "Try it out" links
```
https://wherebear.help
https://github.com/GLoryforRichard/wherebear-Google-Cloud-Rapid-Agent-Hackathon
```

### 3.6 Additional info（评委可见,不公开）

| 字段 | 怎么填 |
|---|---|
| **What Google Cloud products did you use?** | `Google Cloud Agent Builder — Agent Development Kit (@google/adk, code-first TypeScript): the "find the aisle" agent is an ADK LlmAgent that drives Gemini function-calling over domain FunctionTools and a mounted MongoDB MCPToolset. Vertex AI (Gemini 3.5 Flash, location=global): powers both the two-stage shelf-photo vision (detect → crop → batch-identify) and every step of the ADK search agent. Google Compute Engine: a long-lived VM (Caddy + PM2) that serves the Next.js app and spawns the MongoDB MCP server subprocess that ADK's MCPToolset connects to.` |
| **Please list all other tools/products** | `MongoDB Atlas (M0); Atlas Vector Search with autoEmbed (voyage-4-large); Atlas Search (lexical/fuzzy leg of hybrid search); MongoDB MCP Server (mongodb-mcp-server, mounted via ADK MCPToolset over stdio); Voyage AI embeddings (via Atlas autoEmbed); Next.js 16; TypeScript; sharp; Caddy; PM2.` |
| **First time using Arize / Elastic / Fivetran / GitLab / Dynatrace tools?** | 这些 track 没用 → 选 **No / Not applicable**(如实，按下拉选项选「No」或最接近「未使用」的项） |
| **First time using MongoDB tools?** | 按你真实情况选 Yes/No |
| **Submitter Type** | 按实际(Individual / Team / Student 等下拉选) |
| **Organization name** | 没有就填 `N/A` |
| **Government employee?** | 如实(应为 No) |
| **Submitter Country of Residence** | **如实**(见 §0 资格) |
| **Canada province** | 居加拿大填省份,否则 `N/A` |
| **Which partner track?** | **MongoDB** |
| **New or existing prior to May 5, 2026?** | **New** |
| **Open source repo URL** | `https://github.com/GLoryforRichard/wherebear-Google-Cloud-Rapid-Agent-Hackathon` |
| **Hosted Project URL** | `https://wherebear.help` |

---

## 4. 提交日最终检查清单

- [ ] §0 资格(居住国)已确认 OK
- [ ] repo 仍是 **Public**,About 显示 **MIT**
- [ ] wherebear.help 打得开、能搜出结果(评委会实测)
- [ ] 视频已传 YouTube/Vimeo 且**必须设为 Public**(规则原文 "publicly visible"、官方 checklist "set to public"——**Unlisted/Private 都不合规**),≤3:00,英文/英文字幕。⚠️ 新 YouTube 频道传 demo 有被误封先例(论坛 44006,申诉失败)→ **尽早上传 + 同步传一份 Vimeo 备份**
- [ ] 五个 Tab 全部 Save,Image gallery 有图,Video link 已填
- [ ] **走到 Submit 并确认**(Draft 不算交!顶部应从 DRAFT 变为已提交)
- [ ] 截止前留 ≥2 小时缓冲(网络/上传/最后修改)

---

## 5. 视频

见 `docs/DEMO_SCRIPT.md`（已对齐当前实现:两阶段视觉 / 混合搜索 / 橙色 UI / 真实数据 / MCP pill / 双语）。
