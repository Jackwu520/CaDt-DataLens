# AI 生图与视频生成模型（genModels + generate_image / generate_video）（方案）

> 状态：**已实施**（2026-11-15 评估成文并当日落地；原 `docs/unfinished-plans/ai-gen-models.md`，实施后移入）
> 决策依据：2026-11-15 评估定档——①生图与视频**一批实现**（异步引擎按产物类型无关设计，视频不拆二期）；②`generate_image` / `generate_video` 工具审批**按写工具档**（read/edit 弹审批卡、auto/full 直发，项目规则可改）；③产物落盘工作区 `.cadt/gen/`，走 Go 专用通道（`write_worklog` / `propose_patch` 免写审批先例）
> 范围：独立设置页配置生图/视频模型（通用输入输出模板 + 自定义模板）；封装 AI 内部工具；产物落盘与消息流预览；可选 vision 回传
> **实施偏差（对 §3.3/§3.4）**：模板渲染 / 响应提取 / 轮询循环全部收进前端纯函数层（`ai-gen-model.js` 单实现单测试套），Go 侧保持**哑通道**——只提供 `AIGenHTTPRequest`（按前端渲染好的规格发同步 HTTP）与 `AIGenSaveProducts`（产物解码/下载 + 工作区路径校验落盘）两个通用绑定，不建 Go 侧 job 注册表（Go 与前端同进程同生死，注册表无跨进程价值）；异步轮询循环在前端（`ai-gen-jobs.js`），完成经 `deliverAgentNotice` 信箱唤醒归属会话。纯函数测试与轮询逻辑可单测，Go 侧表驱动测试走 httptest 回环。

## 1. 背景与现状（代码事实）

### 1.1 现有基础

- **配置层（前端真源）**：`ai-config.json` 由前端组装整段 JSON，Go 只做整文件存取（`aiconfig.go:57` 原子写 0600、`aiConfigFileMax` 1MB 上限，不解析 schema）。`normalizeAIConfig`（ai-panel.js:652）显式枚举顶层键，新增 `genModels[]` 仿 `persona`（:710，纯函数归一）即可，缺字段即默认态、**零迁移**。
- **设置页**：AI 助手设置是主设置对话框 `#dlg-settings` 的 AI 分组子 pane（index.html:275-281，现有 `models|ai|persona|context|preferences|schedules|permissions` 7 个）。新 pane 要动 4 处：index.html 导航项 + pane 结构、settings-ui.js 两处 pane 名单（:627 AI 分组展开、:643/:648 AI refresh）、ai-panel.js `opt` 控件映射（:351 起）；设置搜索索引自动收录（settings-search.js 扫 `.settings-pane` 内 `.set-row`）。子域工厂模式现成：`createAIModelSettings`（ai-model-settings.js）+ `bindSettingsPane` 字段绑定（ai-settings-dialog.js:389-1051）。
- **表单控件硬规范**：一律走 `core/form-controls.js` 工厂（createSwitch/createSelect/createInput/createTextarea）或 `docs/frontend-form-controls.md` 静态 class 结构；`form-controls-factory.test.mjs` 按文件基线卡新增裸控件（新文件不登记直接失败）。
- **工具链**：`AI_TOOL_DEFS`（ai-tool-defs.js:8-659，def 对象原样进 API 载荷、键必须恰好 `description/name/parameters`）+ `AI_TOOL_CATALOG`（:666-725，`{group, blurb}`）+ `toolsForScope`（:743-805，档位→工具清单）+ `executeTool` switch（ai-panel.js:6786）。作者规则：新增工具必须写进目录，`ai-tool-defs.test.mjs` 强制 def↔目录一一对应 + 载荷纯净。
- **审批**：`decidePermission`（ai-permissions.js:229-270），`PERMISSION_KINDS = ['command','write','web','read']`。网络类审批模板 = `web_fetch` 链（ai-panel.js:6857-6888：host 规则 `webRuleSubject` → kind:'web' → ask 则 `requestCommandApproval`）。
- **Go HTTP 通道**：`newAIHTTPClient`（ai_sse.go:303-318，代理 `aiProxyFunc` 三态：system/direct/显式 URL）+ 同步非流式样板 `aiUsageQuery`（ai_usage.go，`context.WithTimeout` + 读体限长 + 错误摘要）。**`web_fetch` 不可复用**：GET-only、仅文本、`webValidateURL`（webtools.go:248-294）强制公网 IP——生图需要 POST + JSON 体 + 二进制响应 + 常指向本地服务（ComfyUI / SD-WebUI），三项全撞闸。
- **长任务先例**：`AICommandStart/Status/Stop`（ai_command_windows.go:58、app_commands.go:462）job 注册表 + 游标轮询 + `AICommandStop` 取消——视频异步（提交→轮询→下载）直接仿此。
- **图片链路**：消息内本地图片渲染 `<img data-ai-src>` → `resolveAIImages`（ai-panel.js:2964）→ Go `ReadImageDataURL`（app_file.go:189，上限 `imagePreviewLimit` 32MB）；base64 落盘现成命令 `SaveDataURL`（app_fs.go:368）；vision 回传先例 `browser_screenshot`（ai-panel.js:7273-7289：`aiNormalizeImage` 后 push `{role:'user', images:[...]}`，双协议均已支持 AIImagePart）。
- **`modalities` 与生图无关**：条目上的 `modalities`（ai-config-model.js:100-113）是**聊天输入**模态开关（消费点 ai-composer.js:100 附件拦截、ai-panel.js:7937 发送禁用），生图模型不复用该字段，避免语义混淆。

