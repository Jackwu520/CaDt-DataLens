# AI 账号额度外显（用量查询增强，cc-switch 式）——评估稿

> 状态：**已实施（2026-11-19 当日立项当日落地）**。基于对本仓代码与 cc-switch 源码（本地 `D:\OraSkyC\Project\OpenSource\cc-switch`，v4.x）的只读调研；行号按当日工作区实测。实施与评估稿的偏差见文末「实施记录」。

## 0. 结论摘要

| 维度 | 结论 |
|------|------|
| 需求 | 账号列表常显各家余额/套餐额度（cc-switch 卡片 footer 式）；**只在账号开启了用量查询后显示**，未开启的账号不显示且不再出现「查询用量」按钮；配置走预设模板（通用/NewAPI/Sub2API/Token Plan/官方）+ 自定义脚本；附带补一批常用供应商图标 |
| 可行性 | **高**。现有 `internal/aiusage` 引擎、`internal/aigen.HTTPRequest` 哑通道、账号卡 UI、ai-config.json 存储四件都是现成的，缺的只是「per 账号用量配置 + 脚本提取器 + 常显渲染」这一层 |
| 关键取舍 | extractor（用户 JS）在**前端 Worker 沙箱**跑而非 Go 内嵌 JS 引擎——零新依赖（goja 约 +2 MB 违背体积第一约束），Worker 天然无 `window.go` 宿主 API |
| 改动面 | 前端为主（4 个新模块 + 5 处接线），Go 只加一个哑通道薄绑定（~30 行） |
| 新增依赖 | **0**。图标用自绘/精选内联 SVG（~20 家，约 60–120 KB），不搬 cc-switch 的 126 文件 1.8 MB 图标库 |
| 工作量 | 一期 1.5–2 天（引擎 + 配置弹窗 + 卡片常显 + 官方/通用/NewAPI/Sub2API/自定义模板 + 图标）；二期 ~1 天（Token Plan 预设移植、自动刷新、模型选择器显示） |
| 风险 | Token Plan 各家端点需逐家实测（cc-switch 是 Rust 硬编码，移植成 JS 模板后参数要重新核对）；火山方舟需 SigV4 签名，建议缓期 |

---

## 1. 需求解读

1. **常显**：开了用量查询的账号，在账号列表（设置 → AI → 模型）卡片上持续显示余额/额度（如「余额 49.05 CNY」「已使用： 0.00 tok」「5h 94%」），带刷新与最近查询时间；失败显示红色失败态 + 原因。
2. **开关即显隐**：未开启用量查询的账号**不显示余额行、不显示「查询用量」按钮**（现在的按钮是每卡必有，要改为「配置用量查询」入口）；开启后才出现常显区。
3. **模板体系**（照 cc-switch 截图）：预设模板 chips（自定义 / 通用模板 / NewAPI / Sub2API / Token Plan / 官方）+ 自定义脚本编辑器（request + extractor 两段式，支持 `{{baseUrl}}` / `{{apiKey}}` 变量替换）+ 测试脚本按钮；Token Plan 下再分各家预设（Kimi / 智谱 / 智谱团队 / MiniMax / ZenMux / 火山方舟 / OpenCode Go / Command Code）。
4. **供应商图标**：账号列表显示各家彩色 logo（DeepSeek / OpenRouter / Anthropic / 智谱 / Kimi…），未命中退首字母瓦片。

## 2. cc-switch 参照（调研事实）

cc-switch（Tauri 2 + Rust + React，MIT）的用量查询分两类：

- **Auto Query**（官方订阅 OAuth 类，开箱即显）：Claude / Codex / Gemini 官方登录、GitHub Copilot、Codex OAuth 反代。我们**没有这类凭据体系，整体不做**。
- **Manual Enable**（内置模板 + 自定义脚本）：必须用户在卡片上开启「用量查询」才显示。我们做的是这一类，交互完全对齐。

### 2.1 配置与数据

