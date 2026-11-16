# 外部 AI 工具接入（来源可选：关闭 / 本地 MCP / 服务提供商）与设置归位（方案）

> 状态：**已实施**（2026-11-16 成文并当天落地 B0–B4、B6；B5「本地朗读 speak_text」为可选批次，未做）
> 范围：为 AI 助手的五种外部能力（搜索 / 抓取 / OCR / 语音合成 / 语音识别）各提供**来源选择**——关闭 / 本地 MCP（插件形态）/ 服务提供商（DeepSeek 工具 API），搜索与抓取另有内置实现；同批交付示例本地 MCP server；同时把设置里的 MCP 服务器组从「AI 助手」页移出，与来源矩阵合并为一个新的 AI 子页「外部工具」。
> 依据：DeepSeek 2026-11-13 发布的全家桶工具 API（官方文档契约已逐页核对，见 §3.4）；作者 2026-11-16 确认「可选启用，不填就用自己的」「ASR 可以做 WebAudio 转码」「连插件一起做，用户可选关闭 / MCP / 服务提供商」。

## 1. 背景与现状

### 1.1 代码事实

- **联网工具引擎**在 `internal/webtools`（`webtools.go`）：`Search` 走 Bing RSS（`https://www.bing.com/search?format=rss&count=N&q=…`，默认 8 条 / 上限 10 条 / 1 MiB 上限），`Fetch` 是自写 HTTP 抓取 + 正则 HTML→纯文本（25s 超时、6 次重定向、4 MiB 上限、公网地址校验，含逐跳重定向校验与 DNS 解析后的 IP 检查）。根目录 `webtools_app.go` 是 Wails 薄包装（`WebSearch` / `WebFetch`）。
- **工具声明单一来源** `frontend/src/ai/ai-tool-defs.js`：`AI_TOOL_DEFS`（def 表）+ `toolsForScope`（权限档清单）+ `AI_TOOL_CATALOG` / `AI_TOOL_GROUPS`（`<tool_catalog>` 渲染数据）。约定（2026-11-15 作者定）：**新增工具必须写进目录**，测试强制 def ↔ 目录一一对应。
- **条件工具先例**：生图/视频的 `generate_image` / `generate_video` / `check_gen` 只在配置了启用条目时才 push 进 `toolsForScope`（`ctx.genModelsOn()`），目录里始终有条目并注明「未配置条目时这些工具不可用」。
- **执行侧**：`ai-panel.js` 的 `executeTool` 按工具名分发；`web_search` / `web_fetch` 全权限档（含计划模式）可用；`web_fetch` 走域名级权限判定（`decidePermission kind:'web'`，项目规则 allow/ask/deny + 会话级允许），`web_search` 因域名固定不弹审批。`read_image` 的网图通道（2026-11-17 起）共用同一闸门（`gateWebTarget`，做法见 `read-image.md`）。
- **审批卡与留痕**：命令/读取/写入/网络四类（`kind: command | read | write | web`），审批记录进权限审计（`logPermission`）。
- **MCP 设置现状**：MCP 服务器组是 `frontend/index.html` 中 `data-pane="ai"` 页内的一组（约 875–891 行，元素 id `ai-opt-mcp-*`）；绑定器在 `frontend/src/ai/ai-mcp-settings.js`（按 id 绑定，配置读写走 Go `MCPGetConfig` / `MCPWriteConfig`，状态灯来自 `mcpMod.getState()` 整代快照），由 `ai-panel.js` 创建并在 `refreshSettings` / MCP 事件时 `render()` / `renderAll()`。
- **设置页信息架构**：`index.html` 的 `.snav-item[data-pane]` + `.settings-pane[data-pane]` 驱动导航；`settings-ui.js:607` 按 data-pane 切换；设置搜索（`settings-search.js`）**自动**从 DOM 收集条目，新增页无需额外注册。当前 AI 子页顺序：模型 / 生图与视频 / AI 助手 / 权限 / 个性化 / 上下文注入 / 用户偏好 / 定时任务。
- **二进制读取先例**：`ReadImageDataURL`（`app_file.go:161`，图片 ≤32 MB 转 data URL）；`SaveDataURL`（`app_fs.go:369`）落盘二进制。

### 1.2 问题

