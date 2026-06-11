# 迁移复盘 — 从账单冻结到全栈合规 (2026-06-04)

这份文档汇总了从 `/init` 项目体检到完成 GCP 账户迁移这段时间遇到的**所有问题**、**根因**、**解决方案**和**关键经验**。按主题+严重度分组,便于以后翻查。

---

## 时间线一句话总览

> 项目刚迁文件夹 → 体检 → 发现没有破坏 → 容量 OK → 比赛合规确认 → **撞上账单危机(欠 $76 被冻结)** → 选新账号 $300 试用方案 → 撞上 edu 机构 SA key 封锁(改 ADC 绕过) → 本地跑通 → 重建生产 VM + Caddy + DNS 切换 → 撞上 Caddy 证书时机 + Mac DNS 缓存 → 全通 → 旧项目 unlink billing 彻底止血 → 清理收尾。

---

## 一、初始探索阶段 — 文件夹迁移后的体检

### 1.1 担心:硬编码路径会因迁移失效?
**结论:误警 ✅**
- 代码全用相对路径 + 环境变量,**没有任何硬编码绝对路径**会因为迁移失效
- 文档里出现的 `/home/mystery/wherebear` 是**VM 上的路径**,与本地无关

### 1.2 项目级开发说明不完整
- 当时只有 `AGENTS.md` 的简短规则,缺少架构图/命令/约定
- **状态**:计划补全 → 被后续账单危机打断,未完成

### 1.3 文档自相矛盾:这是哪个比赛?
- README 写 "Google Cloud Rapid Agent Hackathon"
- AGENTS.md/PROGRESS.md 写 "MongoDB AI Agents Hackathon"
- **真相**:实际是 Google Cloud Rapid Agent + MongoDB Track(双重)

### 1.4 没有测试、没有 lint、没有 CI
- 验证全靠 `npm run build` 过 TypeScript
- **状态**:待办,未完成

---

## 二、容量体检 — Atlas M0 会撑爆吗?

### 2.1 担心:1.3 万商品逼近 512MB
**实测结论:不紧急 ✅**

| 指标 | 数值 |
|---|---|
| 总占用 | **181 MB / 512 MB = 35%** |
| products | 13,201 个 · 167 MB · avg 13.2 KB/个 |
| **缩略图** | 占 96% 数据 · 12.5 KB/个 |

- 还能涨到 ~3.5–4 万商品才会触顶
- **副产物**:`scripts/db-stats.mjs` 监控脚本可长期复用

### 2.2 隐含警告
- 缩略图是 96% 大头,随商品数线性增长
- **长期方案**:迁 GCS 只留 URL,或缩小尺寸
- **现在**:不动,等用到 ~70% 再处理

---

## 三、合规性确认 — 比赛规则到底要什么?

### 3.1 必须用 Vertex AI 还是 AI Studio 也行?
查阅 `rapid-agent.devpost.com/rules`,原文:
- ✅ "Build a functional agent—powered by **Gemini and Google Cloud** Agent Builder"
- ❌ "**All other artificial intelligence tools are not permitted**"

| 路径 | 合规度 |
|---|---|
| Vertex AI(Google Cloud)| ✅ 明确合规 |
| AI Studio(`generativelanguage` API)| ⚠️ 灰色地带 — 属 "Google AI" 不属 "Google Cloud" |
| 其他第三方 AI 服务 | ❌ 直接 DQ |

**结论**:**只能用 Vertex AI**,AI Studio 兜底有 DQ 风险

**🔄 2026-06-09 更新 — 第二条规则要求("built within Google Cloud Agent Builder")已落地**

原始搜索流是手写固定管道,既不是 ADK 也不是真 function-calling,落在"规则未明确允许也未明确禁止"的灰色地带,有 DQ 风险。**已通过把搜索 agent 迁到官方 `@google/adk` 上消除这个风险**:

- 新代码:`lib/agents/adk/`(tools / search-agent / run-search)
- 编排:ADK `LlmAgent` 驱动 Gemini function-calling
- MCP:MongoDB MCP server 通过 ADK `MCPToolset` 正式挂载(同时保留原 `lib/mcp/` 数据层走 `vector_search`)
- 接入:`/api/search` 默认走 ADK,`SEARCH_ENGINE=legacy` 一键回退
- 实测验证:`年糕` 查询完整跑通 `understand_intent → vector_search(via=mcp) → finish`,双语答案 "B5 货架的 Donghe White Rice Cake"

