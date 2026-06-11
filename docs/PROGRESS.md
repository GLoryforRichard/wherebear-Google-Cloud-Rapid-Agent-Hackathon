# Wherebear 进度记录

**最后更新**：2026-06-09
**线上地址**：<https://wherebear.help>
**部署**：GCP VM (`wherebear-vm`, `northamerica-northeast2-b`) + PM2 + Caddy
**比赛**：MongoDB AI Agents Hackathon (Rapid Agent)

---

## 当前状态总览

| 模块 | 状态 |
|---|---|
| 拍照识别（两阶段视觉） | ✅ 上线 — Gemini 3.5 Flash;评委示例照 ~17s,密集整面货架 ~27-33s |
| 寻找商品（ADK 搜索 agent） | ✅ 上线 — ADK LlmAgent + MCPToolset;搜索 2.5-3.2s,工具步 <500ms |
| Hybrid Search | ✅ 上线 — `text_index` 已建,$vectorSearch + $search RRF 融合生效 |
| 货架地图 UI | ✅ 上线 — SVG 互动地图 (A/B 主货架 + C 中央区) |
| 管理后台 | ✅ 上线 — /admin 增删改,已统一为应用主题风格 |
| 评委体验 | ✅ 上线 — 示例查询 chips、B10 示例照一键 Demo(锁货架)、演示密码公示 |
| 部署 | ✅ 上线 — GCP VM,启动自动预热(agent/MCP/Vertex) |
| MongoDB MCP | ✅ 上线 — agents 通过 MCP 走 Atlas (有 SDK fallback) |
| Vector Search | ✅ 上线 — voyage-4-large autoEmbed |

**Pending**：demo 视频、Devpost 提交（仅剩这两项,均为用户操作）。

> ✅ 已完成：演示数据（1 万+ 真实商品入库）、两阶段视觉管线（detect→切图→批量 identify，见 `lib/gemini.ts`）。

---

## 2026-06-09 会话（提交前冲刺：合规对齐 + 性能大修 + 评委体验）

### 性能大修（搜索 8-15s→2.5-3.2s;识别 200s+→17-33s,详见 dev-issues-log.md §11.5）

- `c572ba0` **ADK MCPToolset 子进程风暴修复**：`getTools()` 每个 LLM 回合 spawn 一个新 `npx mongodb-mcp-server`(曾两次卡死 VM)→ 缓存工具列表 + 直接 exec 本地二进制。
- `7c2067f` **Gemini 3.x thinking 真关闭**：`thinkingBudget:0` 在 3.x 上被静默忽略,全部换 `thinkingLevel: MINIMAL`——单点最大提速(vision stage2 152s→10s)。
- `66dde86` **搜索结构精简**：understand_intent 改纯 JS 语言检测;agent 协议改为首回合并行双工具 + 只回 DONE(3-4 回合→2);synthesizeFinish 与收尾回合并行。
- `c144183`/`d510ba0`/`9fd3363` **DSQ 配额适配**:stage2 打包成 ≤2 个大请求、全局 Gemini 并发 ≤4、15s hedge 对冲"静默停车"长尾。
- `0b08db4` **stage1 输出减半**(去掉 label 字段);sharp 裁剪改"解码一次复用"(35s→0.8s);密集货架框数上限 56。
- `1b4f226`(后续) **启动预热**:`instrumentation.ts` 启动即热 agent/MCP/Mongo/Vertex,评委首搜不吃冷启动。

### 合规与评委体验

- `cbc43ef` **Devpost 文案对齐现实**(删 Agent A 旧描述、补 data sources、硬数字)+ Find 页示例查询 chips + dev-issues-log 入库。
- **B10 示例照一键 Demo**:真实 B10 货架照(HEIC 转码裁剪),点击自动选中并锁定 B10,防止评委弄脏其他货架数据;Staff 入口醒目化 + 演示密码 2627 公示(首页 + 锁屏)。
- **Staff 区整理**:Shelf admin 统一应用主题(原粉色杂牌风);Dashboard / Search history 全英文;DB debug 入口移除;EN 模式结果只显示英文。

### UI 品牌化

- `583bdc7` 首页字标(双色 Where|bear + 马克笔下划线 + 熊贴纸徽章);后续推广到 Find / Staff 头部(变体不重复);chips 贴纸化;工作台 emoji 换线性图标;搜索空白期小熊加载动画;结果卡 70ms 级联渐进展现。

### 基础设施

- VM 两次卡死均已根治(见上);billing 已确认健康(200 CAD/年预算告警);Budget API 已启用。

---

## 2026-06-02 会话（按提交时间）

### 拍照存货流程（Agent A）

