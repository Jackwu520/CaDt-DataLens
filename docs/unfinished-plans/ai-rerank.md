# AI 重排（rerank）：价值验证 → 外部工具「重排」能力来源 + 双消费方注入（方案）

> 状态：**方案成文，未开工**（2026-11-17 评估定档；2026-11-21 两轮复核修订。阶段一可立即执行，阶段二/三待阶段一验证结论后开工）
> 决策依据：2026-11-17 讨论——①裸 embedding **不**做成 AI 工具（几百维浮点向量模型读不懂且 token 爆炸），只做 rerank 一层语义包装（query + 候选 → 分数排序）；②不做工作区全量语义索引（`docs/reports/optimization-proposals.md` 第四节明确否决 + SQLite 例外约束），rerank 是**临时计算**、无持久存储；③本地推理不进 exe（「单 exe、零依赖、系统提供引擎」红线），模型跑独立进程、应用只认 HTTP 端点；④rerank 工具**条件注册**（配了来源才下发），避免零配置用户的工具列表噪音。
> 2026-11-21 复核一——⑤插件 `cadt.registerTool` 已落地但**不改走托管路线**：原计划的 `plugins/local-reranker` 托管样例删除——0.5 GB 常驻模型进程 + 编排/探活服务一个狭窄场景，与「系统提供引擎」红线相悖；真实使用集中在远程 Cohere 形态端点。
> 2026-11-21 复核二（架构定稿）——⑥**应用不提供 rerank 能力本身，只提供注入点**：不做 `rerank` 内置能力、不内置模型、不托管进程——rerank 作为**外部工具能力来源**接入（与 OCR / ASR / TTS 同构：设置 → AI → 外部工具配一个来源，应用只管配置存储 + 可用性判定 + 工具注入，能力本体永远是用户侧端点或服务）。原「genModels 条目 `kind:'rerank'`」路线**废除**（避免与外部工具双轨；Cohere `/v1/rerank` 语义固定，不需要模板引擎吸收各家差异）。⑦**两个消费方**挂同一来源：通用 `rerank` 工具（search_text 命中过滤、多候选排序）+ `memory_search` 工具（长期记忆语义检索——记忆条目短、规模有界，几百条可全量送排，无需向量库、无需新 SQLite 例外）。
> 范围：阶段一 rerank 价值验证（搜索过滤 + 记忆检索双场景，零核心改动）· 阶段二 外部工具新增「重排」能力来源 · 阶段三 `rerank` / `memory_search` 双工具条件注册

## 1. 背景与现状（代码事实，2026-11-21 复核）

### 1.1 执行通道与注入机制

- **传输用哑通道**：`AIGenHTTPRequest(specJSON) → aigen.HTTPResult{Status, Body, Error}`（ai_gen_app.go:12 → internal/aigen/aigen.go:101）：按前端组装好的规格发同步 HTTP，**非 2xx 也回体**（aigen.go:57 注释），错误摘要带 `*KEY*` 形态脱敏，支持自定义 headers / timeout / proxy。rerank 是同步 JSON 请求/响应，b64 / 落盘 / 轮询链整段跳过——执行侧 Go 零改动。
- **注入点照抄外部工具先例**（ai-tool-defs.js `toolsForScope`）：`externalOn('search')` / `externalOn('fetch')` / `externalOn('ocr')` / `externalOn('asr')` / `externalOn('tts')` 各控制一个工具的下发（如 :1176 附近 `if (ctx.externalToolsOn && externalOn('ocr')) list.push(AI_TOOL_DEFS.ocr)`），rerank 照抄一行 `externalOn('rerank')`。工具链调用点已全部收敛经 ai-panel.js:6942 wrapper（token 估算 :6117 / 请求载荷 :11802 / 会话刷新 :11987 / allowedTools :12520），条件注册只动一处。
- **能力来源矩阵**：配置存 `<应用数据>/external-tools.json`（`webtools_config.go` 管理，0600、apiKey 只掩码下发、空值保持），前端 `ai-external-tools.js` 纯函数做配置归一化 / 实际来源判定（provider 缺 key 按 off）/ 按权限档可用性 / 结果格式化；设置页 `settings-pane-external-tools.js` 渲染能力来源矩阵 + 服务提供商配置。
- 记忆现状：`memory_list` / `memory_read` 拉取式工具（记忆条目在 `.cadt/memory/`），AI 主动列、主动读——语义检索是缺位的一环。

### 1.2 本地运行事实（Qwen3-Reranker-0.6B，仅作文档附录素材）