**4 条比赛硬要求现在全部满足**:Gemini ✅ / **ADK ✅(新)** / partner MCP ✅ / 无第三方编排器 ✅。

### 3.2 错过的紧急机会
- 规则提供 **$100 额度表单**,**6 月 4 日截止**(今天)
- 用户已经领过这 $100 且用完了 → 无法重领

---

## 四、🔥 核心问题:账单危机

### 4.1 旧账户状态
- 黑客松 $100 credit **已用完**
- 实际 Vertex 用量 **$188**(主要是一次性识别 1.3 万商品)
- 净欠 **CA$76** 比赛前无法支付
- 账号被 **dunning(欠费冻结)**
- Gemini API 调用直接 **403 PERMISSION_DENIED**
- 错误细节:`"Lightning dunning decision is deny for project: projects/257346160278"`

### 4.2 误警:旧账号还有 $1,366 没用?
用户截图发现 "Trial credit for GenAI App Builder" credit 还满,以为能救急。

**真相**:
- 它的 usage scope 写着 "Certain usage"
- **专给 GenAI App Builder 这个产品用**,不覆盖普通 `generateContent` 调用
- 在过去 30 天账单里,这笔 credit **一分钱都没出**(出钱的是已用完的比赛 credit)
- → **看得见,用不上**

### 4.3 30 天账单详情
| 服务 | 用量 | credit 抵扣 | 净欠 |
|---|---|---|---|
| Vertex AI | $188.31 | -$118.50 | **$69.80(大头)** |
| Compute Engine | $23.15 | -$17.57 | $5.58 |
| 其他 | ~$4 | ~-$4 | ~$0.36 |
| **合计** | | | **CA$75.76** |

**关键认知**:**钱花在 Gemini 调用,不是 VM**。

---

## 五、解决方案选择

### 候选

| 方案 | 优点 | 缺点 | 决定 |
|---|---|---|---|
| 救旧账户(付 $76) | 不用搬家 | 但 $1,366 credit 用不上,以后还是花钱;欠款也救不了已用完的比赛 credit | ❌ |
| AI Studio 兜底 | 免费、不绑卡、改 10 行代码 | 合规灰色 → DQ 风险 | ❌ |
| **新账号 $300 试用** | **完全合规、免费 90 天** | 需要新卡验证、要搬家 | ✅ |

### 兜底退路(写进代码但未启用)
`lib/gemini.ts` 加了 AI Studio 切换分支:有 `GEMINI_API_KEY` 走 Developer API,无则走 Vertex。**作为最后逃生通道留着**,生产不启用。

---

## 六、新账号迁移过程中的问题

### 6.1 gcloud 配置钉着旧项目
**症状**:用新账号执行 `gcloud projects list` → `PERMISSION_DENIED` 报旧项目
**原因**:gcloud 全局配置里 `core/project` 和 `billing/quota_project` 还指向 `wherebear-496400`
**解决**:
```bash
gcloud config unset project
gcloud config unset billing/quota_project
```

### 6.2 ⛔ 最大阻碍:机构域禁止 SA key
**症状**:`gcloud iam service-accounts keys create` 报错:
```
FAILED_PRECONDITION: Key creation is not allowed on this service account.
constraints/iam.disableServiceAccountKeyCreation
```

**原因**:新账号 `melody@hes.edu.kg` 是 edu 机构域,org policy 全局禁止建 SA key file

**绕过方案**:**改用 ADC(Application Default Credentials)**

| 环境 | 认证方式 |
|---|---|
| 本地 dev | `gcloud auth application-default login` + `set-quota-project` |
| 生产 VM | **挂载** SA `wherebear-vertex@...`,经 metadata server 自动 ADC |

**惊喜**:ADC 反而比 key file **更安全**、**更现代**、**不会泄漏到 git** —— 因祸得福

### 6.3 哪个项目挂了 billing?
新账号自动建了两个项目(都叫 "My First Project")。用 `gcloud billing projects describe` 逐个查:
- `acoustic-cargo-498500-q3` → `billingEnabled: true` ✅ **用这个**
- `atlantean-talon-498222-p2` → `billingEnabled: false` ❌

---

## 七、生产 VM 重建过程中的问题

