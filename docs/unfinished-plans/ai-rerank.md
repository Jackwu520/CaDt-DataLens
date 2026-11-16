# AI 重排（rerank）：价值验证 → 预留条目入口 → 插件托管 + 条件注册工具（方案）

> 状态：**方案成文，未开工**（2026-11-17 评估定档；阶段一可立即执行，阶段二/三待阶段一验证结论后开工）
> 决策依据：2026-11-17 讨论——①裸 embedding **不**做成 AI 工具（几百维浮点向量模型读不懂且 token 爆炸），只做 rerank 一层语义包装（query + 候选 → 分数排序）；②不做工作区全量语义索引（`docs/reports/optimization-proposals.md` 第四节明确否决 + SQLite 例外约束），rerank 是**临时计算**、无持久存储；③本地推理不进 exe（「单 exe、零依赖、系统提供引擎」红线，与生图接 ComfyUI 同一逻辑），模型跑独立进程、应用只认本地 HTTP；④rerank 工具**条件注册**（配了启用条目才下发），避免零配置用户的工具列表噪音（对照：`generate_image` / `generate_video` 是四档常驻下发，rerank 不照抄）。
> 范围：阶段一 rerank 价值验证协议（零核心改动）· 阶段二 genModels 条目扩展 `kind: 'rerank'`（预留入口）· 阶段三本地 reranker 托管插件样例 + `rerank` 工具条件注册

## 1. 背景与现状（代码事实）

### 1.1 执行通道：哑通道原样可用，Go 零改动

- `AIGenHTTPRequest(specJSON) → aigen.HTTPResult{Status, Body, Error}`（ai_gen_app.go:12 → internal/aigen/aigen.go:98）：按前端渲染好的规格发同步 HTTP，**非 2xx 也回体**（aigen.go:57 注释），错误摘要带 `*KEY*` 形态脱敏。rerank 是同步 JSON 请求/响应，不需要 b64 解码、落盘、轮询——`AIGenSaveProducts` 产物链整段跳过，Go 侧零改动。
- 模板渲染 / 提取 / 归一化全在前端 `ai-gen-model.js`：`GEN_KINDS = ['image', 'video']`（:6）、`GEN_PLACEHOLDERS = ['prompt','model','size','n','seed','apiKey','jobId','images']`（:11），未知占位符直接 throw（:254-267）；`defaultGenModelOf`（:118）取同 kind 首个启用条目、`moveGenModelWithinKind` 组内重排不串组。
- 设置页 `ai-gen-settings.js`：条目卡片列表 + 编辑器状态机 + 测试连接；分组渲染已按 kind（「生图 N 条 / 视频 N 条」组头 + `#n` 缺省徽标）。
- 工具链调用点：ai-panel.js:5995 本地 wrapper `(scope, planMode) => toolDefsMod.toolsForScope(scope, planMode)` → :10019 请求载荷、:10167 会话刷新、:10471 allowedTools 都经 wrapper；**:5042（token 估算）直接调 toolDefsMod**——条件注册收口时必须一并改走 wrapper，否则估算与实发不一致。
- 插件 API（plugins.js `apiFor`）：`addCommand({id,label,run})`（工具菜单命令）、`runCommand({exe,args,cwd,onOut,onErr,onExit}) → {stop()}` / `runCommandSync`（**插件可起进程**）、`registerCommandClassifier` / `registerAIProvider` / `registerFormat` / `addTheme` / `registerIconTheme` / `flash` 等。**没有「注册 AI 工具」的 API**——插件能托管进程，但消费闭环必须靠应用侧入口，纯插件方案不成立。
- 插件形态：`plugins/scene-carousel/plugin.json`（`{id, name, version, author, description, license, entry, icon, keywords}`）+ main.js IIFE，`cadt.*` 注入。

### 1.2 本地运行事实（Qwen3-Reranker-0.6B）

- llama.cpp `llama-server -m reranker.gguf --reranking` 原生暴露 `POST /v1/rerank`（Cohere 兼容形态：请求 `{model, query, documents[], top_n?}` → 响应 `results[]: {index, relevance_score}`）。社区 GGUF 量化齐全（HF Mungert / ModelScope dengcao 等）。
- 0.6B Q4_K_M ≈ 0.4–0.5 GB（F16 ≈ 1.2 GB）；20 候选 × ~300 token prefill 在现代 CPU 上秒级、任意独显亚秒——agent 用途完全可接受。
- Cohere 风格 `/v1/rerank` 是事实标准：llama-server、SiliconFlow、Jina、自建网关同一形态——**一套条目模板通吃本地与远程**，正是 gen-models「通用模板吸收各家差异」的设计意图。