- llama.cpp `llama-server -m reranker.gguf --reranking` 原生暴露 `POST /v1/rerank`（Cohere 兼容形态：请求 `{model, query, documents[], top_n?}` → 响应 `results[]: {index, relevance_score}`）。社区 GGUF 量化齐全。
- 0.6B Q4_K_M ≈ 0.44 GB；20 候选 × ~300 token prefill 现代 CPU 秒级——这是**用户自备自管**的运行事实，应用侧零托管。
- Cohere 风格 `/v1/rerank` 是事实标准：llama-server、SiliconFlow、Jina、自建网关同一形态——能力来源固定语义（不搞模板），远程与本地自托管同一套配置。

### 1.3 问题（两个消费方）

- **通用**：`search_text` 是 rg 词面搜索，命中上百行时模型要整段读进上下文自己筛，token 贵且容易漏；多候选文件挑选缺一个「语义排序」手段。
- **记忆**：记忆条目积累几十上百条后，`memory_list` 全量列出再让模型自己挑，既是 token 负担也是漏检源；缺一个「按当前意图取 top-K 记忆」的语义入口。记忆条目短（一句话级）、规模有界（≤千条），是 cross-encoder 的舒适区；几百条可**全量送排、临时计算、不留持久存储**——不触工作区语义索引禁令，也不需要向量库。

## 2. 目标与非目标

### 阶段一：价值验证（零核心改动，可立即执行）

1. 手工对照协议跑 4 个场景（搜索过滤 3 个 + 记忆检索 1 个），对远程网关，零基础设施。
2. 可选：薄探针插件（`registerTool` 注册 rerank 透传工具）让 AI 真实会话自主调用，观察使用频率。

### 阶段二：外部工具新增「重排」能力来源

1. 设置 → AI → 外部工具加「重排」能力行：自定义端点来源（baseURL / path / apiKey / model / defaultTopN / timeout / proxy），Cohere 形态固定语义。
2. `ai-external-tools.js` 加归一化 / 可用性判定 / 结果格式化纯函数；`webtools_config.go` 配置 schema 加一个能力段（**全方案唯一 Go 触点，小改动**）。
3. 零新依赖、零 vendor 增量、不动 genModels。

### 阶段三：双消费方工具条件注册

1. `rerank` 工具（通用语义排序）与 `memory_search` 工具（记忆语义检索）均按「重排来源已配置且可用」条件下发——来源没配，工具不存在（外部工具口径：关闭时不注册）。
2. 注入机制照抄 OCR 先例：`if (ctx.externalToolsOn && externalOn('rerank')) list.push(...)`。

### 非目标（全阶段，明确排除）

- **不提供 rerank 能力本身**：不内置模型、不打包推理引擎 / GGUF / Python 运行时、不托管进程（原 `plugins/local-reranker` 样例已裁撤；社区要编排可用 `registerService` + `registerTool` 自行实现）。
- **不做裸 embedding 工具**；embedding 将来只作为「召回 + 精排」两段式的内部实现再议（记忆量上千、全量送排变慢时才需要）。
- **不做工作区语义索引/向量库**（否决方向 + 需新 SQLite 例外）；`memory_search` 全量送排 + 临时计算，无持久存储。
- **不动 genModels**（不新增 `kind:'rerank'`，避免与外部工具能力来源双轨）。
- **不做注入式自动记忆**（每回合自动检索记忆塞进系统上下文——触发策略与 token 预算需单独设计，将来另立方案；本方案只做工具式拉取）。

## 3. 阶段一：价值验证（零核心改动）

### 3.1 手工对照协议（对远程网关）

| 场景 | 做法 | 看什么 |
|---|---|---|
| A 宽泛词命中过滤 | `search_text` 宽泛词拿 ~100 命中行；行文本作 `documents`、意图作 `query` 调 `/v1/rerank` top 10；再让聊天模型从同样 100 行直接挑 10 | top10 重合率、漏检、token 消耗 |
| B 多候选文件挑选 | 20 个候选文件各取前 N 行作 documents，query 为需求描述 | 排序质量 |
| C 词面搜不到 | 用不含关键词的语义描述作 query，去重排 rg 结果 | 能否捞起词面搜不到的相关项 |
| D 记忆检索 | 取真实记忆条目 50 条，10 个真实意图 query；对照「全量列表给模型自己挑 top-5」vs「rerank top-5」 | 命中率、漏检、token 消耗 |

直接调网关验证连通与形态（模型名以网关实际为准）：

```bash
curl http://<网关地址>:<端口>/v1/rerank -H "Content-Type: application/json" \
  -d '{"model":"<网关rerank模型名>","query":"<意图描述>","documents":["<文本1>","<文本2>"],"top_n":5}'
# 期望：{"results":[{"index":0,"relevance_score":0.98},...]}
```