- 配置存在供应商条目上：`provider.meta.usage_script`（`src/types.ts:58` `UsageScript`）：`enabled / language / code / timeout / templateType / apiKey / baseUrl / accessToken / userId / codingPlanProvider / autoQueryInterval` 等。**没有独立的配置文件**——这印证了「挂账号条目、进 ai-config.json」的路线。
- 模板七类（`src/components/UsageScriptModal.tsx:178-186`）：`custom / general / new_api / sub2api` 是脚本模板；`token_plan / balance / official_subscription / github_copilot` 走 Rust 专用查询（脚本 code 为空串）。
- 脚本格式：`({ request: { url, method, headers, body }, extractor: function(response) { return {...} } })`；变量 `{{baseUrl}} / {{apiKey}} / {{accessToken}} / {{userId}}` 运行时替换。
- extractor 返回字段（可全缺省除 remaining/unit）：`isValid / invalidMessage / remaining / unit / planName / total / used / extra`（extra 可带 JSON 串如 resetsAt）。

### 2.2 沙箱与安全

`src-tauri/src/usage_script.rs`：Rust 侧 rquickjs（QuickJS）执行——内存 16 MiB、栈 256 KiB、执行 5 秒硬中断。文件头注释明确说**脚本来自不可信来源（deeplink、同步导入），必须限制 CPU/内存/栈**。base_url 校验仅 https（loopback 放行，本地 NewAPI/one-api 部署是合法场景）。extractor 在无宿主 API 的隔离引擎里跑，拿不到 Tauri 后端。

### 2.3 展示与刷新

- 卡片 footer：单套餐直接一行余额；多套餐折叠成条数、点开看明细；按用量着色（<70% 绿 / 70–89% 橙 / ≥90% 红）；失败态**保留重试入口**（`UsageFooter.tsx:127` 注释：首次查询失败也渲染失败态，否则 footer 整体消失无从重查）。
- 缓存：`usage_cache.rs` 内存缓存，瞬时失败保留上次成功值。
- 自动查询：`autoQueryInterval` 分钟（0=关，上限 24h），**只对「当前激活」的供应商触发**。

### 2.4 Token Plan 与图标

- Token Plan 是 Rust 硬编码的各家专用端点（`src-tauri/src/services/coding_plan.rs`，约 600 行）：Kimi `GET {base}/usages`、智谱 `/api/monitor/usage/quota/limit`、MiniMax 按域名开放平台端点、ZenMux、OpenCode Go `/zen/go/v1/usage` 等；火山方舟要 AK/SK 做 SigV4 签名（`usage_script.accessKeyId/secretAccessKey`）。前端只有 base_url → provider id 的路由表（`src/config/codingPlanProviders.ts`）。
- 图标库：`src/icons/extracted/` **126 个文件共 1.8 MB**（PNG/SVG 混合）+ metadata 搜索索引 + IconPicker 手选；preset 定义直接带 `icon` 字段；fallback 是首字母瓦片（`ProviderIcon.tsx` 的 `getProviderInitials`，`Array.from` 按 Unicode 码位切，防 emoji/代理对截半）；SVG 按主题适配 currentColor，tile 类保留底色。

## 3. 本仓现状（代码事实）

- **Go 引擎**：`internal/aiusage/aiusage.go`（319 行）——host 白名单端点表（`aiUsageEndpoints` :50-70，DeepSeek `/user/balance`、OpenRouter `/api/v1/credits`、SiliconFlow `/v1/user/info`），GET + Bearer，15s 超时、64KB 响应上限，返回 `AIUsageResult{Supported, Provider, Items[{Label,Value}], Error}`；未收录 host 返回 `Supported=false`。安全模型=「host 命中白名单才发请求」，无通用 SSRF 校验。绑定 `AIUsageQuery(cfg aitransport.Config)`（`ai_usage_app.go:14`）。
- **前端调用与展示**：`ai-panel.js:12784` `queryUsageForAccount` → `backend.AIUsageQuery(configForProfile(profile))`；结果走 `showUsagePopover`（:12800）锚定弹层。**唯一入口**是设置页模型卡的「查询用量」按钮（`ai-model-settings.js:89`），结果不落盘、不常显。
- **账号列表 UI**：`ai-model-settings.js:48-96` `renderModelList()`——卡片 = 名字 + 协议标签 + 「当前」徽标 + meta 行（模型数 · baseURL · Key 配置态）+ 操作按钮行（设为当前/查询用量/编辑/复制/删除）。纯文字，无图标。
- **账号数据结构**：`normalizeProfile`（`ai-panel.js:814-834`）→ ai-config.json；**无任何用量/额度字段**。Go 侧 `internal/aiconfig` 只做原样字符串读写（0600、1MB 上限），结构全由前端定义——加字段零迁移成本，旧数据缺字段=功能关闭。
- **哑通道先例**：`internal/aigen.HTTPRequest(specJSON)`（`internal/aigen/aigen.go:101`）——`HTTPSpec{url, method, headers, body, bodyBase64, proxy, timeoutSec, maxBytes}` → `HTTPResult{status, contentType, body, bytes, truncated, error}`；前端把模板变量替换、body 渲染全做完，Go 只发一次同步请求。ForbiddenHeader + 换行校验、超时钳位、64MB 上限。**生图/视频已在用同构链路**（`ai-gen-jobs.js:139` runSync）。
- **配置导入导出**：`ai-settings-io.js` 导出带 `includeKeys` 开关（:44），导入时空 key 保持旧值（:133-135）——用量配置搭车时沿用同一脱敏语义即可。
- **图标体系**：`core/icons.js` 是 16×16 stroke currentColor **单色**注册表（80+ 个，含 `refresh`/`chart`），无彩色品牌 logo 机制；`public/` 下没有任何供应商 logo。
- **存储范式参照**：`external-tools.json`（`internal/webtools/config_store.go`）——掩码下发/留空保持/跨进程锁/0600 原子写。本功能不需要新文件，只作范式参照。