### 7.1 选型决策:e2-medium 完全照搬旧规格
- 2 vCPU 共享 / 3.8 GB RAM(实际)/ 10 GB pd-balanced / Ubuntu 22.04
- 月度成本 ~$25,$300 试用够烧 12 个月

### 7.2 PM2 安装回显异常(误警)
- 装完后 `pm2 -v` 在终端片段里**回显为空**
- 担心装失败 → 后查实际版本 v7.0.1,**装得好好的**

### 7.3 ⚠️ Caddy 启动时 wherebear.help 还指着旧 IP
**症状**:Caddy 配好后,`wherebear.help` 的 HTTPS 握手 `tlsv1 alert internal error`
**根因**:Caddy 启动时 DNS 还指旧 IP,Let's Encrypt 验证失败 → **进入指数退避重试**
**解决**:DNS 切到新 IP 后,`sudo systemctl restart caddy` → **立即重签证书**
**好做法**:同时给 `nip.io` 域名配,确保 DNS 还没切前也有可用 HTTPS 入口验证

---

## 八、DNS 切换过程中的问题

### 8.1 www 记录初次没改
- 用户先改了 apex(`@`),漏掉 `www`
- **检测方法**:`dig @8.8.8.8 wherebear.help` vs `dig @8.8.8.8 www.wherebear.help`
- 用户改正后正常

### 8.2 macOS 系统 DNS 缓存导致**多次误判**
**症状**:我用 `curl https://wherebear.help/api/search` 报 403,**误以为有新 bug**
**真相**:
- `dig` 直查 → 新 IP ✓(权威 NS / 公共解析器都已更新)
- 但 macOS 系统解析器**仍缓存着旧 IP**
- `curl` 走系统解析器 → 打到**已停的旧 VM** → 403 PERMISSION_DENIED(旧项目)

**诊断三件套**:
```bash
dig +short wherebear.help                       # 公共 DNS 状态
dig +short @8.8.8.8 wherebear.help              # 跨解析器对比
curl --resolve wherebear.help:443:34.130.97.67 ... # 强制新 IP,绕过系统缓存
```

**解决**(用户需要做):
```bash
sudo dscacheutil -flushcache
sudo killall -HUP mDNSResponder
```

### 8.3 用 H1 "2" 标记可视化判断 DNS 切换
**创新点**:在新 VM 的源码 patch 个 "2" 标记
- 用户刷新页面看到 "2" → 知道 DNS 切到新 VM 了
- **关键**:**只在 VM 上 patch**,不污染本地 git 仓库
- 迁移完成后 `git checkout` 自动还原

---

## 九、旧项目止血 — 仅停 VM 不够!

### 9.1 还在偷偷扣钱的资源
盘点旧项目,即使 VM 停了仍计费:

| 资源 | 状态 | 月费 |
|---|---|---|
| VM 实例 | TERMINATED ✓ | $0 |
| **磁盘 20GB** | READY | ~$2/月 ⚠️ |
| **2 个自动快照**(06-03, 06-04)| 每天会自动新增 | 持续增长 📈⚠️ |
| 静态 IP | 0 个 | $0 ✓ |

### 9.2 最彻底方案:Unlink Billing
```bash
gcloud billing projects unlink wherebear-496400
```

**效果**:
- ✅ Google **无法**再对此项目扣任何钱
- ✅ **可逆**(想恢复随时重挂)
- ✅ **不删任何东西**(磁盘/快照/数据都还在,只是不计费)
- ✅ $76 欠款**冻结**(不会再涨)
- ⚠️ 重新挂 billing 必须先解决欠款

**为什么比删除好**:删除不可逆,unlink 完全等效于"暂停所有计费",还保留了"以后想翻东西"的可能

---

## 十、最终清理 — 安全与文档

### 10.1 ⚠️ 安全:gcp-key.old.json 险些泄漏
**症状**:迁移时备份的旧密钥文件出现在 `git status` 里(`??` 未跟踪)
**风险**:可能被误提交到**公开仓库**
**决定**:
- 旧项目已 unlink billing,密钥即使有效也调不通
- → **直接删除**,不留隐患
- `.gitignore` 已忽略 `gcp-key.json`,但 `.old.json` 未被覆盖

### 10.2 临时 "2" 标记移除
- 用户用它确认 DNS 切换后 → 立即移除
- VM 上 `git checkout` 恢复 + `npm run build` + `pm2 restart`