1. 联网能力只有一套内置实现：搜索只有 Bing RSS（结果质量与索引覆盖有限），抓取是正则转文本（SPA 拿不到正文、PDF/Office 完全读不了）。
2. AI 没有 OCR / 语音能力：扫描件、PDF、录音进不了对话。
3. MCP 服务器配置挤在「AI 助手」页中间（界面、上下文、聊天行为、日志、子代理之后），与外部的「能力接入」同类配置分散。

## 2. 目标与非目标

### 目标

1. **每个能力一个来源选择**：关闭 / 本地插件（MCP）/ 服务提供商（DeepSeek）；搜索与抓取额外保留「内置」并作为默认与回退。
2. 本地插件这一路**同批交付**：能力可绑定到已配置的 MCP 工具（参数契约见 §3.10），并随仓库提供示例本地 MCP server（SAPI TTS / Windows OCR / whisper 接入说明），不随 exe 分发。
3. 搜索 / 抓取失败**回退内置并注明原因**；OCR / TTS / ASR 无内置替身，失败明确报错。
4. 来源=关闭时**不注册工具**（搜索/抓取关闭 = 连内置也不用）；目录里保留条目并标注可用来源。
5. 新增 3 个直连工具：`ocr`、`text_to_speech`、`transcribe_audio`（搜索/抓取沿用现有 `web_search` / `web_fetch`，内部按来源分派）。
6. 设置页归位：MCP 服务器组从「AI 助手」页移出，与外部工具配置合并为 AI 子页「外部工具」；不改任何存储格式。
7. 0 新依赖（WebAudio 解码是 WebView2 内置能力；WAV 编码是纯 JS 约 50 行；示例 MCP server 只在 docs 里，不进构建）。

### 非目标（明确排除）

- 不接 Files API 的 file_id 生命周期：DeepSeek 的「文件解析」能力由 OCR 接口覆盖（`purpose=text_recognition` 对 Word/PPT 直接提取文字，其他文件逐页识别）。
- 不做多提供方注册表（v1 外部提供方只有 DeepSeek；本地来源走 MCP）。
- 不做子代理可用（新工具不进 `subToolsForScope`；上传文件与按次计费先只开给主会话）。
- 不做 OCR 页码续读（接口没有页范围参数，重试会重复计费）；结果超预算时只标注省略，不自动重试。
- 不做流式 ASR / WebSocket TTS（v1 一次性请求；WebCodecs 流式转码列为后续增强）。
- **不在核心打包本地 OCR / ASR 引擎与模型**（体积红线）：本地能力走 MCP 服务器（§3.9 / §3.10）；核心只考虑 `speak_text` 本地朗读（复用系统语音，可选批次）。
- 不扩插件 API 去注册 AI 工具：本地插件形态 = MCP 服务器（§3.10），JS 插件运行时保持现状。
- 不改 MCP 的配置模型与存储；不做 top-level「集成」页。

## 3. 设计

### 3.1 能力来源矩阵

用户按能力选择来源（默认值见 §7）：

| 能力 | 可选来源 | 默认 | 失败回退 |
| --- | --- | --- | --- |
| 搜索 | 内置 / 服务提供商 / 本地 MCP / 关闭 | 内置 | 服务提供商或 MCP 失败 → 回退内置并注明 |
| 抓取 | 内置 / 服务提供商 / 本地 MCP / 关闭 | 内置 | 同上 |
| OCR / 文件解析 | 服务提供商 / 本地 MCP / 关闭 | 关闭 | 不回退，报错 |
| 语音合成 | 服务提供商 / 本地 MCP / 关闭 | 关闭 | 不回退，报错 |
| 语音识别 | 服务提供商 / 本地 MCP / 关闭 | 关闭 | 不回退，报错 |

- **关闭**：工具不注册，模型看不到、调不到（搜索/抓取关闭 = 连内置也不用，用于沙箱式禁用）。
- **本地 MCP**：核心工具名不变（`web_search` / `ocr` / `text_to_speech` / `transcribe_audio`），实现转发到用户绑定的 MCP 工具（契约见 §3.10）。沿用 MCP 既有边界：**仅写权限档、非计划模式、写工具审批**。
- **服务提供商**：走 DeepSeek 工具 API（§3.4）。OCR / ASR 全权限档可用、TTS 写档可用（§3.3）。
- **内置**：Bing RSS / 自写抓取，仅搜索与抓取可选。