### 1.2 问题

- AI 助手无法产出图像/视频（插画、封面、图表素材、短演示视频），只能让用户自己开外部网页或经 MCP 外接工具——零配置体验缺失。
- 各家接口差异大（OpenAI `/v1/images/generations` b64、SiliconFlow 同兼容、DashScope wanx 异步任务、Stability、本地 ComfyUI），硬编码任何一家都会重演「每加一家改一次代码」。

## 2. 目标与非目标

### 目标

1. 设置 → AI 助手新增「生图与视频模型」pane：条目化配置（增删/复制/启用/测试连接），**通用输入输出模板**吸收各家差异 + **自定义模板**兜底长尾，内置常见 provider 预设降低门槛。
2. AI 内部工具 `generate_image` / `generate_video` / `check_gen`：审批按写工具档（read/edit 弹卡、auto/full 直发、项目规则可按条目 allow/ask/deny）。
3. 产物落盘工作区（缺省 `.cadt/gen/{image|video}/YYYY-MM/`，可由参数指定工作区内相对路径），Go 专用通道直写；消息流工具卡内嵌图片缩略图、点击灯箱大图。
4. 可选 vision 回传：`review: true` 时把生成图作为图片消息带入下一轮（仅多模态聊天模型有意义）。
5. **零新依赖、零 vendor 增量**（HTTP/JSON/落盘全部走 Go 标准库与既有通道）。

### 非目标（明确排除）

- **不内置任何推理引擎或模型文件**：本地生成服务（ComfyUI 等）通过自定义 baseURL 接入，应用不自带。
- 不做手动「快速生图」入口（v1 生成只经 AI 工具触发；后续可作为编辑器/面板扩展）。
- 生成结果默认**不进**聊天模型上下文（省钱；`review` 参数显式开启）。
- 不动聊天输入模态（`modalities` 的 video/audio「待支持」状态不受本方案影响）。
- 不做生成物自动清理（`.cadt/gen/` 跟随工作区留存，清理策略见 §6 未决项）。

## 3. 设计

### 3.1 配置模型：ai-config.json 顶层 `genModels[]`

