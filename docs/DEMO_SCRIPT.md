# Demo Video Script — Wherebear（目标 ≤ 3:00）

给 Devpost 提交用。**英文旁白 (VO) + 屏幕大字 (on-screen)**，让非英语评委也能跟上。
规则:≤3 分钟(超出只看前 3 分钟)、YouTube/Vimeo 公开、必须展示项目真实运行。

评分四项要在 3 分钟里各点一下:**技术**(Vertex AI + MongoDB MCP + Atlas 混合检索)、
**设计**(橙色 UI + 实时 agent 面板 + 双语)、**影响**(真实超市场景 + 1.3 万商品)、
**创意**(店铺读货架自建记忆)。

---

## 拍摄前准备（录之前先做完）

1. **设备/画幅**:手机竖屏最像店员场景。用手机浏览器打开 `https://wherebear.help`,或 Mac Chrome 调成 **390×844** 竖屏窗口。
2. **录屏工具**:
   - Mac:`Cmd+Shift+5` → 录选区;或 QuickTime 投屏录 iPhone。
   - 手机:iOS 自带屏幕录制。
3. **预演 + 选词(关键)**:⚠️ 别用首页 chips 里的预设词(可乐/samyang/spicy noodle)——评委会觉得是摆拍。以下 5 个已在生产实测全部命中(2026-06-09),各展示一种能力:
   - `老干妈`(中文品牌 → Lao Gan Ma 系列@B4,带实拍图)
   - `gochujang`(韩语罗马音 → 三个品牌的辣酱@B4)
   - `鱼露`(**中文搜出英文命名商品**,跨语言的最佳证明 → Fish Sauce 系列@B3/B4)
   - `wrapper for spring rolls`(**纯用途描述,不知道名字也能找到** → 春卷米纸@B5,单个高置信命中,最有 wow 感)
   - `oister sauce`(拼错 → 蚝油系列@B3,模糊匹配的证明)
   - 建议组合:中文段用 `老干妈` 或 `鱼露`,英文段用 `wrapper for spring rolls`;时间够可以闪一个 `oister sauce`。正式录前再各搜一遍确认。
4. **拍货架素材**:准备 1 张清晰的货架照片(亚洲零食/饮料货架最佳,品类多、识别效果直观)。存手机相册。也可现场对着家里货架/便利店拍。
5. **环境**:Mac 调暗色菜单栏;关通知;浏览器只留这一个标签页。
6. **首页语言**:演示中文答案时把语言切到「中」,英文段切回「EN」(右上角 pill)。

---

## 逐镜头脚本（beat-by-beat）

### 0:00–0:16 · Hook（痛点）
- **画面**:真实超市货架 B-roll(或手机拍一段走过货架的画面);一个顾客问 *"Where can I find 年糕?"*,店员面露难色、走开、回来摊手。
- **VO**: *"Every grocery store runs on knowledge that only lives in a few employees' heads. Customers ask in mixed languages, with typos, with descriptions — and the answer is somewhere down aisle four, in someone else's brain."*
- **屏幕大字**: `Aisle knowledge isn't on the shelves.`

### 0:16–0:34 · Pitch（是什么）
- **画面**:切到手机,Wherebear 橙色首页(Wherebear 标题 + 熊 + Find item 卡)。
- **VO**: *"Wherebear turns casual shelf photos into a multilingual, searchable store memory. Two flows — one reads shelves, one answers customers — built on Vertex AI Gemini and MongoDB Atlas Vector Search through the official MongoDB MCP Server."*
- **屏幕大字**: `Wherebear · Snap shelves. Ask in any language. Get an aisle.`

### 0:34–1:30 · Flow 1：拍货架 → 自建记忆
- **操作**(边录边做):
  1. 点底部 **Staff** → 进工作台 → 点 **Snap shelf**。
  2. 选 **从相册** → 选那张货架照片。
  3. 等 5–10s,识别列表淡入(商品名 + 类别)。
  4. 选一个过道(如 `Aisle 4`)→ 点 **Save**。
  5. 进度页:放大 **agent 面板**,看每一步流式出现 + 蓝色 **MCP** pill。
- **VO**: *"A worker snaps a shelf. A two-stage Gemini vision pass detects every product, crops each one, and identifies them in a batch. Pick an aisle, save — and in the background each new product is expanded into Chinese, Korean, Japanese and romanized aliases, then auto-embedded by MongoDB Atlas. The store is building its own memory."*
- **屏幕叠加**:第一个 MCP pill 处指一下,叠字 `MongoDB MCP Server`。