路由点：五种能力的来源判定与 MCP 转发都在前端 `executeTool`（Go 不认识 MCP）；Go 侧 `internal/webtools` 只实现「内置 / 服务提供商」两种实现。

### 3.2 配置模型与存储

- 文件：`<应用数据目录>/external-tools.json`，权限 0600（与 `ai-config.json` 同口径；不引入 DPAPI，v1 与 AI 模型的 API Key 存储方式保持一致）。
- 结构：

```json
{
  "enabled": false,
  "baseUrl": "",
  "apiKey": "",
  "searchCount": 10,
  "capabilities": {
    "search": {"mode": "builtin"},
    "fetch":  {"mode": "builtin"},
    "ocr":    {"mode": "off"},
    "tts":    {"mode": "off"},
    "asr":    {"mode": "off"}
  },
  "mcpBindings": {
    "search": "", "fetch": "", "ocr": "", "tts": "", "asr": ""
  }
}
```

- `capabilities.<cap>.mode` ∈ `builtin | provider | mcp | off`；`builtin` 仅搜索/抓取有效，其他能力写了也按 off 处理。
- `mcpBindings.<cap>` 存 MCP **公开工具名**（实现为 `mcp__<server>__<tool>`，与工具表/审批规则同名）。`mode=mcp` 且绑定为空、或绑定的服务器被禁用/删除/工具未勾选 → 按 off 处理，设置页给出提示。
- `enabled` 是**服务提供商总开关**：`mode=provider` 时要求 `enabled && apiKey != ""`；搜索/抓取为 builtin 时不受它影响。
- `baseUrl` 为空 = `https://api.deepseek.com/v1/tools`（与作者参考截图一致：基础地址含 `/v1/tools`，程序追加 `/search|/fetch|/ocr|/tts|/asr`）。
- 绑定：`WebToolsConfigGet`（返回掩码：`hasKey` + 其余字段，**不回传 key 明文**）、`WebToolsConfigSave`（key 传空 = 保持原值）、`WebToolsConfigClearKey`。MCP 工具清单不新增 Go 绑定，前端直接用现有 `mcpMod.mcpToolDefs()` 快照填下拉。
- 前端只保存掩码状态，key 永不下发到 WebView 之外的日志；调试日志与错误信息对 key 做脱敏。

### 3.3 工具定义

| 工具 | 权限档（来源=provider） | 计划模式 | 审批 | 备注 |
| --- | --- | --- | --- | --- |
| `ocr` | 全部档 | 可用 | `kind:'web'`（域名 + 文件路径 + 预估费用） | 读文件内容，工作区无写效应 |
| `transcribe_audio` | 全部档 | 可用 | `kind:'web'`（同上） | 上传音频，工作区无写效应 |
| `text_to_speech` | 写权限档 | 不可用 | `kind:'write'`（对齐生图：read/edit 弹卡、auto/full 直发） | 产物写 `.cadt/gen/tts/` |

来源=**本地 MCP** 时三个工具一律按 MCP 既有边界：仅写权限档、非计划模式、按写工具审批（规则按绑定工具名匹配）。来源=关闭时不注册。

参数（`AI_TOOL_DEFS`）：

- `ocr(path, purpose?)`：`purpose` ∈ `text_recognition`（默认）/ `rich_layout_recognition`；返回按页文本，正文预算 40k 字符，超出部分标注「原文省略 N 页」（不提供页码续读）。
- `transcribe_audio(path)`：本地仅接受音频扩展名；来源=provider 且非 WAV/Ogg 时走前端转码（§3.6）；来源=MCP 时原文件路径直接交给本地 server（转码由 server 自行决定）。
- `text_to_speech(text, voice?)`：`voice` ∈ `stella`（女声，默认）/ `tide`（男声）；单次 ≤5000 字符，超出报错并提示分段。