## 4. 方案

### 4.1 数据模型：账号条目挂 `usage`

照 cc-switch 把用量配置挂账号条目（不建新文件、不动 Go 结构体），`ai-config.json` 的每个 profile 增加：

```js
profile.usage = {
    enabled: false,            // 总开关：false 时一切不显示（按钮也换成配置入口）
    template: 'official',      // 'official' | 'general' | 'newapi' | 'sub2api' | 'plan' | 'custom'
    planProvider: '',          // template='plan' 时：'kimi' | 'zhipu' | 'minimax' | 'zenmux' | 'opencode_go' | ...
    code: '',                  // template='custom' 时的用户脚本（request+extractor 对象字面量）
    apiKey: '',                // 覆盖；空 = 用账号的 apiKey
    baseUrl: '',               // 覆盖；空 = 用账号的 baseURL
    extraFields: {},           // 模板专属附加字段（newapi: accessToken/userId）
    timeoutSec: 10,            // 钳位 [3, 60]
    autoIntervalMin: 5,        // 0 = 不自动查
};
```

- 归一化纯函数 `normalizeUsageConfig(raw)` 进 `ai-config-model.js`（与 `normalizeModelEntry` 同层）；缺字段/非法值回落默认，**旧配置零迁移**。
- override 的 apiKey 存 ai-config.json（本就 0600），UI 掩码显示、留空保持（照 `settings-pane-external-tools.js:207-219` 的既有交互）。
- 导入导出：随 profile 走 `includeKeys` 同一开关覆盖 `usage.apiKey`。

### 4.2 查询管线：前端拼装 → Go 哑通道 → Worker 沙箱提取

与 ai-gen 完全同构的三段式，**extractor 在前端跑**：

```
[前端] 模板/用户脚本 → 变量替换 {{baseUrl}}/{{apiKey}}/... → 解析出 request(url/method/headers/body)
   ↓ AIUsageHTTPRequest(specJSON)          ← 新薄绑定
[Go]  internal/aigen.HTTPRequest 引擎发同步 HTTP（超时钳位/ForbiddenHeader/响应上限沿用）
   ↓ HTTPResult{status, body, ...}
[前端] Worker 沙箱执行 extractor(response) → UsageItem[] 归一化 → 常显渲染
```

