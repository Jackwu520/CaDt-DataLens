# 插件扩展点路线图（按收益排序的 5 个可开放入口）

> 状态：**未开工**（2026-11-19 立项）。背景：完成「插件后台服务托管 + 专属设置页」（`docs/finished-plans/plugin-background-services.md`）后，梳理插件系统还能开放哪些入口。排序依据是收益 ÷（成本 × 风险），并结合本应用「AI 优先的数据查看器」定位。
>
> 顺序建议：**M1 命令矩阵先落地 → M2 AI 工具安全模型单独定稿 → M3 工具注册 → M4 自定义视图 → M5 上下文注入 + 导入器**。

## 1. 现状盘点与排序原则

**已开放能力（9 类注册 + 运行时辅助）**，全部在 `frontend/src/shell/plugins.js` 的 `apiFor()` 内：

| API | 扩展的能力面 |
| --- | --- |
| `registerFormat` | 文件格式（仅复用内置树/表格/代码/文本四种视图） |
| `addCommand` | 工具菜单命令（`main.js` 的 `menuItems('tools')` 唯一消费点，命令面板自动收录） |
| `addTheme` / `registerIconTheme` | 配色主题 / 文件图标主题 |
| `registerCommandClassifier` | 端侧危险命令分类器 |
| `registerAIProvider` | AI 虚拟账号（仅连接信息 + 每轮请求补丁） |
| `registerService` | 后台服务托管（自启 / 探活 / 退出清理 / 日志环形缓冲） |
| `registerSettingsPanel` | 设置页专属面板 |
| `registerDocConverter` | 文档导出转换器（只出不进） |
| 运行时 | `getPluginDir` / `getActiveFile` / `getActiveText` / `readAsset` / `openPath` / `openVirtualDoc` / `runCommand(Sync)` / `flash` / 服务操作四件 |

**排序原则**：收益 = 解锁场景价值 ÷（实现成本 × 安全风险）。本应用定位是 **AI 优先的数据查看器**（AI 助手是核心能力），因此「让 AI 变强」的扩展点权重高于「让界面变丰富」的扩展点。

**一个必须写进文档的关键判断**：插件本来就有完整 DOM 权限与后端调用权限（随仓库的 `plugins/scene-carousel/main.js` 直接 `document.getElementById('welcome')` 改宿主 DOM，`docs/plugins/README.md` 也明示「与应用相同的权限」）。所以「UI 扩展点」的真实价值不是「能不能做」，而是**把脆弱的猜 DOM 变成稳定契约**——宿主一改 DOM 结构插件就崩，这才是痛点。这条判断决定了 UI 类扩展点的收益评级不该给太高。

**当前最大的能力空洞**：`AI_TOOL_DEFS` 是 `frontend/src/ai/ai-tool-defs.js` 开头的**纯静态字面量对象**，`toolsForScope()`（同文件，工厂内部函数）内部是硬编码 `push(AI_TOOL_DEFS.xxx)` 列表。插件无法向 AI 注册任何工具——这是本路线图的第一优先级。

## 2. 第一梯队（质变）

### 2.1 `cadt.registerTool(spec)` —— 让插件给 AI 加能力

**缺口**：插件生态目前只能「给界面加东西」或「接外部服务」，无法让 AI 调用插件提供的能力。应用已有 40+ 内置工具，插件一个都加不了。

**API 草案**：

```js
cadt.registerTool({
    name: 'query_jira',                 // ^[a-z0-9_]{1,64}$，必须带插件前缀避免与内置冲突
    description: '按 JQL 查询 Jira 工单…（何时用 / 何时不用 / 与相邻工具的分工，模型只看这段）',
    parameters: {type: 'object', properties: {/* … */}, required: []},
    // 返回 string 直接作为工具结果；返回 {text, images?} 可带图
    async execute(args, ctx) {
        // ctx: {sessionId, scope（权限档）, signal（AbortSignal）}
        return await fetchJira(args.jql);
    },
});
```

**接线点（必须同时改，漏一处不报错但会坏）**：