目录与分组：`AI_TOOL_GROUPS` 新增 `media` 组——「语音与识别（外部服务）」：OCR / TTS / ASR 三条，note 写明「来源由 设置 → AI → 外部工具 决定：关闭 / 本地 MCP / 服务提供商；上传到服务提供方会产生费用」。`toolsForScope` 按 `ctx.externalToolsOn(capability)` 条件 push（与 `genModelsOn` 同机制，判定包含 mode≠off 与 MCP 可用的权限档边界）。工具目录、权限档、技能说明、CHANGELOG、文档中的工具数量同批更新（既有约定）。

### 3.4 API 契约（以官方文档为准，2026-11-16 核对）

公共：`Authorization: Bearer <apiKey>`；基础地址默认 `https://api.deepseek.com/v1/tools`。

- **搜索** `POST /search`：请求 `{query, count}`（实现前再核对 `/zh-cn/api/search` 的完整字段，如 `site:` / `lang:` 语法走 query 字符串）。响应映射到现有 `SearchResult`：`{title, url, snippet, published}` 保持前端格式不变。计费：5 元 / 1000 次。
- **抓取** `POST /fetch`：请求 `{url}`；响应为 Markdown 正文（实现前核对完整字段名）。映射到现有 `web_fetch` 返回结构（`title` 取页面标题或空，`text` = Markdown，`links` 为空数组）。计费：5 元 / 1000 次。
- **OCR** `POST /ocr`：`multipart/form-data`，字段 `file`（带文件名）+ `purpose`。响应 `{id, page_count, pages:[{index, text, finish_reason}], usage}`。计费：1.5 元 / 1000 页。
- **语音合成** `POST /tts`：JSON `{text, voice_id, format:"wav", filter_markdown:true}`；响应为**音频二进制流**（`audio/wav`）。Go 侧边读边写临时文件，完成后原子改名到 `.cadt/gen/tts/`。计费：3 元 / 10000 字符（限时折扣 1.5）。
- **语音识别** `POST /asr`：`multipart/form-data`，字段 `file`（16 位 PCM WAV 或 Ogg Opus）。响应 `{request_id, text, duration_ms}`。计费：0.78 元 / 小时音频（限时折扣 0.39）。
- 文档链接（设置页「外部链接」）：`/zh-cn/api/search`、`/fetch`、`/ocr`、`/tts`、`/asr`、价格页 `/zh-cn/quick_start/pricing`、申请 key `https://platform.deepseek.com`。

### 3.5 审批与隐私

- 来源=**服务提供商**：OCR / ASR 上传本地文件到第三方——审批卡显示文件名、目标主机、预估费用与一句「文件将上传到外部服务」；规则匹配沿用 `web` kind（项目规则 allow/ask/deny、会话级允许）。TTS 只上送文本，仍走写工具档审批（对齐生图）。
- 来源=**本地 MCP**：文件不出网，交本机 server 处理；审批沿用 MCP 写工具规则（按绑定工具名匹配），审批卡注明「本地 MCP：<绑定名>」。本地 server 自身的行为（是否再转发外部）由用户自担，设置页说明。
- 设置页固定说明：来源=服务提供商时仅接收本次请求的文件/文本，本应用不上传工作区其他内容；来源=内置/本地时不产生外发。
- 错误信息透传可读文案（HTTP 状态、额度/权限不足、格式不支持、MCP 绑定失效），不吞错。

### 3.6 WAV 转码（ASR 前置）

- 触发：`transcribe_audio` 收到非 `.wav` / `.opus` 音频。
- 链路：Go `ReadAudioDataURL(path)`（新增绑定，仅音频扩展名，≤20 MB）→ 前端 `AudioContext.decodeAudioData` → `OfflineAudioContext` 重采样 **16 kHz 单声道** → 纯函数 `encodeWav16(channels, sampleRate)` 写 RIFF/PCM → base64 回传 Go `ExternalASR(name, wavBase64)` → multipart 上传。
- 限制（v1 常量，集中一处）：编码文件 ≤20 MB、解码后时长 ≤15 分钟（解码后校验，超限拒绝并提示「请裁剪后再试」）。原因：`decodeAudioData` 整段进内存，30 分钟立体声解码后约 700 MB float32，WebView2 进程扛不住。
- 编解码边界：依赖 WebView2 的 Chromium 解码（mp3 / aac(m4a) / ogg / flac 可用；wma / ape 不支持，报明确错误）。
- 纯函数 `encodeWav16` 与用例放 `frontend/src/ai/ai-audio-transcode.js` + 同名测试（登记 `npm test`）。