### 1:30–2:32 · Flow 2：多语言找货（主菜）
- **操作**:
  1. 回首页 → **Find item**。
  2. 输入中文词(预演选定的,如 `老干妈` 或 `鱼露`)→ 点 **Ask the bear**。
  3. agent 面板依次亮:`understand_intent`(识别中文)→ `vector_search` / hybrid(带 **MCP** pill)→ 合成答案。
  4. 结果卡滑入:商品 + 货架号 + 地图;答案行双语 `应该在 B5 · It should be on shelf B5.`
  5. 点 **再搜一次**,输入英文描述 `wrapper for spring rolls` → 不知道商品名也能命中(春卷米纸@B5),答案回英文。
- **VO**: *"Now the worker just types how the customer asked — in Chinese. The search agent understands the language, rewrites the query, and runs a hybrid search: Atlas Vector Search for meaning, Atlas Search for exact tokens and typos, fused together — all through the MongoDB MCP Server. It answers in the worker's own language. Ask again in English, by description, and the same agent finds it."*
- **屏幕叠加**(结果出现时):高亮双语答案行,叠字 `Same agent · the user's language`.

### 2:32–2:50 · 架构闪现
- **画面**:切到 README 里的架构图(或一张干净的图),动画走一遍数据流 `Gemini → MCP → Atlas`。
- **VO**: *"Built on Vertex AI Gemini, Google Compute Engine, and MongoDB Atlas Vector Search with autoEmbed — voyage-4-large embeddings we never compute ourselves. The whole agent loop is open source."*
- **屏幕大字**: `Vertex AI · Compute Engine · MongoDB Atlas · MCP · Voyage AI`

### 2:50–3:00 · 收尾
- **画面**:Wherebear 熊脸轻轻一歪;logo + URL。
- **VO**: *"Wherebear. The store memory bear."*
- **屏幕大字**: `wherebear.help · github.com/GLoryforRichard/wherebear-Google-Cloud-Rapid-Agent-Hackathon`

---

## 旁白整稿（连读，方便配音；约 150 词，正好 ~3 分钟留操作停顿）

> Every grocery store runs on knowledge that only lives in a few employees' heads. Customers ask in mixed languages, with typos, with descriptions — and the answer is somewhere down aisle four, in someone else's brain.
> Wherebear turns casual shelf photos into a multilingual, searchable store memory. Two flows — one reads shelves, one answers customers — built on Vertex AI Gemini and MongoDB Atlas Vector Search through the official MongoDB MCP Server.
> A worker snaps a shelf. A two-stage Gemini vision pass detects every product, crops each one, and identifies them in a batch. Pick an aisle, save — and each new product is expanded into Chinese, Korean, Japanese and romanized aliases, then auto-embedded by MongoDB Atlas.
> Now the worker types how the customer asked — in Chinese. The agent understands the language, rewrites the query, and runs a hybrid search — Atlas Vector Search plus Atlas Search — all through the MongoDB MCP Server, and answers in the worker's language. Ask again in English, by description, and the same agent finds it.
> Built on Vertex AI Gemini, Google Compute Engine, and MongoDB Atlas with autoEmbed. The whole agent loop is open source. Wherebear — the store memory bear.

---

## 剪辑 / 上传清单

- [ ] 总时长 **≤ 3:00**(超了砍 Hook 或架构段)。
- [ ] 加 **英文字幕**(VO 已是英文,字幕可选但建议加,防口音/网络音糊)。
- [ ] 演示片段必须是**真实运行**(规则要求),别用假动画替代功能。
- [ ] 关键时刻别太快:MCP pill、双语答案行各停 1–1.5s。
- [ ] 上传 YouTube 或 Vimeo,**可见性必须 Public**(规则原文 "made publicly visible" —— Unlisted 不满足,有不合规风险)。
- [ ] **不加背景音乐**(规则要求"原创且不含第三方素材",版权 BGM 直接踩线;纯人声 + 操作原声最安全)。
- [ ] 视频里别出现第三方广告/商标(规则禁止);货架照片里的品牌包装属于真实使用场景,问题不大,但别给某品牌特写+口播,**别拍超市门头/招牌 logo**。
- [ ] 真人入镜(Hook 的顾客扮演)用知情同意的人,或只拍背影/手部 —— 不得侵犯他人肖像/隐私权。
- [ ] 必须是**全新录制、未在任何地方发表过**的视频(原创未发表条款)。
- [ ] 把链接填回 Devpost 的 **Video demo link**。

## 配音语气
平稳、陈述、中速。**产品是主角,不是解说**。少废话——屏幕上的 agent 面板自己会讲故事。
