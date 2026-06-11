# Wherebear — 开发交接文档

> 这份文档是从一段完整的产品 + 技术讨论中整理出的项目说明。请在每次新会话开始时先阅读它，确保上下文一致。

---

## 0. 项目背景

### 比赛信息

- **赛事**：Google Cloud Rapid Agent Hackathon
- **时间**：2026 年 5 月 5 日 — 6 月 11 日（PT 时间）
- **赛道**：MongoDB 赛道
- **奖项**：每赛道独立评奖（第一名 $5,000 / 第二名 $3,000 / 第三名 $2,000）
- **官网**：https://rapid-agent.devpost.com/
- **提交要求**：托管项目 URL + 开源代码仓库（含 License）+ 约 3 分钟 Demo 视频

### 比赛核心要求（评审会用这些标准打分）

1. **必须是真正的 Agent**——不是 AI 应用。能规划步骤、自主调用工具、有持久记忆。
2. **必须通过 MCP（Model Context Protocol）集成合作伙伴产品**——本项目使用 MongoDB MCP Server。
3. **必须解决真实世界的问题**——超越聊天机器人。
4. **必须能在 Web / Android / iOS 至少一个平台稳定运行**——本项目使用 Web。

### 开发者背景

- 业余时间：每天 2-4 小时
- 技术背景：全栈独立开发
- 已有账号：Google Cloud、MongoDB Atlas
- 地点：加拿大 Guelph

---

## 1. 产品名称

**Wherebear**

Slogan：**Wherebear knows where.**

---

## 2. 一句话定位

Wherebear 是一个给忙碌 grocery worker 使用的店内记忆助手，帮助他们快速回答顾客"这个商品在哪？"

**英文 pitch**：

> Wherebear helps busy grocery workers answer "Where can I find this?" by turning casual shelf photos into a searchable store memory.

---

## 3. 真实问题与痛点

### 场景描述

多语言超市（尤其是亚洲超市、国际食品店）中，顾客经常问："这个商品在哪里？" 比如：

- "Where can I find rice cake?"
- "Where is Lao Gan Ma?"
- "Do you know where hot pot sauce is?"
- "年糕在哪？"
- "黑色包寿司的纸在哪？"

但员工不一定知道答案，要么去问老员工、要么绕店一圈找。这导致**顾客购物体验差、员工被反复打断、新员工培训慢**。

### 五大痛点

1. **货架知识没有数字化**——只存在老员工脑子里
2. **理货员没时间维护系统**——必须零负担录入
3. **顾客经常不知道准确商品名**——拼错、混合语言、用途描述、口音问题
4. **多语言商品命名混乱**——同一个商品有英文/中文/拼音/韩文/日文/品牌名/俗称
5. **没有现成解决方案**——传统库存系统太重，普通搜索框太死板

### 为什么这是个 AI Agent 问题

普通搜索引擎要求用户输入准确商品名，但顾客的真实查询是：

- 拼写错误："samyung" 实际是 "Samyang"
- 语言混合："韩式 rice cake"
- 用途描述："包寿司的黑色纸"
- 品类查询："hot pot sauce"

要把这些查询都正确映射到货架位置，需要 LLM 的语义理解能力 + 向量搜索 + 多步骤推理。这是规则系统做不好、Agent 做得很好的事。

---

## 4. 目标用户

### 唯一 MVP 用户

**忙碌的 grocery worker**

包括：

- 理货员
- 兼职员工
- 新员工
- 收银/服务台员工
- 多语言 grocery store / Asian grocery store 员工

### 用户特点

- 经常被顾客问商品位置
- 不一定知道所有商品在哪
- 没有时间专门维护商品数据库
- 工作时手机随身

---

## 5. MVP 产品目标

MVP 只解决一个问题：

> 当顾客问某一个商品在哪里时，员工可以用 Wherebear 快速查到这个商品大概在哪个区域/过道。

MVP 不追求完整店铺管理，也不做库存系统。

**核心目标**：

> **Snap shelves. Search one item. Answer the customer.**

---

## 6. 核心使用场景

### 场景 A：员工顺手建立货架记忆

**场景描述**