### 3.7 结果落盘与来源标注

- TTS 产物：`<工作区>/.cadt/gen/tts/tts-YYYYMMDD-HHmmss-<rand6>.wav`；工具结果返回相对路径与字节数，前端在工具卡上给「打开」入口（复用 `openPaths`）。`.cadt/gen/` 已属于「生图产物」存储条目，TTS 落在其下自动被存储与清理页统计。
- 每个工具结果首行标注来源与用量：`DeepSeek OCR（N 页，约 ¥0.00x）` / `DeepSeek TTS（N 字符，voice=stella）` / `DeepSeek ASR（m:ss）`；来源=本地 MCP 时标注 `本地 MCP（<绑定名>）`。
- 搜索/抓取结果保留现有格式，来源从 `engine` 字段体现（`bing` / `deepseek`），回退时附一行说明。

### 3.8 设置页信息架构（归位）

**推荐：AI 子页「外部工具」**（新增 `data-pane="external-tools"`），放在「生图与视频」之后（AI 子页顺序遵循既有「接入 → 行为 → 边界 → 内容 → 自动化」：模型 / 生图与视频 / **外部工具** / AI 助手 / 权限 / 个性化 / 上下文注入 / 用户偏好 / 定时任务）。

理由：

- MCP 服务器与外部工具提供方是同一类东西——「AI 的外部能力来源」，消费方只有 AI；放 top-level 会让「AI 页管 AI 的全部配置」这个心智断裂。
- 单独的 top-level「集成」页（合并 系统集成 + MCP + 外部工具）**不建议**：系统集成是 OS 级注册（右键菜单/托盘），受众与语义不同，合并会变成杂物页；系统集成留在功能区。

页内结构：

1. **能力来源**（搜索 / 抓取 / OCR / 语音合成 / 语音识别 五行）：每行一个「来源」下拉——`关闭 / 本地 MCP / 服务提供商`（搜索与抓取另有 `内置`）；选 `本地 MCP` 时行内出现「MCP 工具」二级下拉（选项来自当前启用的 MCP 工具快照，参数契约见 §3.10）；绑定失效（服务器被禁/删）时整行标黄并提示重选。
2. **服务提供商配置**：总开关 / API Key（掩码，留空保持）/ 基础地址（默认值占位提示）/ 每次搜索结果数（1–50，默认 10）/ 说明行带外链（文档、价格、获取 Key）。任一能力选择服务提供商且未启用/无 key 时，该行标黄提示。
3. **MCP 服务器**：整组原样搬入（`ai-opt-mcp-*` DOM 与 `ai-mcp-settings.js` 绑定不变，只移动容器）。
4. 页面顶部一句说明：搜索/抓取默认用内置 Bing；OCR/语音类默认关闭；选择「本地 MCP」需要先在下方配好对应服务器。

实现改动：`index.html` 新增 nav item + pane，把 MCP 组 DOM 从 `data-pane="ai"` 移到新页；新增 `frontend/src/settings/settings-pane-external-tools.js`（来源矩阵 + 服务商配置渲染与保存）；MCP 模块只在 `refreshSettings` 的调用点不变（它按 id 绑定，不依赖所在 pane）。设置搜索自动收录，无额外注册。`openSettings('external-tools')` 可用于 AI 工具报错时的跳转提示。

### 3.9 本地能力（MCP 插件形态，不随包分发）

结论：**本地 OCR / TTS / ASR 用 MCP 服务器提供，不扩插件 API、不进核心**。理由：

- 现有插件 API（`shell/plugins.js`）只能注册格式、命令、图标主题、界面主题、命令分类器与虚拟 AI 账号；**没有「注册 AI 工具」**。为此扩一套「工具声明 + handler + 权限档 + 审批」API，安全面大（同窗 JS 可伪造工具结果、可外呼）且与 MCP 完全重叠。
- MCP 客户端已支持 stdio 本地服务器：工具自动并入 AI 工具表（`mcp__` 前缀、汇总卡、审批、`mcpLogActivity` 留痕全部现成），服务器命令在本机执行、子进程环境过滤疑似密钥变量。用户侧的小程序（Python/Node/单文件 exe）就是「插件」。

能力与本地引擎的对应（示例，均由用户自装/自备）：