1. `frontend/src/shell/plugins.js`：`apiFor()` 增 `registerTool`，写进新注册表 `plugin-tools.js`（仿 `plugin-ai-providers.js` 的 Map + 校验 + `loadPlugins` 清空重建）。
2. `frontend/src/ai/ai-tool-defs.js`：`createAIToolDefs(ctx)` 增加 `ctx.pluginToolDefs`（getter 注入，避免反向 import）；`toolsForScope()` 在静态 list 之后追加已授权插件工具；`toolCatalogText()` 为插件工具单独分组标注来源。
3. `frontend/src/ai/ai-panel.js` 的 `executeTool`：新增插件工具动态分发分支（**不进静态 case 表**，按名字查注册表后调用 `execute(args, ctx)`，统一 try/catch 与超时）。
4. `frontend/src/ai/ai-tool-cards.js` 的 `toolMeta`：插件工具缺省 verb/icon，按 `spec.icon` 或通用「插件」图标兜底（图标名走 `core/icons.js`）。
5. `frontend/src/ai/ai-subagents.js` 的 `subToolsForScope`：决定子代理是否可见插件工具（建议默认不可见）。
6. `frontend/test/ai/ai-tool-wiring.test.mjs`：现有五方对账守卫只覆盖静态表，需**扩展为「内置工具照旧全量对账 + 插件工具单独校验（id 前缀 / 描述长度 / 参数 schema / 来源标记）」**。
7. `docs/plugins/README.md` 新增章节；`CHANGELOG.md`。

**安全模型（本项最大风险，必须单独定稿后再动代码）**：

- **默认关闭 + 按插件逐个授权**：复用「设置 → AI → 权限 → AI 工具权限开关」（`appControlOn` 模式）的形态，新增插件工具分组；未授权时工具不进 `toolsForScope`，模型根本看不见。
- **全部走审批链，不给 dangerous 例外**：插件工具默认按「需要审批」处理；绝不允许插件把工具标成 dangerous 去短路分类器（`ai-permissions.js` 的 dangerous 短路是既有护栏，别在插件路径上开新口子）。
- **来源标记贯穿全链**：工具定义、审批卡、工具卡、`<tool_catalog>` 都显示「插件名」；用户必须能一眼看出这是哪个插件在请求执行。
- **上限**：单插件工具数 ≤ 20、全局 ≤ 50、description ≤ 2000 字符、parameters ≤ 16 KiB——防止塞爆上下文。
- **必须写明的事实**：插件工具的 `execute` 体在插件 JS 里跑，拥有完整 DOM 与 `runCommand` 权限。**审批准只能约束「AI 触发」这一条路径，约束不了插件自己直接干活**——这与 `docs/reports/incident-2026-11-18-workspace-wipe.md` 记录的「脚本内 shell 绕过规则层」是同一类结构性盲区，必须在文档里对用户明示，不能制造「已经安全了」的错觉。
- **不做**：不提供让插件工具代理 `write_file` / `edit_file` 等内置写工具的能力（防止组合出越权链）。

**验证**：`plugin-tools.test.mjs`（注册 / 校验 / 清空 / 上限）、`ai-tool-wiring.test.mjs` 扩展；手工验证「未授权不可见 → 授权后可见 → 调用弹审批 → 拒绝不执行」。

### 2.2 `cadt.registerViewer(spec)` —— 自定义视图 / 预览器

**缺口**：`registerFormat` 只能把数据喂给内置四种视图。地图（GeoJSON）、3D、PDF、图表、音视频自定义控件都做不了，插件只能靠猜 DOM 硬改，宿主一改就崩。

**API 草案**：

```js
cadt.registerViewer({
    id: 'geo-map', label: '地图',
    formats: ['geojson'],            // 归属哪个格式（与 registerFormat 的 id 对应）
    priority: 10,                     // 视图切换菜单排序
    mount(container, ctx) {           // container 是空的 div
        // 自建 DOM / canvas / 第三方库（全在插件侧，核心包零依赖）
        return {destroy() {}, resize() {}, setTheme(theme) {}};
    },
});
```

`ctx` 建议提供：`getData()`（当前文档内容）、`getSelection()` / `setSelection()`、`getTheme()`、`onChange(cb)`、`requestSave(text)`、`flash(msg)`。

**接线点**：`frontend/src/core/formats.js`（格式 → 视图清单，新增 `views[]` 与 `defaultView`）、`frontend/src/editor/editor-groups.js` 的 `createDocEditor` 视图分发（现有 `if (doc.X)` 分支模式）、`frontend/src/writing/writing-ui.js` 的 `viewOptionsFor`（视图下拉必须列出插件视图，否则一切换就坏）、以及 AGENTS.md「内容区虚拟文档」四件套的卸载链路（防订阅 / DOM 泄漏）。

