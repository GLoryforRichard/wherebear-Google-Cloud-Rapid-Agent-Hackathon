# Wherebear 开发问题合集

> 整理自 commit 历史、`docs/PROGRESS.md` 与近期工作记录。
> 标记：🎨 设计/需求 · 🔧 技术坑 · 💡 适合写进 Devpost「Challenges we ran into」

---

## 1. 搜索与识别核心坑（项目早期）🔧

| 问题 | 根因 | 解决 |
|---|---|---|
| 上传到最后报 **429** | Gemini quota 用尽 | `generateContentWithRetry` 指数退避 1→2→4→8s ×5，覆盖 429/500/503 |
| `gemini-3-flash` 一直 **404** 💡 | 模型 ID + region 都错 | 改 `gemini-3.5-flash` + **`location='global'`**（Gemini 3.x 在 `us-central1` 必 404）|
| 商品名变 "Mung Beans (dry-good)" | category 被拼进 name | 输入改成 name / category / confidence **分行 labeled** |
| 切后台就断线、识别丢失 💡 | SSE controller 报错 crash | catch 后**服务端继续跑完**，结果照写 MongoDB（iOS Safari 兼容）|
| 全部识别成 "Dried beans" | 提示词允许通用 fallback | 强制每个品类给**具体产品名** |
| "fish butter" 搜索**死循环** | vector_search 反复尝试 | 硬上限（vector≤2 / category≤1 / 第8 turn 前必 finish）+ 礼貌 done |
| B10 货架重复记录 28→23 | "(dry-good)" 后缀变体 | 去重脚本合并 |
| Stale client guard 杀掉上传 | 自动 reload 中断上传请求 | 改成顶部 banner，不自动刷新 |

## 2. 搜索性能与质量 🔧💡

- **Agentic loop → 固定管线**：Agent B 从 LLM 自循环换成固定两步（understand_intent → vector → finish），**约 2× 加速** 💡
- **关掉 thinking**：vision detect/identify + search intent/finish 全部 `thinkingBudget:0`，压延迟
- **拍照检测并发 3 → 5**
- **"No match" 真的没找到**：加 LLM 相关性过滤，不硬塞不相关结果
- **结果确定性**：按 score 排序，避免同输入结果漂移
- **找不到时给猜测**：同品牌 / 同类别推测货架
- **Hybrid retrieval**：vector + Atlas Search（RRF 融合）修 typo（如 fish butter/batter）💡

## 3. 视觉重设计（Gumroad 风格）🎨

- 需求：参考 Gumroad 重设计并上线；先探索了 **30 种风格**
- 选定：**橙 `#ff8a00` + 金 `#ffc900`**，Space Grotesk 字体，**硬黑边框 + 偏移阴影**（neo-brutalism）
- 落地：`lib/theme.ts` tokens、inline-style、CSS `mix-blend-mode:multiply` 融合白底素材
- 原则：有用的才提交

## 4. 侦探熊吉祥物 🎨🔧

需求：用**原图**（非矢量）做侦探熊，替换旧 SVG 熊。连环坑：
- 🔧 **Kling 水印** → ffmpeg crop 裁掉底部水印条
- 🔧 **视频白色背景框**（CSS multiply 下显灰框）→ ffmpeg `colorlevels` 把白拉到纯白，再 multiply 融到米色背景
- 🔧 **浏览器播放按钮**（autoplay 视频显示 ▶ 原生控件）→ `globals.css` 隐藏 `::-webkit-media-controls-*` + `pointerEvents:none`
- 视频压到 293KB / 5s loop；各屏吉祥物统一放大

## 5. 运行时文案店员化（去 jargon）🎨💡

- 需求：假设用户是刚拿到工具的**超市店员**，把所有运行时专业术语（hit、vector、intent…）换成店员能懂的话
- 选定：**双层呈现**（店员化主文案 + MCP 小标）、简洁专业、语义化 + 颜色
- 落地：i18n 扩展 step/panel keys，`summarizeResult` 重写；全程双语
- 💡 体现"给真实用户用"的产品思考

## 6. 功能精简 🎨

- **去成本统计**：移除 `cost_usd/cost_cad`（`lib/ops.ts`），保留 usage + 次数
- **去准确率显示**：首页 hitRate 卡 → "最近找过"；搜索结果"把握"标签删除（不想显得在标榜命中率）

## 7. EN 识别翻译 & 识别去重 🎨

- **EN 识别翻译**：EN 界面下语音/拍照识别到中文，确认卡显示英文翻译（Gemini prompt 用 `|||` 一次返回 `text_en`，英文为主 + 原文小字）
- **识别去重**：语音/拍照"听到"卡显示时，隐藏"问小熊"按钮

## 8. 部署与认证（GCP）🔧💡

- **不是 Vercel**：项目跑在 GCP VM（Caddy + PM2），push `main` **不自动部署**，要 SSH 进去 `git pull && build && pm2 restart` 💡
- **gcloud token 反复过期**：部署账号 `melody@hes.edu.kg`，过期时需用户手动 `gcloud auth login`（本次排查遇到 ≥2 次）
- 💡 **MCP 是子进程 → 跑不了 serverless/Vercel**，这是选 VM 的根本原因

## 9. 本地开发环境：Gemini 失效 🔧💡

- 本地 Vertex/Gemini 认证失效（ADC `invalid_rapt` / `gcp-key.json` 0 字节）→ 本地 `npm run dev` **跑不了** vision/search/voice（返回 `invalid_grant`）
- 影响：本地只能测不依赖 Gemini 的页；动作页必须用生产，或恢复 `gcloud auth application-default login`
- 后面截图被迫走生产，根因就在这