| 能力 | 本地引擎候选 | 形态 | 备注 |
| --- | --- | --- | --- |
| OCR | Windows.Media.Ocr（系统内置，需语言包）或 tesseract | MCP stdio server | WinRT 在 PowerShell 5.1 可用，桥接脚本即可 |
| TTS（落盘 wav） | Windows SAPI（`SpeechSynthesizer.SetOutputToWaveFile`））或 edge-tts | MCP stdio server | 系统自带、离线；不需要打包任何东西 |
| ASR | whisper.cpp（模型自备） | MCP stdio server | 核心不打包模型（体积红线） |

已知限制（写进文档与设置页说明）：

1. **权限档**：MCP 工具只在写权限档（`AI_WRITE_SCOPES`）且非计划模式注入——只读档看不到本地 MCP 工具。这是既有安全边界（`readOnlyHint` 不参与判定），本次不改。
2. MCP 工具调用按写工具审批（ask 档弹卡、deny 规则生效），与命令审批同一套规则匹配。
3. 本地引擎的安装与模型管理在用户侧，应用只负责「连得上、看得到、审得了」。

核心侧唯一考虑收录的本地能力：**`speak_text`（本地朗读）**——复用阅读模式已有的 `speechSynthesis`（零依赖、离线、系统语音），直接朗读文本、不落盘，作为 TTS 的零配置替代（read 档可用）。是否收录列为可选批次 B5。

### 3.10 能力来源路由与 MCP 绑定契约

**路由点**：五种能力的来源判定都在前端 `executeTool`（MCP 调用只能在前端发起）。流程：读设置快照 → mode 判定 → `builtin|provider` 走 `backend.WebSearch/WebFetch/ExternalOCR/ExternalTTS/ExternalASR`，`mcp` 走 `mcpMod.callTool(绑定名, 固定参数)`，`off` 的工具有代码侧的硬拒绝兜底（防设置中途关闭后旧工具调用穿透）。

**MCP 参数契约（v1 固定，不做自适应映射）**：

| 能力 | 调用参数 | server 返回 |
| --- | --- | --- |
| 搜索 | `{query, count}` | 纯文本结果 |
| 抓取 | `{url}` | 纯文本正文 |
| OCR | `{path, purpose}` | 纯文本（按页可自行分节） |
| 语音合成 | `{text, voice}` | server 负责落盘并把文件路径写进返回文本 |
| 语音识别 | `{path}` | 纯文本转写 |

- 结果一律按文本透传，核心不做结构化归一（避免多家 server schema 分裂）；工具结果首行统一标注「来源：本地 MCP（<绑定名>）」。
- 绑定下拉只列当前启用服务器暴露的工具（公开名 `mcp__<server>__<tool>`）；支持的参数签名写进设置页提示与该工具目录备注。
- 权限与审批：来源=MCP 时沿用 MCP 既有边界（写权限档、非计划模式、写工具审批、按绑定工具名匹配规则）；来源=provider 时按 §3.5。
- 绑定校验在每次调用前做一次（服务器在启用列表中、工具仍在快照里），失效则返回明确错误并提示去设置重绑。

**示例本地插件（同批交付物，放 `docs/mcp-samples/`，不随 exe 分发）**：

- `tts-sapi.ps1`：单文件 PowerShell MCP stdio server，用 SAPI `SetOutputToWaveFile` 落盘 wav，工具名 `tts_sapi`，参数 `{text, voice?}`。零安装（Windows 自带）。
- `ocr-windows.ps1`：单文件 PowerShell MCP server，Windows.Media.Ocr 识别图片（中文需系统语言包），工具名 `ocr_windows`，参数 `{path, purpose?}`；PDF 需先转图，文档里说明。
- `asr-whisper.md`：whisper.cpp server 的接入模板与参数映射说明（模型自备，不提供下载）。
- 示例只用于验证「关闭 / MCP / 服务提供商」三种来源都可跑通；不在应用内提供安装器。

### 3.11 本地与外部的关系