员工正常工作时路过货架，顺手打开 Wherebear：

1. 拍一张货架照片
2. 选择/输入大概位置
3. 提交

员工不需要手动输入商品名。

**示例位置**

- Aisle 1
- Aisle 2
- 冷藏区
- 调料区
- 方便面区
- 日料区
- 火锅区

**成功标准**

员工能在 **10 秒以内** 完成一次货架记录，不觉得这是额外负担。

### 场景 B：员工被顾客询问时搜索

**场景描述**

顾客问："Where can I find rice cake?"

员工不确定，于是打开 Wherebear 搜索 "rice cake"

Wherebear 返回："Rice cake — 冷藏区"

员工直接告诉顾客："It should be in the refrigerated section."

**成功标准**

员工能在几秒内得到一个可以转述给顾客的过道级答案。

---

## 7. MVP 功能需求

### FR1：拍照记录货架

员工可以用手机拍摄或上传货架照片。

### FR2：标注大概位置

员工上传照片时，需要选择或输入该照片对应的位置。例如：

```
冷藏区
Aisle 3
调料区
方便面区
日料区
```

### FR3：自动建立商品记忆（Agent A）

系统从货架照片中识别商品，并把商品和位置关联起来。员工不需要手动录入商品名。

**技术实现：FR3 不是简单的 OCR + 写入。后台由 Agent A 自主规划以下步骤**：

1. 调用 Gemini Vision 识别照片中所有商品
2. 通过 **MongoDB MCP** 查询每个商品是否已存在
3. 对新商品，调 LLM 推理多语言别名（年糕 → rice cake / tteok / 韩式年糕）
4. 调 Voyage AI 生成 embedding（多语言向量）
5. 通过 **MongoDB MCP** 写入 `products` 和 `shelf_evidence` 集合

员工感受不到这些步骤，但 demo 视频会展示"思考过程面板"让评审看到 Agent 的规划。

### FR4：单商品搜索（Agent B）

员工可以输入顾客问的一个商品或描述。例如：

```
rice cake
年糕
Lao Gan Ma
samyung
black paper for sushi
hot pot sauce
```

**技术实现：搜索不是简单的字符串匹配。后台由 Agent B 自主规划**：

1. 调 LLM 推理用户意图（标准名 / 拼错 / 描述 / 混合语言）
2. 调 Voyage AI 生成查询向量
3. 通过 **MongoDB MCP** 做向量搜索
4. 综合返回最可能商品 + 位置
5. 通过 **MongoDB MCP** 写入 `search_logs`（未来分析用）

这个 Agent 路径决定了系统能容忍 typo、混合语言、描述型查询。

### FR5：返回一个最可能位置

系统返回简洁结果：

```
年糕
位置：冷藏区
```

或：

```
你可能在找：nori / seaweed
位置：日料区
```

**回答语言策略**：根据用户搜索语言自动切换。用户用中文搜，返回中文；用英文搜，返回英文。在 Agent prompt 里加一句"用用户输入的语言回答"即可实现。

### FR6：找不到时明确说明

如果没有记录，系统不编造答案：

```
暂时没有找到这个商品的位置记录。
```

**技术行为**：Agent B 通过 MongoDB MCP 把这次查询写入 `search_logs.no_result_terms`，用于未来改进。零额外开发成本，但让评审看到 Agent 在"学习"。

### FR7：思考过程面板（Demo 关键）

在员工搜索时，**右侧显示一个紧凑的步骤列表**，展示 Agent 实时规划：

```
🧠 理解查询：rice cake
🔍 向量搜索（MongoDB MCP）
✅ 匹配到：年糕 / Korean rice cake
📍 返回位置：冷藏区
```

员工在生产环境可以折叠它（不影响快速回答顾客），但**demo 视频里必须打开**。这是评审 3 秒内判断"这是 Agent"的唯一视觉信号。

---

## 8. MVP 必须支持的查询类型

### 1. 标准商品名

```
rice cake
Lao Gan Ma
Samyang
年糕
```

### 2. 中英文混合

```
韩式 rice cake
hot pot 底料
spicy 辣椒油
```

### 3. 拼写错误

```
samyung
laoganma
gochu jang
```