### 3.2 探针（可选）

- **首选：薄插件**（已落地：`plugins/rerank-probe/`，2026-11-21）：`cadt.registerTool({name:'rerank', parameters:{query, texts, top_n}, execute(args)})`，execute 内对网关透传（页面 fetch 主路径，实测网关 CORS 放行 `access-control-allow-origin: *`；被拒时兜底 `cadt.runCommandSync` 调系统 `curl.exe`）；配置（端点/key/模型）与调用计数存 localStorage，面板在 设置 → 插件设置 → 重排探针。授权走现成三层链。**验证工具不随应用分发**，验证结束可整目录删除。
- 备选：stdio MCP server（80 行 Python，mcp.json 手动挂载）。
- 不进 `docs/mcp-samples`、不动 `mcp_samples.go`；验证后不收编（阶段三的内置工具即是分发形态）。
- 探针价值：`activity` 留痕与会话日志是「真在用」的证据来源；工具名天然区分消费方，判据可分开计量。

### 3.3 判据（决定阶段二/三是否开工）

- **开工**：两周自然使用窗口（起点 = 探针落地日；纯手工协议则为首次对照实验日）内，`rerank` 类调用 ≥ 10 次**且**结果被采纳过半；场景 D 中 rerank top-5 命中率不低于模型自判且省 token。
- **不开工**：调用寥寥或质量无差——方案归档，结论到本节为止，「重排」能力来源不落地。
- **验证记录（2026-11-21）**：手工对照协议已跑完——连通/形态验证通过（冷 2.3s / 热 0.3–1.2s）；场景 A 重合 7/10、rerank top-5 质量不劣于模型自判、时延 1.15s、prefill 11.7K token（0.6B 可忽略）；场景 D 3/3 top-1 正确且**分数即天然阈值**（≥0.9 相关 / ≤0.003 无关，含一个「六条记忆都覆盖不了」的负例）。质量闸：**通过**。使用闸：待探针在应用内配置授权后的两周窗口。完整报告与数据：`.cadt/tmp/rerank-validation/report.md`（含两条坑：控制台 GBK 中文载荷须走 UTF-8 文件；网关换档 409 需 15s 重试）。

## 4. 阶段二：外部工具新增「重排」能力来源

### 4.1 配置模型（`external-tools.json` 新增能力段）

```js
{
  // ...既有 search/fetch/ocr/asr/tts 各段...
  rerank: {
    enabled: false,
    baseURL: 'http://<端点>:<端口>',     // 远程网关或本地 llama-server 均填这里
    path: '/v1/rerank',
    apiKey: '',                          // 0600 存储、只掩码下发（既有机制）
    model: 'qwen3-reranker-0.6b',        // 固定语义：模型名由来源配置指定，工具不带 model 参数
    defaultTopN: 10,
    timeoutSec: 60, proxy: 'system'
  }
}
```

- 请求体固定 Cohere 形态，前端组装（纯函数）：`{"model":{{model}},"query":{{query}},"documents":{{texts}},"top_n":{{topN}}}`——无模板引擎、无占位符白名单，一条 10 行纯函数搞定转义。
- 执行走 `AIGenHTTPRequest` 哑通道（前端组装完整 spec：method/headers/body/timeout/proxy），Go 执行侧零改动。

### 4.2 前端改动面

- `ai-external-tools.js`：归一化（enabled + baseURL 缺一按 off）、实际可用判定、`formatRerankResult` 纯函数（按分降序 `#原序号 分数 前80字符`；端点未回文档时按 index 回填入参文本）——均配单测。
- `settings-pane-external-tools.js`：能力来源矩阵加「重排」行 + 端点编辑器（仿 OCR/ASR 行结构）；来源说明文案写明**数据出境语义**（候选文本会上传到所配端点；本地 llama-server 则不出机器）。
- `dev/mock-backend.js`：补 rerank 能力 mock + `/v1/rerank` 路由（漏了 dev 模式调用即崩）。

### 4.3 Go 触点（全方案唯一）

- `webtools_config.go`：external-tools.json schema 加 `rerank` 段（掩码/空值保持逻辑复用既有能力段代码路径）。其余 Go 侧零改动。

### 4.4 测试面

- `ai-external-tools.test.mjs` 扩：归一化 / 可用性（缺 key、缺 baseURL、enabled 关）/ 格式化（乱序 results、缺文档回填、分数并列稳定排序）。
- 请求体组装纯函数测试：转义（引号/换行/unicode）、多元素、topN 边界。