### 1.3 问题

- `search_text` 是 rg 词面搜索，命中上百行时模型要整段读进上下文自己筛，token 贵且容易漏；缺一个「语义过滤 top-K」的廉价手段。
- rerank 是 RAG 管线组件，价值场景狭窄（候选 < 20 时模型自判更准更省），直接内置工具性价比低——但用户侧有真实本地算力（0.6B 可本地跑）与既有网关（`/v1/rerank`），值得用「先验证、再预留、后接线」的三步走控制投入。

## 2. 目标与非目标

### 阶段一：价值验证（零核心改动，可立即执行）

1. 给出可执行的手工对照协议（模型自判 vs `/v1/rerank`），在有真实工作区的会话里跑 2–3 个场景。
2. 可选：写一个通用 rerank MCP 探针脚本（本地任意目录手动挂载，**不动 `docs/mcp-samples` 与 `mcp_samples.go`**），让 AI 在真实会话里自主调用，观察真实使用频率。

### 阶段二：预留条目入口（`kind: 'rerank'`，不下发工具）

1. `genModels[]` 支持 `kind: 'rerank'`：设置页「重排」分组、精简编辑器、测试连接；条目形态对齐 Cohere `/v1/rerank`，本地 llama-server 与远程服务商同一模板。
2. **Go 零改动**；AI 工具暂不下发（预留状态，pane 描述文案写明）。
3. 零新依赖、零 vendor 增量。

### 阶段三：插件托管样例 + `rerank` 工具条件注册

1. `plugins/local-reranker/` 样例插件：拉起/探活/停止本地 llama-server，状态提示；纯新增目录、零核心改动。
2. `rerank` AI 工具条件注册：配了启用的 rerank 条目才进工具清单；审批、目录登记、mock、测试全套按 2026-11-15/16 作者规则。

### 非目标（全阶段，明确排除）

- **不做裸 embedding 工具**（向量输出对模型负价值）；embedding 将来只作为重排条目的内部实现形态之一（embedding + 余弦兜底）再议。
- **不做工作区语义索引/向量库**（否决方向 + 需新 SQLite 例外）。
- **不打包推理引擎或模型文件**（llama.cpp、GGUF、Python 运行时一律用户自备）。
- 不新建独立的 `rerankModels[]` 配置段（复用 genModels 条目机制，避免双轨）。
- 不做插件加载即自动拉起模型进程（0.5 GB 模型进程属惊吓行为，显式命令触发）。

## 3. 阶段一：价值验证（零核心改动）

### 3.1 手工对照协议

三个场景各跑一轮「模型自判 vs rerank」对照，用真实工作区：

| 场景 | 做法 | 看什么 |
|---|---|---|
| A 宽泛词命中过滤 | `search_text` 一个宽泛词拿 ~100 命中行；命中行文本作 `documents`、意图描述作 `query` 调 `/v1/rerank` top 10；再让聊天模型从同样 100 行直接挑 10 | top10 重合率、漏检、token 消耗 |
| B 多候选文件挑选 | 20 个候选文件各取前 N 行作 documents，query 为需求描述 | 排序质量 |
| C 词面搜不到 | 用不含关键词的语义描述作 query，去重排 rg 结果 | 能否捞起词面搜不到的相关项 |

直接调网关验证连通与形态（模型名以网关实际为准）：

```bash
curl http://127.0.0.1:11437/v1/rerank -H "Content-Type: application/json" \
  -d '{"model":"<网关rerank模型名>","query":"<意图描述>","documents":["<文本1>","<文本2>"],"top_n":5}'
# 期望：{"results":[{"index":0,"relevance_score":0.98},...]}
```

### 3.2 MCP 探针（可选，一次性脚本）