```js
{
  id: 'gen-xxx', name: 'SiliconFlow Kolors',
  kind: 'image',                    // 'image' | 'video'（决定产物扩展名与工具）
  enabled: true,
  // ---- 通用连接 ----
  baseURL: 'https://api.siliconflow.cn',
  path: '/v1/images/generations',   // 同步型：直接生成端点
  proxy: 'system',                  // 'system' | 'direct' | 显式 URL（对齐账号 proxy 语义）
  timeoutSec: 120,                  // clamp 30–300
  apiKey: '',                       // 与账号 apiKey 同源信任：仅存 ai-config.json（0600）、仅进请求头、不落日志
  headers: [{key: 'Authorization', value: 'Bearer {{apiKey}}'}],
  // ---- 通用输入：请求体模板 ----
  // 约定：占位符一律渲染为 JSON 字面量（字符串占位符渲染成带引号的转义 JSON 串），
  // 模板里不手写引号——数字/布尔占位天然正确，prompt 内容无需担心注入破坏 JSON。
  bodyTemplate: '{"model":{{model}},"prompt":{{prompt}},"image_size":{{size}},"batch_size":{{n}}}',
  // ---- 通用输出：响应提取 ----
  resultType: 'b64',                // 'b64'（直接解码落盘）| 'url'（Go 下载后落盘）
  resultPath: 'data[*].b64_json',   // 手写点路径，`[*]` 取数组全部（支持多张/分片）
  errorPath: 'error.message',       // 失败响应读出来回给模型自修
  // ---- 缺省参数（工具不传时用）----
  defaultModel: 'Kwai-Kolors/Kolors', defaultSize: '1024x1024', defaultN: 1,
  // ---- 异步任务（配了 submitPath 即视为异步型，image/video 同一套引擎）----
  submitPath: '',                   // 异步型：提交端点（bodyTemplate 用于提交体）
  jobIdPath: '',                    // 从提交响应提取任务 id，如 'output.task_id'
  pollPath: '',                     // 轮询端点模板，{{jobId}} 占位
  statusPath: '', doneValue: '', failedValue: '',   // 状态判定（轮询响应 JSON）
  resultPath: '',                   // 完成后产物提取（resultType 仍适用）
  pollIntervalSec: 5,               // clamp 2–30
  maxPolls: 60,                     // 上限 = 轮询总时长预算
}
```

- **占位符词表**：`{{prompt}} {{model}} {{size}} {{n}} {{seed}} {{apiKey}} {{jobId}}`；渲染器对字符串值做 JSON 转义（约 30 行，纯函数可测）。
- **提取路径语法**：手写 `a.b[0].c` / `a[*].b`（约 40 行纯函数），**不引 JSONPath 库**（体积约束 0）。
- **两种引擎形态与产物类型正交**：同步型（无 `submitPath`，单次 POST 等响应）与异步型（submit → 轮询 → 取产物）× `kind: image|video`。DashScope wanx（异步生图）与视频各家共用同一异步引擎。
- **预设表**（前端常量，随 `ai-gen-model.js` 分发）：OpenAI 兼容 b64 形态 / OpenAI 兼容 url 形态 / 通用自定义（空模板 + 字段占位说明）。用户选预设 → 微调 → 保存；预设只是初始值，不锁定。
- **导入导出**：`ai-settings-io.js` `exportAIConfig` 白名单加 `genModels`（apiKey 跟随 `#ai-opt-export-keys` 勾选，同账号 apiKey 脱敏语义）；`importAIConfig` 加合并分支（空密钥不覆盖本地，参照 :118-120 keepKey）。

### 3.2 设置页：「生图与视频模型」pane

- index.html `snav-ai` 分组加导航项 + `data-pane="gen-models"` 面板；settings-ui.js 两处名单；ai-panel.js `opt` 映射。
- 新子域工厂 `createAIGenModelSettings(ctx, extras)`（新文件 `frontend/src/ai/ai-gen-settings.js`，仿 `createAIModelSettings` 的列表/编辑器状态机：条目卡片列表 + 编辑器快照回滚），字段绑定走 `core/form-controls.js` 工厂（模板编辑器用 createTextarea，等宽字体）。
- 「测试连接」按钮：Go 新绑定 `AIGenModelTest(genCfgJSON, prompt)`——发一次最小请求（小尺寸/1 张），返回耗时与产物校验结果，仿 `AITestConnection`（ai_chat.go:126）。
- 表单含：名称/类型/启用、连接（baseURL/path/proxy/timeout/apiKey/headers 键值表）、请求体模板（textarea）、输出（resultType/resultPath/errorPath）、缺省参数、异步段（kind=video 或勾选异步时展开：submitPath/jobIdPath/pollPath/statusPath/doneValue/failedValue/pollIntervalSec/maxPolls）。

### 3.3 Go 执行通道：`ai_gen.go`（新）