## 5. 阶段三：双消费方工具条件注册

### 5.1 `rerank` 工具（通用语义排序）

| 项 | 设计 |
|---|---|
| def（`AI_TOOL_DEFS`） | 参数 `query*`（string）、`texts*`（string 数组，≤100 条、单条 ≤8000 字符、总量 ≤256KB）、`top_n?`（1–100，缺省用来源 `defaultTopN`）。description 写清「何时用」（search_text 命中 >50 时的语义过滤、多候选排序）与「何时不用」（少量候选直接自己读，不要调；候选文本会上传到所配端点） |
| 目录 | 单列或与外部工具同组，实施时定（组标题改动核对 `ai-tool-defs.test.mjs` 精确断言 + 设置搜索索引） |
| **条件下发** | `if (ctx.externalToolsOn && externalOn('rerank')) list.push(AI_TOOL_DEFS.rerank)`（照抄 ocr 行）；计划模式不注入（外部副作用口径）；子代理不下发 |
| executeTool | 组装固定请求体 → `AIGenHTTPRequest` → 判错 → `formatRerankResult` 格式化；结果即字符串；副数据挂 `toolMessage.gen` 供工具卡渲染 |
| 审批 | 归 kind `'web'`：read/edit 档弹卡（远程端点花钱 + 数据出境确认；本地 llama-server 同规则不豁免）、auto/full 直发、项目规则可按来源 allow/ask/deny |
| 登记/测试 | def + 目录 + 档位清单 + executeTool case + mock 同名 mock + `ai-tool-cards` verb/icon + 纯函数测试（def↔目录↔执行↔卡片一致性守卫强制） |

### 5.2 `memory_search` 工具（记忆语义检索）

| 项 | 设计 |
|---|---|
| def | 参数 `query*`（string，意图描述）、`top_n?`（缺省 5）。description：按当前任务意图检索长期记忆 top-K；何时用（开始新任务前、涉及用户偏好/历史决定时）与何时不用（memory_list 全量更合适时） |
| 数据通路 | 复用 `memory_list` / `memory_read` 既有绑定取条目文本；条目数 ≤ 上限（建议 200，未决项）时全量送排，超出取最近更新优先截断；**纯临时计算，不落任何派生存储** |
| 条件下发 | 同 `rerank`（同一能力来源 gating），memory 组内紧挨 memory_list/memory_read |
| 排序合成 | rerank 相关性分 + 既有记忆排序信号（置顶/分组序）合成最终序——rerank 只提供相关性一票，新鲜度/矛盾处理不在本工具职责内（description 写明「结果可能含过期条目」）。**场景 D 实测：分数即天然阈值**（相关 ≥0.9 / 无关 ≤0.003）——top 分数过低时直接回「无相关记忆，不要凭空猜」，不注入垃圾上下文 |
| 审批 | 同 `rerank`（kind `'web'`，记忆内容同样会上传出境） |

### 5.3 本地自托管参考（文档附录素材，写给用户；应用侧零托管）

```bash
# llama.cpp（单 exe，用户自备）+ Qwen3-Reranker-0.6B GGUF（Q4_K_M ≈ 0.44 GB）
llama-server -m Qwen3-Reranker-0.6B-Q4_K_M.gguf --reranking --port 8080
# 设置 → AI → 外部工具 → 重排：baseURL http://127.0.0.1:8080 · path /v1/rerank
```

- CPU 可跑（20 候选秒级）、任意独显亚秒；显存 Q4 < 1 GB。进程生命周期用户自理，应用只认 HTTP 端点。
- llama-server 单实例可用 models.ini 同时托管 embedding + rerank + chat——将来「召回 + 精排」两段式复用同一能力来源。

## 6. 未决项

1. `memory_search` 条目规模上限（建议 200）与截断策略（最近更新优先）实施时实测定。
2. `texts` 上限**定为** 100 条 / 单条 8000 字符 / 总量 256KB；实施实测 token 预算只紧不松。
3. 判据**定为** §3.3 现值（两周 / ≥10 次 / 采纳过半 + 场景 D 命中率不劣且省 token）；验证期内调整需记录到本节。
4. `rerank` 工具目录分组位置（单列 vs 外部工具同组）实施时定，改组标题需同步精确断言与设置搜索索引。
5. 阶段一探针插件的 `fetch` 依赖网关 CORS 响应头——实施探针时先实测，被拒走 `runCommandSync` curl 兜底（见 §3.2）。
6. 「重排」能力来源是否首版支持 MCP 绑定（与 OCR/ASR 的来源矩阵对齐）——倾向首版仅自定义端点，MCP 绑定待真实需求。