- **Go 侧**：`ai_usage_app.go` 加一个薄绑定 `AIUsageHTTPRequest(specJSON string)`，内部转发 `aigen.HTTPRequest`（引擎已导出，零重复实现；保持 aigen 域语义不动、绑定名归 aiusage 域）。响应上限传 256KB（余额响应远小于生图的 64MB 默认）。
- **为什么不用 `AIGenHTTPRequest` 现成绑定**：机制相同，但那是生图域的绑定，跨域复用会让 aigen 的调用方语义混入用量域；30 行薄绑定换域名干净，符合「根目录留壳、引擎在包内」的布局纪律。
- **为什么 extractor 不在 Go 跑**：需要内嵌 JS 引擎（goja，编译约 +2 MB）——直接违背体积第一约束。cc-switch 用 QuickJS 是因为它的主进程是 Rust；我们的 WebView 本身就是 JS 引擎，**Web Worker 是零依赖的等效沙箱**。
- **Worker 沙箱设计**（新模块 `ai-usage-quota.js` 内实现）：
  1. `new Worker(URL.createObjectURL(new Blob([prelude + userCode])))`——Worker 全局**天然没有 `window.go` / Wails 绑定 / DOM**（Wails 只注入主 frame），脚本拿不到任何宿主能力；
  2. prelude 先执行：从**实例与原型链两层**摘除 `fetch / XMLHttpRequest / WebSocket / importScripts / Worker / sendBeacon` 等，再放用户代码。WebIDL 属性定义在 `WorkerGlobalScope.prototype` 上，只写 `self[name] = undefined` 是在 globalThis 建遮蔽属性，恶意脚本经 `Object.getPrototypeOf(self).fetch` 能拿回原生函数——2026-11-19 审查在 Chromium 实测复现后加固；被摘引用不保留，用户代码无法还原；
  3. 主线程 `postMessage({response})` 输入、worker `postMessage(result)` 输出，结构化克隆只传纯数据；
  4. 超时 `terminate()`（默认 5s）；脚本长度上限 64KB。
  - **威胁模型**：脚本来源 = 用户手写 + 配置导入（ai-settings-io）。cc-switch 把导入脚本当不可信输入是同款考虑；我们最坏情况 = 恶意导入脚本在无网络、无宿主 API 的 worker 里空转到 terminate。请求本身不经过 worker（extractor 拿到的只是响应数据）。
  - 护栏测试：`frontend/test/ai/ai-usage-quota.test.mjs` 锁 prelude 禁用表与归一化规则；worker 集成行为在验收清单里人工验证（node 测试环境无 Worker）。
- **结果归一化**：extractor 返回 → `UsageItem{ planName?, isValid, invalidMessage?, remaining?, total?, used?, unit, extra? }[]`。校验取 cc-switch `validate_single_usage` 的宽松版：`remaining` 与 `unit` 缺一即整条判失败（错误文案回显给卡片）；支持 extractor 返回数组表达多套餐。

### 4.3 模板体系（`ai-usage-templates.js`，数据表 + 纯函数）

| 模板 | 实现路径 | 说明 |
|------|----------|------|
| 官方 | 走**现有** `AIUsageQuery` Go 引擎（host 白名单三家） | 唯一不经脚本管线的模板；host 未命中 = 「该服务商暂不支持」提示，保持现状文案。已有 DeepSeek/OpenRouter/SiliconFlow 用户零感知 |
| 通用模板 | JS 预设脚本：`GET {{baseUrl}}/user/balance` + Bearer | cc-switch 同款（`UsageScriptModal.tsx:83-99`），适合标准 /user/balance 代理站 |
| NewAPI | JS 预设脚本：`GET {{baseUrl}}/api/user/self` + `New-Api-User: {{userId}}` 头 | quota/500000 折算 USD；需要 extraFields 记 accessToken/userId |
| Sub2API | JS 预设脚本：`GET {{baseUrl}}/v1/usage`（baseURL 剥尾部 `/v1`） | cc-switch 同款（`:131-161`，含 remaining=-1 不当余额的细节） |
| Token Plan | `planPresets{}` 内置各家 JS 预设脚本（kimi/zhipu/zhipu_team/minimax/zenmux/opencode_go） | 端点规格从 cc-switch `coding_plan.rs` 逐家移植成 request+extractor **数据**（纯前端表，Go 零改动）；智谱团队版要 organization 头，进 extraFields；**火山方舟需 SigV4 签名，一期缓**（JS crypto.subtle 可实现，约 +100 行，二期评估） |
| 自定义 | 用户脚本编辑器（request + extractor 两段，含变量提示与「测试脚本」） | 照截图 3-5：变量区展示实际替换值（apiKey 掩码）、格式化按钮、测试走同一条管线 |

- 模板切换保留各模板字段回显（照 cc-switch `templateType`）；预设脚本与用户改动合并存 `code`（选模板即预填，可继续改）。
- **「测试脚本」**按钮 = 拼装 → 发请求 → 跑 extractor → 在弹窗内展示返回对象或错误（复用查询管线，零新增通道）。

### 4.4 展示与显隐规则（`ai-model-settings.js` 卡片改造）