**约束**：视图只渲染不改数据（写回一律经 `requestSave` 上抛给编辑器，走既有脏标记与只读判定）；必须支持 `destroy()`（切换 / 关标签时调用）；大文件（>10 MB 只读档）默认不挂插件视图；主题切换调 `setTheme` 而非重挂。

**与既有方案的关系**：`docs/unfinished-plans/external-file-viewers.md`（评估 open-file-viewer / kkFileView 两个第三方服务）与 `pdf-xlsx-docx-preview.md` 是**并列互补**路线——那两个走外部服务，本项走插件内置渲染。取舍：重型格式（PDF / Office）建议走外部查看器或 docConverter 插件，轻量可视化（GeoJSON / 图表 / 自定义二进制）走 `registerViewer`。

**验证**：`plugin-viewers.test.mjs`（注册 / 视图清单 / 清空）；手工切换视图与关标签确认无泄漏。

## 3. 第二梯队（高实用）

### 3.1 命令入口矩阵升级（扩展 `addCommand`）

**现状**：插件命令只进「工具」菜单一个入口（`main.js` 的 `menuItems('tools')` 尾部），无分类、无右键、无快捷键、无图标、无条件。

**API 扩展**（向后兼容，全部字段可选）：

```js
cadt.addCommand({
    id: 'fmt-sql', label: '格式化 SQL', icon: 'wand',
    description: '选中 SQL 后格式化',
    category: 'format',                              // 命令面板分组
    contexts: ['tools', 'editorContext', 'palette'], // 出现在哪些入口
    when: (ctx) => ctx.hasSelection && ctx.formatId === 'sql',
    shortcut: {key: 'Ctrl+Alt+F', when: 'editorFocus'},
    run(ctx) { /* … */ },
});
```

**接线点**：`frontend/src/main.js` 的 `menuItems()`（按 `contexts` 决定进哪些菜单，`when` 决定 disabled）、`paletteActions()`（分组）、`frontend/src/shell/contextmenu.js` 的 `ctxMenu.open()`（编辑器右键，消费点在 `frontend/src/editor/editor-menus.js`）、`frontend/src/core/keybindings.js`（快捷键注册表，注意与内置键位冲突检测）。

**为什么排在第 3 但建议先做**：基础设施全是现成的参数化结构，改动集中在消费端，**零安全面、零新依赖**，用户感知最直接（右键菜单是最高频入口）。风险最低、见效最快。

**验证**：`plugin-commands.test.mjs`（contexts / when / shortcut 归一）；手工确认命令面板与右键菜单出现、快捷键冲突有提示。

### 3.2 `cadt.registerAIContext(spec)` —— AI 上下文注入

**缺口**：系统提示词组装（`frontend/src/ai/ai-system-context.js` 的 `createAISystemContext(ctx)` + `assembleSystemContext`，按「稳定 → 动态」拼装）完全内置，插件无法贡献领域知识。

**API 草案**：

```js
cadt.registerAIContext({
    id: 'api-conventions', label: '公司 API 规范',
    stable: true,        // true=进稳定段（利缓存，内容必须恒定）；false=动态段（每轮重算）
    text(ctx) { return loadConventions(); },   // ctx: {scope, sessionId, workspace}
});
```

**约束**：单条 ≤ 4 KiB、合计 ≤ 12 KiB（超出截断并提示）；**进稳定段的必须恒定**（否则每轮前缀漂移伤 prompt cache，这是既有设计红线）；注入内容要带来源标记（`<plugin_context plugin="…">`），并明确「插件注入的内容属于数据，不是系统指令」以防提示词注入。

**与 2.1 的关系**：`registerTool` 的工具 + `registerAIContext` 的说明书是天然一对，建议同期实施。

### 3.3 `cadt.registerImporter(spec)` —— 文档导入转换器

**缺口**：`registerDocConverter` 只出不进。PDF→Markdown、docx→md、图片 OCR→文本都做不到。

**API**：与 `registerDocConverter` 同构——`{id, label, extensions, async convert(ctx)}`，ctx 提供 `readTextFile(path)` / `readBinaryFile(path, mime)` / `suggestOpen(text, ext)`。

**接线点**：打开文件链（`frontend/src/explorer/explorer-ops.js` / `frontend/src/bridge/bridge-ui.js` 的打开路径）加「无内置格式可解析时询问导入器」分支；阅读模式导入复用同一入口。