### 4. 描述型查询

```
black paper for sushi
red chili oil jar
Korean spicy paste
```

### 5. 品类查询

```
hot pot sauce
instant noodles
soy sauce
seaweed
```

---

## 9. MVP 不做什么

Wherebear MVP **不做**：

- 顾客端 App
- 顾客自己搜索
- 购物清单
- 多商品同时搜索
- 菜谱/做菜原料拆解
- 库存数量
- 是否有货
- 价格查询
- 精确到第几层第几格
- 店铺地图导航
- 用户登录
- 多店铺管理
- 完整店主后台
- "几天前确认"的时间说明

MVP 只回答：**这个商品大概在哪？**

---

## 10. 输出形式

### 找到商品

```
Rice cake
Location: Refrigerated section
```

### 识别为相近商品

```
You might mean: nori / seaweed
Location: Japanese food aisle
```

### 没找到

```
No location record found yet.
```

### 中文界面版本

```
年糕
位置：冷藏区
```

```
你可能在找：海苔 / nori
位置：日料区
```

```
暂时没有找到这个商品的位置记录。
```

---

## 11. 技术架构

```
[员工]
  ↓
Web 前端 (Next.js + React + Tailwind + shadcn/ui)
  ↓
Agent A (记忆建立)        Agent B (找货查询)
Gemini 2.0 Flash         Gemini 2.0 Flash
   ↓                        ↓
工具集:
- Gemini Vision (照片 OCR)
- LLM 推理 (别名/语义)
- Voyage AI (多语言 embedding)
   ↓
MongoDB MCP Server
   ↓
MongoDB Atlas
- shelf_evidence (货架证据)
- products (商品 + 别名 + 向量)
- search_logs (查询记录)
```

### 技术栈

- **前端**：Next.js + React + Tailwind + shadcn/ui，部署 Vercel
- **后端**：Next.js API Routes（同一项目内）
- **Agent 模型**：Gemini 2.0 Flash
- **视觉识别**：Gemini Vision API
- **Embedding**：Voyage AI（MongoDB 官方推荐）
- **数据库**：MongoDB Atlas M0（免费）
- **MCP 集成**：MongoDB 官方 MCP Server

---

## 12. MongoDB 数据模型

### Collection: `shelf_evidence`（货架证据）

```javascript
{
  _id: ObjectId,
  photo_url: String,           // 上传后的图片 URL
  aisle: String,               // "Aisle 3" / "冷藏区" / "调料区"
  products_detected: [String], // Gemini Vision 识别出的商品
  raw_ocr_text: String,        // 原始 OCR 文本
  timestamp: ISODate
}
```

### Collection: `products`（商品 + 别名 + 向量）

```javascript
{
  _id: ObjectId,
  canonical_name: String,      // "Korean rice cake"
  aliases: [String],           // ["年糕", "rice cake", "tteok", "韩式年糕"]
  category: String,            // "frozen" / "sauce" / "noodle"
  embedding: [Number],         // Voyage AI 生成的向量
  latest_aisle: String,        // 最近一次确认的过道
  evidence_count: Number       // 被拍到过几次
}
```

需要在 `embedding` 字段创建 **Atlas Vector Search Index**。

### Collection: `search_logs`（搜索记录）

```javascript
{
  _id: ObjectId,
  query: String,               // 用户原始查询
  resolved_intent: String,     // LLM 解析的意图
  results_found: Number,       // 找到几个
  no_result_terms: [String],   // 完全没找到的词
  timestamp: ISODate
}
```

---

## 13. 非功能需求

### NFR1：低负担

员工拍照记录货架的过程应尽量控制在 10 秒以内。

### NFR2：移动端优先

员工主要在店内用手机操作，界面必须适合手机。前端使用 `<input type="file" accept="image/*" capture="environment">` 调起手机摄像头，**不需要原生 App**。

### NFR3：搜索结果简洁

员工面对顾客时不想读长解释。结果应该短、清楚、可直接转述。

### NFR4：不承诺绝对准确

Wherebear 只提供"基于已有记忆的最可能位置"，不保证商品一定在那里。

### NFR5：适合多语言环境