- **同步运行** `AIGenModelRun(reqId, genCfgJSON, paramsJSON)`：渲染模板 → `newAIHTTPClient` POST（`context.WithTimeout(timeoutSec)`，读体限长 32MB）→ `errorPath` 判错 → 提取产物（b64 解码 / url 下载，下载走同一 client，限长 220MB）→ 落盘 → 返回 `{files: [{path, bytes, mime, width?, height?}], elapsedMs}`。仿 `aiUsageQuery` 的超时与错误摘要风格。
- **异步 job** `AIGenModelStart / AIGenModelStatus(jobId, since) / AIGenModelStop(jobId)`：内存注册表 + cancel context（仿 AICommand job 模型）；轮询循环按 `pollIntervalSec` 间隔，状态变化经 `EventsEmit('ai-gen-progress', {jobId, text})` 推送（低频事件直接 emit，不需 aiChunkBatcher 微批）；`maxPolls` 耗尽判失败并清理。
- **落盘**：Go 侧直写 `<workspace>/.cadt/gen/{kind}/YYYY-MM/gen-<ts36>.png|jpg|mp4`（MkdirAll 0755，对齐 `AIEnsureDir` 语义）；参数 `output_path`（工作区相对路径）覆盖缺省时，`filepath.Clean` 后校验不出工作区前缀，越界拒绝。**不走 write_file 审批链**（专用通道，先例 write_worklog / propose_patch），审批语义由工具层承担（§3.4）。
- **API key 硬线**（对齐 ai_types.go:49-50 注释）：key 只在前端 ai-config.json 存储、随请求头发出、Go 错误摘要与日志不回显（错误信息里做 `*KEY*` 形态脱敏）。

### 3.4 内部工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `generate_image` | `prompt*`, `model?`（genModel 条目名，缺省=启用条目中首个 image 型）, `size?`, `n?`（1–4）, `output_path?`, `review?` | 同步型条目：阻塞至完成（≤timeoutSec）返回产物路径清单；异步型条目：提交后立即返回 `task_id`，完成经信箱通知 |
| `generate_video` | `prompt*`, `model?`, `size?`（分辨率/时长按模板语义）, `output_path?`, `review?` | 仅异步语义（视频无同步型）：提交返 `task_id` |
| `check_gen` | `jobId*` | 查询 job 状态/进度/产物路径；完成/失败为终态 |

- **四处登记**：`AI_TOOL_DEFS` 三条 + `AI_TOOL_CATALOG`（新组 `gen`，组标题「生图与视频」）+ `toolsForScope`（基座清单追加——四档都下发，审批由 decidePermission 控制）+ `executeTool` 三个 case。
- **审批**：`decidePermission` 为 `generate_*` 加独立分支（仍归 kind `'web'` 复用 host/条目级规则，`webRuleSubject = 'gen:<entryId>'`）：**read/edit 档 ask**（`requestCommandApproval` 卡展示条目名、模型、尺寸/张数、目标路径——花钱包一次），auto/full 直发；项目规则可对 `gen:<entryId>` 设 allow/ask/deny。`check_gen` 只读自身 job 注册表，免审批。
- **结果消息**：content 为纯文本清单（路径 + 尺寸 + 字节数，对齐工具结果即字符串的形状）；副数据挂 `toolMessage.gen = {files, kind, model}` 供工具卡渲染。
- **完成通知**：异步 job 完成时 Go `EventsEmit('ai-gen-done', {jobId, sessionId, files})` → main.js 转发 → 经 `ai-agent-notices` 三态投递唤醒归属会话（对齐 timer 到点通知链路）；会话正忙时排队不打断。
- **vision 回传**：`review: true` 时按 `browser_screenshot` 先例 push `{role:'user', images:[{mime, data}]}`（图片 ≤6MB 预算内取首张；视频不做回传），仅当当前聊天条目 `modalities.image` 为真才执行。
- **留痕**：`ActivityAppend` 记条目名 / 参数摘要（prompt 只记长度 + hash，不记原文）/ 产物字节数（对齐「只存操作摘要，不存正文」原则）。

### 3.5 消息渲染与产物

- `generate_image` 工具卡（ai-tool-cards.js）：参数摘要 + 结果缩略图（`ReadImageDataURL` 加载，32MB 上限内）+ 点击走既有 `image-lightbox` 大图 + 「另存」复用 answers 卡的保存链。
- 视频产物 v1 **不内嵌播放**（mp4 动辄百 MB，dataURL 通道不可行）：工具卡显示路径 + 字节数 + 「在资源管理器中显示」（既有 `revealInExplorer` 能力）。
- 模型在后续消息里以 Markdown 引用产物路径时，`resolveAIImages` 的 `<img data-ai-src>` 链天然可渲染图片（视频引用显示为路径文本）。