## 10. Devpost 提交文案 🎨💡

- **Project name 多轮迭代**：Wherebear → 加用途 → 加"超市" → 加 easily → **发现卡片只显示标题前 ~27 字符**（"AI agent finds item" 被截没）→ 重排成用途前置：`Wherebear — find any item in any supermarket aisle`
- **Elevator pitch**：抽象版 → 塞进 3 亮点 → "shelf after shelf"（体现很多货架）→ **发现简介卡片只显 2 行** → 最强卖点前置：`Say it or snap it, in any language…`
- 💡 **关键洞察**：Devpost gallery 卡片**标题截 ~27 字符、简介截 2 行**，重要信息必须前置
- **Built with 拆分**：Google Cloud（Vertex AI / Gemini 3 Flash / Compute Engine）vs 其他（MongoDB Atlas + Vector Search、Voyage、MCP、Next.js 栈…）

## 11. 海报素材采集 — 截图工具链大坑 🔧💡 ★

要"**手机版 + 真实数据 + 可交互 + 落盘**"的截图，试遍工具都有短板：

| 工具 | 手机视口 | 可交互 | 落盘 | 生产/Gemini |
|---|---|---|---|---|
| Chrome MCP | ❌ 缩不到 390（Mac 窗口最小 ~535）| ✅ | ✅ | ✅ |
| headless `--window-size` | ❌ 内容溢出（无 mobile 模拟）| ❌ | ✅ | ✅ |
| preview MCP | ✅ 完美 375 | ✅ | ❌ 不落盘 | ❌ 锁本地 + Gemini 挂 |
| **puppeteer-core**（最终方案）| ✅ mobile emulation | ✅ | ✅ | ✅ 截生产 |

- 方案：`puppeteer-core`（`--no-save`，用系统 Chrome）mobile emulation 截生产站，落盘 `assets/poster-kit/`
- 脚本调试踩的坑：
  - admin 密码**不是 input**，是数字键盘（监听 window keydown）→ `keyboard.type('2627')` 满 4 位自动提交
  - 选货架点击点到了**外层 div**（无 onClick）→ 改成只点 button
  - 货架 B4 是 **SVG `<g>`** → 派发冒泡 click 让 React 捕获
  - 搜索结果要等 SSE 跑完（等 "Search again" 出现）再截
  - iPhone 货架图是 **HEIC** → `sips` 转 JPEG 再上传
- 小熊 5 帧：ffmpeg `select` 抽帧
- dashboard 页**硬编码中文**，切不了英文 → 跳过
- 副作用：截检测/进度页**真实写库** B4 共 115 商品（用户选择保留）

## 11.5 性能大排查（2026-06-09,提交前两天）⚡

一天内连续揪出四层叠加的性能元凶,搜索从 8-15s(尾部 57s+)降到 **2.5-3.2s**,密集货架识别从 **200s+ 降到 ~27s**:

1. **ADK `MCPToolset` 每个 LLM 回合都 spawn 新的 `npx mongodb-mcp-server` 子进程**(`getTools()` 每回合调用一次,列完工具就杀)。一次搜索起 3-5 个重进程,4GB e2-medium 直接卡死(TLS/SSH 全无响应,两次硬重启)。修复:子类缓存工具列表 + 直接 exec 本地安装的二进制跳过 npx。
2. **Gemini 3.x 静默忽略 `thinkingBudget: 0`**——3.x 的开关是 `thinkingLevel`。所有"已关思考"的调用其实都在全速 dynamic thinking:vision stage2 28 张图思考了 2 分多钟。全部换成 `thinkingLevel: MINIMAL` 后 stage2 152s → 10s。**这是单点最大的坑。**
3. **免费试用项目的 Vertex DSQ 配额惩罚请求数而非 token 量**:5-6 个并行 stage2 小批次 = 每个退避窗口只放行一个(429 风暴);打包成 ≤2 个 40-crop 大请求反而快一个数量级。还有"静默停车"模式:不报 429,单个调用挂 30-60s → 加了 15s 对冲重发(hedge)。
4. **零散热点**:understand_intent 的 Gemini 调用被 hybrid 检索冗余化(改纯 JS 语言检测,1.1s→1ms);agent 收尾回合只许回 "DONE"(原来写一段被丢弃的双语答案);synthesizeFinish 与 agent 收尾回合并行跑;sharp 裁剪从"每框解码一次 12MP"改为"解码一次复用"(35s→0.8s);stage1 输出砍掉 label 字段(输出 token 减半)。

教训:**性能问题要分层归因**——框架行为(ADK spawn)、模型 API 语义(thinkingLevel)、配额形态(DSQ 重请求数)、本地 CPU(sharp),四层各有一个独立的元凶,修掉任何单层都不够。

## 12. 零碎 🔧

- 文件编辑报 "file not read" → 先 Read 再 Write/Edit
- 货架地图 CoolerTop 冷柜（左侧高柜）位置修正

---

## 给 Devpost「Challenges」的精选（💡 项浓缩）

最值得讲的 4 个真实挑战：
1. **Gemini 3 的隐藏区域坑** —— 必须 `location='global'`，在 `us-central1` 一律 404，排查很久。
2. **MCP = 子进程 → 上不了 serverless** —— 被迫改成长驻 GCP VM 部署，这是架构的关键取舍。
3. **把 agent loop 换成固定管线** —— 砍掉不确定的 LLM 自循环，搜索快了约 2×、结果可复现。
4. **多语言落到同一处** —— 中文别名扩展 + Atlas autoEmbed，让「咖喱酱」和 "curry sauce" 命中同一商品。