系统应理解英文、中文、中英混合、拼写错误和描述型表达。

---

## 14. 核心用户故事

### User Story 1：顺手拍照

> As a busy grocery worker, I want to snap a shelf photo while I am already walking through the store, so that the store can build searchable memory without requiring manual product entry.

### User Story 2：回答顾客问题

> As a grocery worker, I want to search for one item when a customer asks where it is, so that I can quickly give them an aisle-level answer even if I do not personally know the location.

### User Story 3：理解不标准表达

> As a grocery worker, I want the system to understand mixed languages, typos, accents, and product descriptions, so that I can search using the customer's original words.

---

## 15. Demo 视频脚本（3 分钟）

| 时间 | 镜头 | 文案 |
|---|---|---|
| 0:00-0:20 | 真实场景：亚洲超市内顾客问"年糕在哪"，店员茫然 | "Every grocery store has knowledge that only lives in employees' heads." |
| 0:20-0:40 | 切到 Wherebear：员工走过货架，拍一张，选过道，提交 | "Wherebear lets staff casually capture shelf evidence as they work." |
| 0:40-1:20 | 屏幕录制：Agent A 思考过程面板逐步展开 | "Behind every photo, an AI agent plans its steps on its own." |
| 1:20-2:10 | 员工搜索界面：输入"rice cake"或"samyung"，Agent B 思考过程展开 | "Workers search in their own words—typos, mixed languages, descriptions." |
| 2:10-2:40 | 切换：用中文搜索"年糕"返回中文结果，用英文搜索同一商品返回英文 | "Same memory, two languages—because customers don't all speak English." |
| 2:40-3:00 | 技术栈一闪而过 + 项目链接 | "Built with Gemini, MongoDB Atlas, and MCP." |

---

## 16. 4 周开发计划

### 第 1 周：搭骨架（端到端通即可，不求美观）

| Day | 任务 | 预计 |
|---|---|---|
| 1 | Next.js 项目初始化，部署 Vercel | 2h |
| 2 | MongoDB Atlas 建集群，三个 Collection 的 schema | 2h |
| 3 | Gemini API 接通，测试函数：传图片返回商品列表 | 3h |
| 4 | 前端拍照页 UI（`<input capture>` + 过道下拉 + 上传） | 3h |
| 5 | 打通流程：前端上传→Gemini Vision→MongoDB | 4h |
| 周末 | 搜索页 UI + 简单文本搜索（先不用向量） | 4h |

**第 1 周验收**：能上传照片，能用关键词搜出来。

### 第 2 周：让它变成真正的 Agent

| Day | 任务 | 预计 |
|---|---|---|
| 8 | 接入 MongoDB MCP Server，Agent 通过 MCP 调用数据库 | 4h |
| 9 | 改造写入流程为 Agent A——用 Gemini 函数调用自主规划 | 4h |
| 10 | 接 Voyage AI 生成 embedding，加 Vector Search Index | 3h |
| 11 | 改造搜索流程为 Agent B——意图理解 + 向量搜索 | 4h |
| 12 | 前端加"思考过程面板"——流式展示 Agent 每步规划 | 3h |
| 周末 | 双语回答策略 + 边界情况（无结果、识别失败） | 4h |

**第 2 周验收**：搜"rice cake"或"年糕"，能看到 Agent 思考过程实时展开。**思考过程面板是 demo 的灵魂，必须做。**

### 第 3 周：真实数据 + 打磨

| Day | 任务 | 预计 |
|---|---|---|
| 15 | **去亚洲超市拍 30-50 张真实货架照片**（多伦多 T&T / H Mart） | 半天 |
| 16 | 批量导入照片，Agent A 自动建库 | 3h |
| 17 | UI 视觉打磨——配色、字体、空状态、loading | 3h |
| 18 | 错误处理 + 边界情况——空搜索、识别失败、超时 | 3h |
| 19 | Buffer / 修 bug | 3h |
| 20 | Buffer / 修 bug | 3h |
| 周末 | 代码整理 + README + 开源 License（MIT） | 4h |

**第 3 周验收**：随便给朋友试用，能搞懂在做什么、用起来不报错。

### 第 4 周：提交冲刺（不写新功能）