- **账号卡新增**：
  - 图标列（见 4.5）；
  - 余额行（meta 行位置或独立 footer 行）：单套餐「⟳ 余额 49.05 CNY」（refresh 图标已有，`icons.js:40`）+ `data-tip` 最近查询时间；多套餐「2 个套餐 ▾」点开展开明细；`isValid=false` 显示 invalidMessage；失败态红字「额度查询失败：原因」+ 重试。**未开启或从未查到数据时不渲染该行**。
- **按钮显隐规则**（用户点名需求）：
  - `usage.enabled === false`：不显示「查询用量」按钮；操作行放「用量查询」配置入口（打开配置弹窗，照 cc-switch 卡片上的 chart 图标按钮）。
  - `usage.enabled === true`：显示余额行 + 刷新小按钮；配置入口保留（进弹窗改配置/关开关）。
- **查询触发时机**（一期从简）：进入模型 pane 时对 enabled 账号按 `autoIntervalMin` 节流自动查（0=只手动）；余额行刷新按钮手动查。**不做全局后台定时器**（cc-switch 也只查激活供应商；常显的是缓存值）。
- **缓存**：内存 `Map(profileId → { items, at, error })`（模块级，getter 活引用）+ 可选 localStorage 快照（重启即显上次值；只存展示数据，**不存 override apiKey**）。
- 结果弹层 `showUsagePopover` 保留：点余额行展开明细明细复用它，减少样式新增。
- 二期：AI 面板模型选择器分组头显示余额（`ai-model-picker.js:104-112` 分组头处）。

### 4.5 配置弹窗（`ai-usage-config-dialog.js`，照截图 2-5）

- 入口：账号卡操作行「用量查询」→ 独立弹窗（不塞进账号编辑器——编辑器已长，且 cc-switch 同样是独立面板）。
- 结构：顶部「启用用量查询」开关（`createSwitch`）→ 预设模板 chips（自定义/通用/NewAPI/Sub2API/Token Plan/官方）→ 按模板渲染字段（通用/NewAPI/Sub2API：apiKey/baseUrl 覆盖 + newapi 的 accessToken/userId；plan：各家子 chips；custom：脚本编辑器）→ 超时/自动间隔（`createInput`）→ 底部「测试脚本 / 取消 / 保存配置」。
- 表单控件全部走 `core/form-controls.js` 工厂（2026-11-15 硬规范）；脚本编辑器复用现有 textarea 工厂 + 等宽字体。
- 弹窗 DOM 放 index.html 设置层，参照 ai-gen-settings.js 的居中弹窗模式。

### 4.6 供应商图标（`ai-provider-icons.js`）

- **不搬 cc-switch 图标库**（126 文件 1.8 MB 不合体积纪律）。新建内联 SVG 注册表（彩色，独立于 icons.js 的单色体系），精选约 20 家：
  `DeepSeek / OpenAI / Anthropic / Google-Gemini / OpenRouter / Kimi-Moonshot / 智谱-GLM / MiniMax / SiliconFlow / 火山方舟 / Qwen / StepFun / Mistral / Grok-xAI / GitHub Copilot / Ollama / 本地服务(localhost 通用) / NewAPI 站点通用 / OpenAI 兼容通用 / 默认(球)`——2–6 KB/个，合计 60–120 KB。
- **来源与许可**：优先自绘简化标记；取用 cc-switch（MIT）已收录的 SVG 时在文件头注明出处。注意商标 logo 的正当使用边界=「指代该服务」的列表场景（与 cc-switch 同类用法），不用于品牌背书。
- **匹配策略**：`resolveProviderIcon(profile)` 纯函数——按 baseURL host 精确/后缀匹配 + 账号名关键词（deepseek/kimi/glm/…），未命中退**首字母瓦片**（照 cc-switch `getProviderInitials` 的 `Array.from` Unicode 安全切分，防 emoji 截半）。一期不做 IconPicker（cc-switch 有手选器，二期再评估）。
- **主题适配**：线性 logo 用 currentColor 跟随文字色；自带品牌底色的 tile 类保留原色（照 cc-switch `adaptSvgToTheme` / `isTileIcon` 的二分语义）。深色模式下深底 logo 加浅色圆角底衬。
- 用点：账号卡、模型选择器分组头（二期）。

## 5. 安全与合规清单