### 3.6 安全与边界

- **SSRF 立场**：`baseURL` 是用户显式配置项（与聊天账号 baseURL 同信任模型），**允许 localhost/内网**（本地 ComfyUI 是真实需求），不复用 webtools 的公网闸；代理经用户配置的 `proxy` 字段，默认 system。
- **大小上限**：响应体 32MB / 图片落盘单张 ≤25MB / 视频下载 ≤220MB（超限报错不落盘）；`ai-config.json` 1MB 上限不受影响（生成产物不进 config）。
- **模板注入**：占位符 JSON 字面量渲染约定下，prompt 内容无法破坏 JSON 结构；headers 值里的 `{{apiKey}}` 只做等值替换。
- **取消**：同步运行随 context 超时终止；异步 job 可 `AIGenModelStop`；工具卡与详情提供停止入口（对齐 timer/后台命令交互）。

## 4. 工作量与体量估算

| 文件 | 内容 | 估算 |
| --- | --- | --- |
| `frontend/src/ai/ai-gen-model.js`（新） | genModels 归一化 / 模板渲染 / 提取路径 / 预设表（纯函数，可单测） | ~400 行 |
| `frontend/src/ai/ai-gen-settings.js`（新） | 设置 pane 子域工厂（列表/编辑器/测试连接） | ~700 行 |
| `ai-panel.js` | `opt` 控件映射、normalizeAIConfig 挂 genModels、executeTool 三 case + 审批接线 + 信箱通知接收 | ~250 行 |
| `ai-tool-defs.js` / `ai-tool-cards.js` / `ai-settings-io.js` | 三工具 def/目录/档位、工具卡渲染、导入导出 | ~270 行 |
| `settings-ui.js` / `index.html` / `style.css` | pane 注册与结构、样式 | ~120 行 |
| `ai_gen.go` + `ai_gen_test.go`（新，Go） | 同步运行 / job 注册表 / 下载落盘 / 测试连接 / 表驱动测试 | ~900 行 |
| `ai-gen-model.test.mjs`（新） | 归一化/渲染/提取表驱动 | ~200 行 |

合计约 **2.8k 行，0 新依赖、0 vendor 字节**；符合「体积预算 0」约束（SQLite/引擎例外均不涉及）。工具目录文本增长约 +400 token（`toolsTokenEstimate` 已计入会话占用估算）。

## 5. 测试与验收

- **纯函数测试**（`ai-gen-model.test.mjs` + `ai_gen_test.go`）：genModels 归一化 clamp、占位符渲染（含 JSON 转义/数字占位/未知占位符）、提取路径（含 `[*]`/越界/缺字段）、同步/异步状态机、落盘路径校验（越界拒绝）、错误摘要脱敏。
- **既有护栏**：`ai-tool-defs.test.mjs`（def↔目录↔档位）、`form-controls-factory.test.mjs`（新 pane 无裸控件）、`module-scope.test.mjs`（导出防撞）。
- **手动验收**：OpenAI 兼容真实出图（b64）/ url 形态下载；本地 ComfyUI（localhost baseURL）；异步型（DashScope wanx 或任意视频 API）提交→进度→完成通知→check_gen；read/edit 档审批卡出现、auto 档直发、项目规则 deny 生效；`review: true` 回传后模型能描述生成图；导入导出密钥脱敏；32MB/220MB 超限报错。

## 6. 未决项

1. `.cadt/gen/` 清理策略：跟随工作区永久留存，还是按时间/总量滚动清理（对齐 activity.go 的保留清理模式）？
2. 预设模板 v1 内置范围：是否再加 DashScope wanx（异步生图）与 Stability 直传预设，还是只留 OpenAI 兼容两式 + 自定义？
3. 视频产物是否做分段预览（首帧截图 dataURL 便宜且 `ReadImage` 通道可复用，需 Go 侧抽帧——纯 Go 无解码依赖可用 ffmpeg 外部命令，违背零依赖则放弃）？
4. `size` 词表是否按条目配置可选档位下拉（WorkBuddy 式），还是自由文本由模板直接吸收？