- 同一能力三选一（关闭 / 本地 MCP / 服务提供商；搜索与抓取另有内置），由设置页的来源矩阵决定；MCP 工具本身仍会以 `mcp__` 前缀独立出现在工具表（写权限档），与直连工具并存时由模型按描述选择——设置页文案会提示「绑定为能力来源后会同时存在，建议对同一能力只保留一种来源」。
- 设置页「外部工具」管理两类东西：能力来源矩阵 + 服务商配置；MCP 服务器仍在同页的第三组（§3.8）。本地引擎的说明与示例放在设置页文案与文档里，不内置安装器。

### 3.12 同步清单（单批完成）

- `internal/webtools`：`Config` 读写（含来源矩阵与 MCP 绑定字段）、内置/外部分派、回退标记、DeepSeek 适配器（search/fetch/ocr/tts/asr）、multipart 构造、测试（httptest）。
- 根：`webtools_app.go` 扩绑定（配置三件套、OCR、TTS、ASR、ReadAudioDataURL）。
- 前端：`ai-tool-defs.js`（3 个 def + 目录 `media` 组 + `toolsForScope` 条件）、`ai-panel.js` 的 `executeTool` 三个 case + **来源路由（off/provider/mcp 三分支，web_search/web_fetch 也要加前端分派）** + 审批接线 + 结果格式化、`settings-pane-external-tools.js`（来源矩阵 + 服务商配置）、`index.html` 归位、`ai-audio-transcode.js` + 测试。
- 示例本地插件：`docs/mcp-samples/`（`tts-sapi.ps1`、`ocr-windows.ps1`、`asr-whisper.md`），不参与构建。
- 文档：`AGENTS.md` 的 webtools 条目、`CHANGELOG.md`、工具数量相关说明。

## 4. 分阶段实施（每批独立提交、独立验证、可单独回滚）

- **B0 设置归位**：新增「外部工具」空页（仅 MCP 组迁入 + 说明文案）。纯 UI 移动，无行为变化。
- **B1 来源矩阵 + 搜索/抓取来源**：Config（含 per-capability mode 与 mcpBindings）+ 内置/DeepSeek 分派 + 回退标注 + 设置页来源下拉（搜索/抓取先行）+ 测试。
- **B2 OCR**：`ocr` 工具 + multipart + 结果格式化 + 审批 + 来源=provider/MCP 两路 + 设置项 + 测试。
- **B3 TTS**：`text_to_speech` + 流式落盘 + 工具卡打开入口 + 两路来源 + 设置项 + 测试。
- **B4 ASR**：`transcribe_audio` + 转码链（provider 路径）+ 上传绑定 + 两路来源 + 设置项 + 测试。
- **B5（可选）本地朗读 `speak_text`**：复用阅读模式的 `speechSynthesis`（系统语音、离线、零依赖），read 档可用；不落盘。是否做由作者定。
- **B6 示例本地插件**：`docs/mcp-samples/` 三个示例（SAPI TTS / Windows OCR / whisper 接入说明）+ 设置页「本地 MCP」用法说明；用示例 server 手工验证三种来源切换。

依赖：B0 独立；B1 提供配置页骨架与来源路由；B2/B3/B4 各自依赖 B1 的路由与审批接线；B6 独立于 B2–B4（可在 B1 后做）。

## 5. 测试计划

- Go（表驱动 + `httptest` 假服务）：配置读写与掩码、回退矩阵（外部 500 / 超时 / key 缺失）、外部搜索响应映射、fetch Markdown 映射、OCR multipart 字段与分页解析、TTS 流式落盘（大小/文件名/原子替换）、ASR multipart 与响应、非公网 URL 拒绝仍生效（内置抓取路径不变）。
- 前端：`encodeWav16`（8/16/24-bit、单/双声道、时长换算、上限拒绝）、`ai-tool-defs.test.mjs` 的 def ↔ 目录一致性、`toolsForScope` 条件可用性（off / provider / mcp / builtin 四种来源组合）、来源路由与 MCP 绑定失效的兜底、设置页搜索能命中新页条目、MCP 组迁移后绑定仍工作（现有用例）。
- 手工：真实 key 连通五个能力（作者提供）；未配置时的回退与工具不可见；三种来源逐一切换（关闭 / 本地 MCP / 服务提供商）；审批卡展示；TTS 文件可播放；MP3→WAV 转码后 ASR 成功；示例 `tts-sapi.ps1` / `ocr-windows.ps1` 能被 MCP 客户端拉起并调用。