| Day | 任务 | 预计 |
|---|---|---|
| 22 | 写 Devpost 项目描述 | 3h |
| 23 | 录 demo 视频 | 4h |
| 24 | 剪辑视频 + 加字幕 | 3h |
| 25 | 技术架构文档 + Demo 链接测试 + 重读规则 | 2h |
| **26（周三）** | **正式提交** | 2h |
| 27-28 | Buffer——只修 bug，不加功能 | - |

---

## 17. 风险预案

| 风险 | 应对 |
|---|---|
| 第 2 周 Agent 改造卡住超过 2 天 | Fallback：用普通函数链替代，保留"思考过程面板"的可视化效果 |
| MongoDB MCP Server 接入有困难 | Fallback：直接用 MongoDB Node.js SDK，文档里说明并在第 3 周再试 |
| Vision 识别中文准确率低 | 提示词加强：明确告诉 Gemini 这是亚洲超市，可能有中/英/韩/日文 |
| 业余时间不够 | 砍掉 UI 打磨，保留核心两个 Agent + 思考过程面板 |
| 真实照片拍不到 | Fallback：用网络上的亚洲超市货架图，但 demo 时不能说是真实数据 |

---

## 18. 关键设计原则

### 必须做对的 5 件事

1. **Agent 是真 Agent，不是脚本**——必须用 Gemini 函数调用让模型自主决定调哪些工具
2. **MongoDB 通过 MCP 调用**——不能写死的查询代码，要让 Agent 把数据库当工作记忆
3. **思考过程面板要实时可见**——评审 3 秒判断你是不是 Agent 的唯一依据
4. **双语回答**——用户什么语言搜，就用什么语言答
5. **demo 数据必须真实**——必须去线下亚洲超市拍真照片

### 必须避免的 5 个陷阱

1. ❌ 不要做用户登录 / 权限系统——MVP 用不上
2. ❌ 不要做原生 App——Web + 手机浏览器拍照即可
3. ❌ 不要追求精确到货架——只到过道级
4. ❌ 不要第 4 周还加新功能——一定翻车
5. ❌ 不要藏起 Agent 思考过程——必须可视化展示

---

## 19. 项目开发工作指引

### 每次新会话开始时

请先阅读这份文档，理解：

- 项目目标是参加比赛（不是产品上线）
- 时间紧、技术栈靠 vibe
- Agent 真实性 > 功能丰富度
- 真实数据 > UI 完美
- MVP 只解决一个问题：员工搜一个商品，得到一个位置

### 编码偏好

- 优先用 TypeScript + Next.js App Router
- 优先用 shadcn/ui 组件
- 优先用 Tailwind 而非自定义 CSS
- API Routes 写在 Next.js 同一项目内，不要单独建后端
- 部署目标：Vercel（前端 + API） + MongoDB Atlas

### 重要约束

- 不写复杂的状态管理（不用 Redux / Zustand），useState 够用
- 不写复杂的认证（MVP 阶段不需要登录）
- 不优化性能（除非真的卡到不能用）
- 不重构（除非阻碍下一步）
- 不写测试（hackathon 不需要）

### 必须保留的"Agent 化"特征

任何代码改动都不要破坏以下几点：

1. **Agent A 和 Agent B 是用 Gemini 函数调用驱动的**，不是 if-else 脚本
2. **数据库操作通过 MongoDB MCP**，不是直接 SDK 调用
3. **思考过程面板能实时展示 Agent 调用的每个工具**

如果某次改动需要绕开以上之一，请先和我确认。

---

## 20. MVP 成功定义

Wherebear MVP 成功的标准是：

> 一个 grocery worker 可以顺手拍货架并标注位置；之后当顾客问某一个商品在哪里时，员工可以输入顾客的原话，系统返回一个大概区域/过道。

最短定义：

> **Take a shelf photo. Ask where an item is. Get an aisle-level answer.**

---

**最后提醒**：这个项目的核心叙事是"AI Agent 把员工脑子里的货架知识沉淀成可搜索的店内记忆"。所有技术决策都应该服务于这个叙事，且必须明显是 Agent 而不是普通 AI 应用。