1. **AI 不可达**：不给 executeTool / app_control 增加任何用量配置读写动作——脚本的写路径只有设置页用户操作；AI 无法注入脚本（对照 2026-11-18 事故的结构性盲区，这里不新增 AI 可达面）。
2. **脚本三道闸**：Worker 无宿主 API（结构性）→ prelude 从实例与原型链摘除网络原语（运行时，见 §4.2 加固注）→ 超时 terminate + 64KB 长度上限（资源）。导入配置视同不可信输入，靠这三道闸兜底。
3. **密钥**：override apiKey 存 ai-config.json（0600）；UI 掩码；`{{apiKey}}` 替换在前端完成后才发给 Go（与现有 AIUsageQuery 同一暴露面）；不写日志、不进 localStorage 快照、不进操作留痕。
4. **请求面**：全部经 Go 哑通道——ForbiddenHeader/换行校验、超时钳位、响应上限沿用 aigen 引擎；loopback 放行与账号 baseURL 的信任级别一致（本地 NewAPI/one-api 是合法场景，照 cc-switch）。
5. **`console.assert` 不当校验用**；extractor 异常全部捕获转失败态文案。

## 6. 改动面

**新文件**
- `frontend/src/ai/ai-usage-templates.js`：模板与 plan 预设数据表 + 变量替换纯函数
- `frontend/src/ai/ai-usage-quota.js`：查询管线编排（拼装→绑定调用→Worker 提取→归一化→缓存）
- `frontend/src/ai/ai-usage-config-dialog.js`：配置弹窗控制器
- `frontend/src/ai/ai-provider-icons.js`：图标注册表 + `resolveProviderIcon`
- `frontend/test/ai/` 镜像三个测试文件（登记 `npm test`）

**改文件**
- `ai-config-model.js`：`normalizeUsageConfig`（+~30 行）
- `ai-model-settings.js`：卡片图标列 / 余额行 / 按钮显隐 / 配置入口（+~80 行）
- `ai-panel.js`：`queryUsageForAccount` 改走新管线、`normalizeProfile` 透传 usage（小改）
- `index.html`：配置弹窗 DOM；`style.css`：余额行/失败态/chips 样式
- `ai_usage_app.go`：`AIUsageHTTPRequest` 薄绑定（~30 行）
- `frontend/src/dev/mock-backend.js`：补 `AIUsageHTTPRequest` mock（漏了 dev 模式调用即崩）
- `CHANGELOG.md` / `README.md`

**Go 侧无引擎改动**：aigen.HTTPRequest 已导出、aiusage 白名单引擎不动。

## 7. 测试与验收

- 单测（登记 `npm test`）：`normalizeUsageConfig` 回落矩阵；变量替换（含 `{{apiKey}}` 掩码回显值）；extractor 返回归一化（缺 remaining/unit 判失败、多套餐数组、`remaining=-1`）；模板表完整性（每个预设脚本引用的变量在表内声明——照 ai-tool-wiring 的「参数提及↔声明」思路）；`resolveProviderIcon` 匹配与首字母回退。
- Go：薄绑定转发无需新引擎测试，跑全量回归。
- 人工验收：官方/通用/NewAPI/Sub2API 五模板各配一个真实账号实测；自定义脚本含语法错误时失败态文案；导入含恶意脚本的配置（`window.go` 探测 + 死循环）确认沙箱兜底；未开启账号无按钮无余额行。

## 8. 分期

- **一期（1.5–2 天）**：数据模型 + 查询管线（含 Worker 沙箱）+ 官方/通用/NewAPI/Sub2API/自定义模板 + 配置弹窗 + 账号卡常显与显隐规则 + 图标注册表（~20 家）+ mock + 测试。
- **二期（~1 天）**：Token Plan 各家预设实测移植（火山 SigV4 单独评估）、localStorage 快照、AI 面板模型选择器分组头显示、IconPicker 手选。

## 9. 开放问题

1. Token Plan 预设的各家端点参数（headers/响应字段）cc-switch 是 Rust 硬编码，移植为 JS 模板后需逐家实测核对——一期只做有把握的两三家还是全量缓到二期？建议**全量放二期**，一期先把管线立住。
2. 智谱团队版（zhipu_team）无法靠 baseURL 自动区分（cc-switch 靠显式字段路由），我们的 planProvider 同样只能手选，自动检测只做提示。
3. 余额值是否进 AI 上下文（让 AI 知道账号余额）？默认**否**，纯 UI 数据。
4. 多窗口同时开设置页的缓存一致性——一期各窗口自查即可（数据本身轻，无写冲突）。

---

## 10. 实施记录（2026-11-19）

### 10.1 与评估稿的偏差