### 10.3 docs/DEPLOYMENT.md 全篇过时 → 重写
更新内容:
- 项目 ID(老 → 新)
- IP(34.130.215.212 → 34.130.97.67,且已 **静态预留**)
- 认证方式(key file → ADC)
- SA key 创建被 org policy 封的警告
- 旧项目状态说明(已 unlink billing)

---

## 十一、关键经验(以后避坑)

### 1️⃣ ADC 比 SA key file 更现代
- 机构域常禁止 SA key 创建
- ADC = 本地 `gcloud auth application-default login` + 生产挂载 SA
- 更安全(无文件可泄漏)、更通用(绕开 org policy)、更省事

### 2️⃣ 停 VM ≠ 止血
- 磁盘、快照、自动快照计划都会**持续计费**
- **unlink billing** 才是"只切计费不删数据"的根本方案
- 比单独停每个资源更可靠

### 3️⃣ DNS 改动有多层缓存
| 层 | 验证方法 |
|---|---|
| 权威 NS | `dig +short @ns1.example.com domain` |
| 公共解析器 | `dig +short @8.8.8.8 domain` |
| 本地系统缓存 | `curl domain` vs `curl --resolve domain:443:IP` |
| 浏览器缓存 | 强刷 / 无痕窗口 |

### 4️⃣ Caddy 证书时机敏感
- DNS 没切前启动 → 进入退避,卡几小时
- **顺序**:DNS 切完再启动,或切完后 `systemctl restart caddy`
- **保险**:同时配 `<IP>.nip.io` 备用域名,DNS 没切也有 HTTPS 入口

### 5️⃣ Credit 必看 usage scope
- "Certain usage" 不是装饰品
- $1,366 的"看得见用不到"教训
- 看 credit 必看适用范围,不能只看金额

### 6️⃣ 比赛规则要读原文
- 误以为 AI Studio 可以兜底
- 规则原文 "All other artificial intelligence tools are not permitted" 一句话堵死灰色地带
- 决策前要找规则原文,不要靠"应该可以"

### 7️⃣ 一次性大批量处理是花钱大头
- $188 Vertex 用量大头是**一次性识别 1.3 万商品**
- 数据录完后,日常搜索 + 偶尔拍照 **几美元/月就够**
- → 大动作前估算成本,有时分批/降批比一把梭便宜得多

### 8️⃣ 探索阶段并行 Explore agent 性价比高
- 一开始用 3 个 Explore agent 并行做整体体检
- 一次拿到架构 + 核心流程 + 项目状态全景,避免后续盲人摸象

---

## 十二、迁移成果总览

| 维度 | 迁前 | 迁后 |
|---|---|---|
| GCP 账号 | wonderfulrichard123@gmail.com(冻结) | melody@hes.edu.kg($300 试用) |
| 项目 | wherebear-496400 | acoustic-cargo-498500-q3 |
| Vertex 调用 | ❌ 403 dunning | ✅ 正常 |
| 公网 IP | 34.130.215.212(临时) | **34.130.97.67(已静态预留)** |
| 认证 | 服务账号 key 文件 | **ADC**(本地 user / 生产挂载 SA)|
| 旧项目计费 | 持续扣费 | **unlinked → 零扣费** |
| 欠款 | $76 持续涨 | 冻结不再涨 |
| 数据 | 13,201 商品 | **原样无损** |
| 域名 | wherebear.help | wherebear.help(DNS 已切)|
| 合规 | ✅ | ✅ |

---

## 附:核心命令速查

```bash
# 切账户/项目
gcloud config set account melody@hes.edu.kg
gcloud config set project acoustic-cargo-498500-q3

# ADC(本地一次性)
gcloud auth application-default login
gcloud auth application-default set-quota-project acoustic-cargo-498500-q3

# 部署
gcloud compute ssh wherebear-vm --project=acoustic-cargo-498500-q3 \
  --zone=northamerica-northeast2-b \
  --command "cd ~/wherebear && git pull && npm install && npm run build && pm2 restart wherebear"

# DNS 诊断
dig +short wherebear.help
curl --resolve wherebear.help:443:34.130.97.67 https://wherebear.help/api/health

# Mac DNS 缓存刷新
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder

# 容量监控(可复用)
node --env-file=.env.local scripts/db-stats.mjs
```