- 写 `rerank-generic.py`（stdio MCP server，约 80 行）：环境变量 `RERANK_BASE_URL / RERANK_API_KEY / RERANK_MODEL`，工具 `rerank(query, documents, top_n)` 对任意 Cohere 形态端点透传。
- 存本地任意目录，在 设置 → AI → 外部工具 → MCP 服务器 手动挂载（不进 `docs/mcp-samples`、不动 `mcp_samples.go` embed 列表；若验证后值得随应用分发，阶段三再收编）。
- 探针的价值：真实会话里 AI 能自主调用，`activity` 留痕与会话日志就是「真在用」的证据来源，比手工实验有说服力。

### 3.3 判据（决定阶段二/三是否开工）

- **开工**：两周自然使用窗口内 AI 主动调用 ≥ 10 次，且结果被采纳过半（场景 A/B 中 rerank top-K 明显优于或稳定等于模型自判、且省 token）。
- **不开工**：调用寥寥或质量无差——方案归档结论到本节为止，`kind: 'rerank'` 不落地。

## 4. 阶段二：预留条目入口（`kind: 'rerank'`）

### 4.1 条目模型（`ai-config.json` 顶层 `genModels[]` 复用）

```js
{
  id: 'gen-xxx', name: '本地 Qwen3-Reranker-0.6B',
  kind: 'rerank',                  // 新增第三种 kind：决定分组、编辑器显隐与（阶段三）工具
  enabled: true,
  // ---- 连接（全部复用）----
  baseURL: 'http://127.0.0.1:8080', path: '/v1/rerank',
  proxy: 'system', timeoutSec: 60, apiKey: '', headers: [{key:'Authorization', value:'Bearer {{apiKey}}'}],
  // ---- 输入模板（texts 渲染为 JSON 数组字面量）----
  bodyTemplate: '{"model":{{model}},"query":{{query}},"documents":{{texts}},"top_n":{{topN}}}',
  // ---- 输出（无产物形态概念）----
  resultPath: 'results',           // 整段 results 数组（{index, relevance_score}）回给格式化层
  errorPath: 'error.message',
  defaultModel: 'qwen3-reranker-0.6b', defaultTopN: 10,
  // resultType / submitPath / pollPath / statusPath ... 对 rerank 不适用：
  // 归一化时清空、编辑器隐藏（rerank 仅同步、无产物）
}
```

### 4.2 前端改动面

- `ai-gen-model.js`：`GEN_KINDS` 加 `'rerank'`（:6）；`GEN_PLACEHOLDERS` 加 `query / texts / topN`（:11）——`texts` 渲染为 JSON 数组字面量（元素逐项转义，约 10 行纯函数），`topN` 数字字面量（模板不写引号的既有约定天然正确）；`normalizeGenModel` 对 `kind:'rerank'` 清空 resultType 与异步段字段。
- `ai-gen-settings.js`：类型下拉加「重排」；分组渲染加「重排 N 条」组头（空组说明卡同生图/视频）；编辑器按 kind 显隐——rerank 隐藏产物形态 row 与异步段、显示缺省 topN row；测试连接对 rerank 发最小请求（query + 2 条短文本），回耗时与分数校验。
- **pane 描述文案同步**（2026-11-16 教训：文案是工具的一部分）：「生成条目」描述补一句 rerank 条目语义与当前预留状态（工具暂未下发，仅供测试连接与后续版本）。
- 设置搜索索引自动收录（settings-search 扫 `.set-row`）；`ai-settings-io.js` 导入导出零改动（genModels 整段在白名单，kind 自然带上）。
- `dev/mock-backend.js`：补 rerank 条目 mock + `/v1/rerank` 路由（漏了 dev 模式调用即崩）。

### 4.3 测试面

- `ai-gen-model.test.mjs` 扩：`texts` 数组渲染（含转义/多元素）、rerank 归一化清空不适用字段、`defaultGenModelOf('rerank')`、`moveGenModelWithinKind` 三组互不干扰。
- 预设表加「通用 rerank（Cohere 形态）」预设 + 「通用自定义」。

## 5. 阶段三：插件托管样例 + `rerank` 工具条件注册

### 5.1 `rerank` 工具（条件注册）