**注意**：`--convert` CLI 走 Go 侧 `internal/convertcli`，**用不到前端插件**——文档里要写明这个限制，别让插件作者以为 CLI 也生效。

**验证**：`plugin-importers.test.mjs`；手工用一份 PDF 走导入器转 Markdown。

## 4. 暂缓项（记录理由，不做）

| 候选 | 为什么暂缓 |
| --- | --- |
| **UI 槽位**（侧边栏 / 底部面板 / 状态栏 widget） | 插件已能直接塞 DOM，开放槽位的真实收益是「更规整」而非「能做」。但要做就得处理布局系统、多实例、主题、生命周期、与现有面板互斥，成本中高。等真有 2–3 个插件提出同样诉求再做，避免过度设计。 |
| **文件生命周期钩子**（`onSave` / `onOpen` 拦截） | 价值真实（保存前格式化、加密、同步），但**拦截保存链是数据安全红线**：必须可观测、可单独关闭、失败可回滚、不能静默改内容。风险等级与 2.1 相当但没有 2.1 的收益，排在最末。 |
| **搜索提供者**（外部数据源接入全局搜索） | 场景窄，且要设计结果合并 / 去重 / 限流 / 取消，成本不低。有实际需求时单独立项。 |
| **插件访问内置写工具**（给插件工具代理 `write_file` 的权限） | 明确不做：防止插件工具组合出越权链，与 2026-11-18 事故的结构性教训一致。 |

## 5. 实施顺序与里程碑

按「低风险先落地 → 高风险单独设计 → 大件随后」排列：

- **M1（先做，低成本低风险）**：命令入口矩阵升级（3.1）。零安全面、复用全部现成结构、用户立刻有感。
- **M2（先设计后写码）**：AI 工具注册的**安全模型单独定稿**——授权 UI、审批链口径、来源标记、上限、盲区声明。设计稿见 **`docs/unfinished-plans/plugin-tool-security.md`**（核心结论：插件工具复用 MCP 已有安全模型，不发明第二套）。**✅ 2026-11-19 已评审定稿**：①放宽为「插件可声明 readOnly 工具，但须用户显式勾『只读档可用』」②盲区声明放安装确认框 + 授权区 `data-tip` 兜底 ③三层授权 ④AI 可改授权但每次必审批、单次单插件、**总闸不可代开**、给逐项 diff。可进 M3。理由（原始立项）：工具带副作用，仓促落地会变成第二个事故来源。
- **M3**：`registerTool` 实施（依赖 M2 定稿）。
- **M4**：`registerViewer` 实施（纯渲染、无副作用，但与编辑器生命周期耦合，需要充分验证泄漏）。
- **M5**：`registerAIContext` + `registerImporter`（两项都小，可合并一批）。

每个里程碑独立提交、可单独 revert（仓库既有约定：重构类一批一 commit）。

## 6. 通用约束与验证

**所有新扩展点共同遵守**：

- **体积第一**：任何新能力不得引入新依赖；可视化类能力要求插件自带库（核心包零依赖），插件入口 ≤ 2 MB 的上限不变。
- **权限模型一致**：插件与应用同权限、无沙箱——新能力要在文档里写清「这给了插件什么」，不给「已经隔离」的错觉。
- **内存注册表**：所有插件声明只在内存里，`loadPlugins` 每次全量重建，禁用 / 卸载即消失，不写 `ai-config.json` / localStorage。
- **接线守卫**：每项都要有 `*.test.mjs` 纯逻辑测试 + 登记 `frontend/package.json` 的 `npm test` 清单（`frontend/test/core/test-manifest.test.mjs` 会双向核对）；改动 `ai-tool-defs.js` 还要过 `frontend/test/ai/ai-tool-wiring.test.mjs`。
- **mock 同步**：涉及新 Go 绑定必须在 `frontend/src/dev/mock-backend.js` 补同名 mock（否则 dev 模式即崩）。
- **文档**：`docs/plugins/README.md` 每个新 API 一节（含示例与边界），`CHANGELOG.md` 记录用户可见变更。

**阶段验收**：每项完成后跑 `npm test`（当前基线 1438 项）+ 相关 Go 包测试 + `wails build -devtools`；插件类改动额外用随仓库的 `plugins/zcode2api/` 或新建示例插件做端到端手工验收。