## 6. 风险与边界

- **计费**：五个能力全部按量计费，且 OCR 重试整份重算；审批卡固定展示预估，工具结果固定写用量。
- **ASR 格式与内存**：只收 WAV/Opus；转码整段进内存，v1 上限 15 分钟 / 20 MB；wma/ape 明确拒绝。
- **OCR 体积**：大 PDF 单次耗时长、输出大；v1 只做字符预算与省略标注，不自动重试。
- **TTS 流式**：必须边读边写临时文件（不能全量缓内存），失败时清理临时文件。
- **依赖第三方**：接口/价格/字段可能调整；适配层集中在 `deepseek.go` 一个文件，改动面可控。
- **MCP 绑定契约**：MCP server 是用户侧程序，参数名/返回格式不遵守 §3.10 契约时只能报错；示例 server 是契约的参考实现。MCP 工具仍受「写权限档」边界约束，只读档的本地来源不可用（有意保留）。
- **隐私**：来源=服务提供商时上传即出网；来源=本地 MCP 时不出网但由用户自担 server 行为；设置页与审批卡双重说明。

## 7. 默认值汇总（如需调整请直接改这里）

| 项 | 默认 |
| --- | --- |
| 总开关（服务提供商） | 关 |
| 基础地址 | `https://api.deepseek.com/v1/tools` |
| 每次搜索结果数 | 10（1–50，实际返回再受工具上限 10 约束） |
| 搜索 / 抓取来源 | 内置 |
| OCR / TTS / ASR 来源 | 关闭 |
| MCP 绑定 | 空（选「本地 MCP」后必须选工具） |
| OCR 单次正文预算 | 40k 字符，超出标注省略 |
| TTS 单次文本上限 | 5000 字符 |
| ASR 转码上限 | 20 MB / 15 分钟 |
| 新工具是否给子代理 | 否 |
| 新工具目录分组 | `media`「语音与识别（外部服务）」 |
| 示例本地 MCP server | `docs/mcp-samples/`，不随 exe 分发 |

## 8. 实施记录（2026-11-16）

- **B0–B4、B6 全部落地**：设置页归位、来源矩阵与搜索/抓取分派、OCR、TTS、ASR 与转码链、示例本地 server 均已实现并验证（前端 743 项单测、Go `internal/webtools` 用例、`npm run build` 通过；示例 `tts-sapi.ps1` 与 `ocr-windows.ps1` 已用真实 MCP 握手与工具调用实测）。
- **与方案的偏差**：MCP 绑定存公开名 `mcp__<server>__<tool>`（不是 `server__tool`）；搜索/抓取在 MCP 调用抛错时回退内置，用户拒绝审批则不回退（直接作为工具结果）；provider 抓取 URL 用轻量校验（http/https、无账号密码、拒绝内网 IP / localhost），不做本地 DNS 解析。
- **B5 未做**：`speak_text`（系统语音朗读）仍为可选批次，待作者决定。
- 文件落点：`internal/webtools/{config,deepseek}.go`、根 `webtools_config.go`、前端 `ai/ai-external-tools.js`、`ai/ai-audio-transcode.js`、`settings/settings-pane-external-tools.js`、`docs/mcp-samples/`。

## 9. 后续补充：内置 MCP 示例（2026-11-16）

- 三份示例脚本（SAPI TTS / Windows OCR / whisper.cpp ASR）经 `//go:embed` 随 exe 内嵌，体积增加约 20 KB；**不打包 Python / whisper 模型 / OCR 引擎**。本节取代 §3.10 / §7 中「示例不随 exe 分发、不内置安装器」的旧口径。
- 设置 → AI → 外部工具 → MCP 服务器新增「内置示例」：按需释放脚本到 `<应用数据>/builtin-mcp-samples/<版本>/`，合并进 `mcp.json` 并只启用示例自身的工具；同名服务器已存在时拒绝、不覆盖。
- `app_control` 增加 `list_mcp_samples` / `install_mcp_sample`（安装前弹本机命令确认），内置技能 `cadt-mcp-samples` 指导 AI 在用户缺本地 TTS/OCR/ASR 时推荐并安装。
- 释放副本登记进 设置 → 存储与清理（可删缓存，删除后需重新安装释放）。