| 项 | 设计 |
|---|---|
| def（`AI_TOOL_DEFS`） | 参数 `query*`（string）、`texts*`（string 数组，≤100 条、单条 ≤8000 字符、总量 ≤256KB）、`top_n?`（1–100，缺省用条目 `defaultTopN`）、`model?`（条目名或 `#n`，缺省 = 首个启用 rerank 条目）。description 写清「何时用」（search_text 命中 >50 时的语义过滤、多候选挑选）与「何时不用」（少量候选直接自己读，不要调） |
| 目录 | 进 gen 组；组标题「生图与视频」→「生图 · 视频 · 重排」（`ai-tool-defs.test.mjs` 精确断言同步） |
| **条件下发** | `toolsForScope` 基座清单追加 rerank，但仅当**存在启用的 rerank 条目**——收口点 ai-panel.js:5995 wrapper（按会话 ctx 里的 genModels 状态过滤），**:5042 估算一并改走 wrapper**；:10019/:10167/:10471 已走 wrapper 自然生效。计划模式白名单不含；子代理不下发（候选过滤主代理场景为主） |
| executeTool | 渲染模板 → `AIGenHTTPRequest` → `errorPath` 判错 → `resultPath` 提取 → 格式化纯函数（按分降序 `#原序号 分数 前80字符`；端点未回文档时按 index 回填入参文本）。结果即字符串（对齐工具结果形状）；副数据挂 `toolMessage.gen` 供工具卡渲染 |
| 审批 | 归 kind `'web'`（`generate_*` 先例，`webRuleSubject = 'gen:<entryId>'`）：read/edit 档弹卡（远程端点花钱确认；本地 llama-server 同规则，不做豁免）、auto/full 直发、项目规则可按条目 allow/ask/deny |
| 登记/测试 | def + 目录 + 档位清单 + executeTool case + mock 同名 mock + `ai-tool-cards`/格式化纯函数测试（2026-11-15 作者规则：def↔目录一致性测试强制） |

### 5.2 插件样例 `plugins/local-reranker/`

- 结构仿 scene-carousel：`plugin.json`（`{id:'local-reranker', name, version, entry:'main.js', keywords}`）+ `main.js` IIFE + `README.md`。
- 配置存 localStorage（key 前缀 `cadt-plugin-local-reranker.`）：`llamaServerPath`（llama-server.exe 路径）、`modelPath`（GGUF 路径）、`port`（缺省 8080）、`extraArgs`。
- 行为：`addCommand('启动本地重排服务')` → `cadt.runCommand` 拉起（`onOut` 探测监听输出，兜底轮询 `/v1/rerank` 探活）→ `cadt.flash('重排服务已就绪 http://127.0.0.1:8080')`；`addCommand('停止本地重排服务')` → `stop()`。进程句柄存插件闭包，重复启动先 stop 再拉。
- **边界说清**：插件不写 genModels 条目（无此 API）——条目仍由用户在设置页手动建、指向 `127.0.0.1:端口`；插件只管进程编排与状态提示。
- 可选收编：阶段一的探针脚本若值得随应用分发，移入 `docs/mcp-samples/` 并同步 `mcp_samples.go` embed 列表（随 exe 内嵌，约几 KB）。

### 5.3 本地运行参考（文档附录内容，写给用户）

```bash
# llama.cpp（单 exe，用户自备）+ Qwen3-Reranker-0.6B GGUF（Q4_K_M ≈ 0.44 GB）
llama-server -m Qwen3-Reranker-0.6B-Q4_K_M.gguf --reranking --port 8080
# 设置页条目：baseURL http://127.0.0.1:8080 · path /v1/rerank
```

- CPU 可跑（20 候选秒级）、任意独显亚秒；显存占用 Q4 < 1 GB。
- llama-server 单实例可用 models.ini 同时托管 embedding + rerank + chat——将来 embedding 入口复用同一套条目机制。

## 6. 未决项

1. **旧版兼容**：`normalizeGenModel` 现状对未知 kind 回退 `'image'`（ai-gen-model.js:63）——旧 exe 读到 rerank 条目会静默变形。实施阶段二时改为「未知 kind 保留但强制 `enabled:false`」还是维持回退，实施时定（倾向前者）。
2. `texts` 上限数值（100 条 / 8000 字符 / 256KB）按实际 token 预算复核。
3. 阶段一判据里的时间窗与调用次数（两周 / ≥10 次）是初始值，验证期可调。
4. gen 组标题改动会影响设置页工具目录与 `<tool_catalog>` 的文案，实施时核对设置搜索索引。