- `f124ed8` **批量工具调用**：用 `find_existing_products` + `save_products` 替代单条版本，~15 次 generateContent → ~4 次。
- `a615465` **Gemini 3 升级**：模型切到 `gemini-3.5-flash`，hard-code `location = 'global'`（Gemini 3.x 在 `us-central1` 会 404）。
- `22d351c` **429 自动重试**：`generateContentWithRetry` 指数退避（1s→2s→4s→8s，最多 5 次），同时覆盖 500/503。
- `acdb6a1` **canonical_name 污染修复**：输入格式改为 name / vision_category / vision_confidence 分行 labeled，禁止把 category 拼到商品名后面（"Mung Beans (dry-good)" 不再出现）。
- `819310e` + `3c6cbf4` **视觉提示词修复**：禁止 "Dried beans" 这种通用 fallback；针对所有品类要求具体产品名（不是只对豆类）。
- `b0bed13` **iOS Safari 后台兼容**：SSE controller 抛错时不再 crash，agent 在服务端继续跑完，结果照常写入 MongoDB。
- `10b762c` **存货流程稳定化**：补足几个边缘场景。

### 找货流程（Agent B）

- `4239248` **类别 fallback**：找不到精确匹配时基于 SHELVES 静态字典推测货架。
- `5c68b6b` **死循环防御**：vector_search ≤ 2 次、suggest_by_category ≤ 1 次、第 8 turn 前必须 finish；超步骤改为礼貌 done 而非 error。

### UI / 管理

- `097f86f` **SVG 互动地图**：替换货架下拉，A/B 主货架 + L/R 侧面 + C 中央区全部可点。
- `4923121` **/debug 行展开**：每行 ▸/▾ 折叠 + 过滤输入框 + 相对时间戳。
- `935e586` **/admin 行展开**：点行展开完整 document 字段，编辑/删除按钮 stopPropagation。
- `696e678` **StaleClientGuard**：客户端 bundle 过期改为顶部 banner（之前的自动 reload 会杀掉上传中的请求）。

### 部署 / 文档

- `f58f8db` **AGENTS.md 修正**：明确部署到 GCP VM，覆盖全局 Vercel 偏好；附一键部署命令。

---

## 已知 Bug & 已修

| 问题 | 根因 | 修复 |
|---|---|---|
| 上传到最后报 429 | Gemini quota 用尽 | 指数退避重试 |
| `gemini-3-flash` 404 | 模型 ID 错 + region 错 | 改 `gemini-3.5-flash` + `global` |
| 商品名变成 "Mung Beans (dry-good)" | category 被拼进 name | 输入分行 labeled |
| 切后台就断线 | SSE controller 报错 crash | catch 后服务端继续跑 |
| 全部识别为 "Dried beans" | 提示词允许通用 fallback | 强制具体品名 |
| B10 重复记录 (28→23) | "(dry-good)" 后缀变体 | 去重脚本合并 |
| fish butter 死循环 | vector_search 反复尝试 | 硬上限 + 软 fallback finish |
| Stale guard 杀上传 | 自动 reload 中断上传 | 改 banner 不自动刷新 |

---

## Pending（按优先级）

### P0 — 比赛提交前必做（截止 2026-06-11 14:00 PT）

1. **Demo 视频**：脚本在 `docs/DEMO_SCRIPT.md`，待录制。⚠️ 录制前 1-2 小时不要做批量测试（免费层 DSQ 被打热后单调用会挂 30-60s,静置自动恢复）；开录前手动搜 1-2 次热身。
2. **Devpost 提交**：草稿在 `docs/DEVPOST_DRAFT.md`（已含评委测试步骤），表单指南在 `SUBMISSION_GUIDE.md`。

### 评审期（6/22–7/6）

3. **保持在线**：每天 `curl https://wherebear.help/api/health` 看一眼；VM 若卡死用 `gcloud compute instances reset wherebear-vm --zone=northamerica-northeast2-b`（pm2/caddy 自启,~2 分钟恢复）。

### P1/P2 — 赛后再说

4. ~~**Hybrid Search**~~ ✅ 已上线（text_index 已建,RRF 融合生效）
5. **Voyage Reranker** (`rerank-lite-1`)：提升 top-1 命中率。
6. **iOS 后台恢复**：`visibilitychange` 监听 + 回前台轮询。
7. **Atlas Search Autocomplete**：Find 输入框 search-as-you-type。

---

## 技术栈速查

- **前端**：Next.js 16 (App Router, 注意 API 有 breaking changes，文档在 `node_modules/next/dist/docs/`)
- **后端**：Node.js runtime route handlers + SSE streaming
- **DB**：MongoDB Atlas M0 (`wherebear-cluster`) + Atlas Vector Search
- **Embedding**：Voyage AI `voyage-4-large` 通过 Atlas autoEmbed
- **LLM**：Vertex AI Gemini 3.5 Flash（注意：必须 `location = 'global'`）
- **MCP**：MongoDB MCP Server stdio subprocess，有直连 SDK fallback
- **部署**：GCP VM + PM2 + Caddy

一键部署命令：

```bash
gcloud compute ssh wherebear-vm --zone=northamerica-northeast2-b \
  --command "cd ~/wherebear && git pull && npm install && npm run build && pm2 restart wherebear"
```

---

## 下一步建议

工程已全部收尾（截至 2026-06-09）：性能达标、合规对齐、评委体验完备。**只剩两件事,都是用户操作**：

1. **录 demo 视频**（脚本 ready;注意上面的 DSQ 热身提醒）。
2. **提交 Devpost**（草稿/表单指南 ready;截止 6/11 14:00 PT = 北京时间 6/12 凌晨 5 点）。