1. **配置弹窗不进 index.html**：走 `openAIDialog` 动态构建（`ai-usage-config-dialog.js`，同 gen-settings 先例），零静态 DOM；评估稿 §4.5「DOM 放 index.html」作废。
2. **预设脚本运行时取自预设表**，不落盘 `usage.code`——模板修正随版本走（cc-switch 同思路）；只有 custom 模板写 code。
3. **火山方舟与 CommandCode 不做预设**（评估稿 §4.3 已建议缓期）：火山要 OpenAPI SigV4 签名、CommandCode 要 whoami→credits→subscription 三连请求，单请求管线承载不了；Ollama Cloud 反而简单（`GET ollama.com/api/balance`），补进来了，共 7 家套餐预设。
4. **余额行做成整行按钮**（点击 = 重查 + 明细弹层），比评估稿的「刷新小按钮 + 明细入口」更省地方；官方引擎多条 label/value 明细行不算「多套餐」（只有数值/套餐名形态的条目才走「N 个套餐」聚合）。
5. **图标来源**：评估稿写「首选自绘」；实际从 cc-switch（MIT）本地仓库提取了 17 家官方 SVG（2026-11-19 补齐到 39 家，见 CHANGELOG）（deepseek/openai/claude/anthropic/gemini/openrouter/kimi/zhipu/minimax/siliconflow/qwen/stepfun/mistral/grok/copilot/ollama/newapi），提取脚本剥 title、内联进 `ai-provider-icons.js`（约 27 KB body），未命中退首字母瓦片（每词取一字母，Unicode 安全）。
6. **workerFactory 测试缝**：`createAIUsageQuota` 加 `deps.workerFactory`（默认真 Worker），node 测试环境注入假件走同一消息协议——评估稿 §4.2 说「worker 集成行为人工验收」，现在管线编排可自动化测试。

### 10.2 落地清单

- **Go**：`ai_usage_app.go` 加 `AIUsageHTTPRequest`（转发 `aigen.HTTPRequest`，30 行）；wailsjs 手写同步（App.js / App.d.ts；models.ts 复用 aigen 命名空间）。
- **前端新模块**：`ai/ai-usage-templates.js`（模板表 + 7 家套餐预设 + `renderUsageVars`）、`ai/ai-usage-quota.js`（管线 + Worker 沙箱 + 缓存 + sweep 节流）、`ai/ai-usage-config-dialog.js`（配置弹窗）、`ai/ai-provider-icons.js`（注册表 + host/名称匹配 + 瓦片渲染）。
- **接线**：`ai-config-model.js` 的 `normalizeUsageConfig`；`ai-panel.js`（`normalizeProfile`/`defaultProfile` 带 usage、`usageQuotaMod`、`queryUsageForAccount` 走管线、明细弹层吃 snapshot）；`ai-settings-dialog.js` 建 `usageMod` 注入 model 域；`ai-model-settings.js` 卡片（图标槽 / 余额行 / 按钮显隐 / 自动刷新）；`ai-model-picker.js` 分组头；`mock-backend.js` 补 `AIUsageQuery` / `AIUsageHTTPRequest` mock；`style.css` 新增 `.ai-picon*` / `.ai-usage-line` / `.ai-usage-*` 弹窗样式。
- **测试**：`test/ai/ai-usage-templates.test.mjs`（8 例）、`ai-usage-quota.test.mjs`（12 例）、`ai-provider-icons.test.mjs`（7 例），登记 `npm test`；`test-manifest` / `form-controls-factory` / `module-scope` 守卫全绿；`vite build`、`go build`、`go test ./internal/aigen ./internal/aiusage ./internal/aitransport` 通过。

### 10.3 已知边界

- 沙箱隔离本身（Worker 无 window.go、fetch 已禁）在 node 里只锁了脚本形态与禁用表字符串，真实隔离靠 WebView2 的 Worker 语义；「测试脚本 + 导入恶意配置探测 window.go」仍是验收清单里的人工项。
- Token Plan 套餐预设的端点参数移植自 cc-switch Rust 源码，**未对真实账号逐一实测**（智谱 unit=6 判周桶、MiniMax model_remains.general、Kimi limits[].detail 等字段形态以 cc-switch 实测注释为准）；各家改版后改 `ai-usage-templates.js` 即可。
- 智谱团队版无法靠 baseURL 自动区分，配置弹窗只能手选套餐预设（与 cc-switch 同）。
