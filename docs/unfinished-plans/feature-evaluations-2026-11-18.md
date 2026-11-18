# 四项功能评估（2026-11-18）

> 状态：**评估稿，未立项**。四个候选功能只做现状核实与方案建议，未经实施；哪项先行由作者定，立项后各自另立方案文档（本稿作为其事实底座）。
>
> 性质：只读评估，未改动任何代码。行号按 2026-11-18 工作区实测。

## 0. 结论摘要

| # | 功能 | 可行性 | 改动面 | 建议优先级 | 估计工作量 |
|---|------|--------|--------|-----------|-----------|
| 1 | 右键菜单定制（先接「新建」菜单） | 高，机制清晰，成本在条目 id 化 | 纯前端 | 中（价值取决于自用频率） | 0.5–1 天 |
| 2 | 临时文件 | 高，UI 占位已就绪；二次复核后补三项（静默落盘 / 独立目录 / 保存容错） | 前端 + 6 行 Go | **高（成本最低）** | 0.5–0.7 天 |
| 3 | 群聊智能体分组 | 高，一个字段 + 三处 UI | 纯前端 | 高 | 0.5–1 天 |
| 4 | AI search 增强 | 高，但受「rg 不打包」约束，新能力须双路径实现 | 前端 + Go | 中高（对 AI 日常增益最大） | 一期 1 天，二期 0.5–1 天 |

依赖关系：四项互相独立，可任意组合。2 和 3 都是一天内的小活，适合一批做掉。

> **同日后续**：1（右键「新建」菜单定制）已实施（方案与改动清单见 `docs/finished-plans/new-file-menu-customization.md`），§1 仅作原始评估留档；3（智能体分组）已实施（commit `db28961`，agents[].group 必有值 + 两处 UI + AI 代建 group 参数），§3 仅作原始评估留档；§2 已按实测二次复核重写（见 2.0）；4（AI search 增强）一期 + 二期已实施（方案与改动清单见 `docs/finished-plans/ai-search-enhancement.md`），§4 仅作原始评估留档。

---

## 1. 右键菜单定制（先接入「新建」菜单）

> **已完成（2026-11-18）**：本节为原始评估；实施结果见 `docs/finished-plans/new-file-menu-customization.md`。

### 1.1 需求解读

以 explorer 右键的「新建」子菜单为第一个接入点：条目可选是否出现、可排序、可新增（自定义条目）。机制上应为后续接入 explorer 主菜单、编辑器右键菜单留好扩展位，但一期只做「新建」菜单。

### 1.2 现状（代码事实）

- 菜单运行时是数据驱动的通用渲染器：`frontend/src/shell/contextmenu.js` 的 `createContextMenu().open(items, x, y)`，条目形状 `{label, icon/iconHtml, shortcut, disabled, danger, description, badge, submenu, action, sep, checked}`（`contextmenu.js:133-190`）。纯展示层——**条目没有稳定 id**，全靠调用方现场组装。
- 「新建」子菜单在 `explorer-ops.js:393-402` `newFileMenuItems(dirPath)`：文件… / 临时文件（灰占位，见 §2）/ 目录… / 分隔线 / `deps.newFileTypeMenuItems(...)`。
- 文件类型表在 `main.js:1863`：`NEW_FILE_TYPES`（10 项一级）+ `NEW_FILE_TYPES_MORE`（15 项收进「更多」二级），`newFileTypeMenuItems(action)`（`main.js:1907`）按固定顺序展开。
- 其余菜单同样硬编码组装：explorer 主菜单 `showExplorerMenu`（`explorer-ops.js:633-721`）、编辑器右键 `showEditorMenu`（`editor-menus.js:173-239`）、空白处 `showBlankMenu`；md 预览 / SVG / 图片另有专用菜单。很多条目是**上下文相关**的（选中数量、git 状态、阅读模式可用性、AI 引用入口），这些条目不适合进定制。
- 设置持久化通道现成：`settings` 对象在 `applySettings` 尾部落 localStorage（`settings-ui.js:631`），已有同构先例 `settings.keyStyle`（三风格键位表）。

### 1.3 方案建议

**核心动作：给「新建」菜单的条目建立 id 化注册表，配置进 settings，渲染时按配置合成。**

1. 条目 id 化。内置条目给定 id：`file.dialog`（文件…）、`scratch`（临时文件）、`dir.dialog`（目录…）、`type.md` / `type.py` / …（文件类型）、`more`（更多二级）。`newFileTypeMenuItems` 与 `newFileMenuItems` 改为「按 id 生成条目」，注册表保留每项的固定元数据（label、icon、扩展名、danger/disabled 判定函数）。
2. 配置形状（进 settings，随现有 localStorage 通道持久化）：

   ```js
   settings.newFileMenu = {
       order: ['file.dialog', 'scratch', 'dir.dialog', 'type.md', ...],  // 展示顺序
       hidden: ['type.java'],                                            // 不出现的内置 id
       custom: [{ id: 'c1', label: 'Vue 组件', ext: '.vue', content: '<template>...' }], // 自定义模板
   };
   ```

   缺省（无配置 / 字段缺省）= 当前内置顺序与全集，向后兼容零迁移。
3. 「新增」的语义落在新建菜单上就是**自定义文件类型模板**：名字 + 扩展名 + 初始内容。创建走既有链路：`openCreateEntryDialog` 改为带初始内容时直接 `CreateEntry`（`internal/fsops/fsops.go:247`，O_EXCL 空文件）+ `SaveFile` 写模板 + `openPath`，并沿用新建历史（可撤销）。v1 不做模板变量（{date} 之类），要加也是纯函数一行的事。
4. 管理 UI：设置 → 通用（或文件树节）加「新建菜单」小节——列表行 = 显隐开关（`createSwitch`）+ 上移/下移按钮；自定义模板走「添加」弹窗。**不建议做拖拽排序**（成本高、无障碍差），上移/下移足够。另一个入口：右键「新建」子菜单底部加「配置菜单…」直达该设置节（低成本，发现性好）。
5. 范围控制（一期刻意不做）：explorer 主菜单与编辑器右键的上下文条目（Git 差异、AI 引用、比较两文件等）保持硬编码；id 化机制与设置 pane 留出后续扩展位即可。

### 1.4 改动面

- `main.js`：`NEW_FILE_TYPES` 两张表加 id + 默认顺序常量；`newFileTypeMenuItems` 按配置合成（配置读取与归一化抽纯函数）。
- `explorer-ops.js`：`newFileMenuItems` 接配置合成 + 「配置菜单…」入口。
- `settings-ui.js`：settings 默认值与归一化（损坏配置回退默认，不 throw）。
- 设置 pane UI（新代码量最大的一块）。
- 测试：顺序合成 / 配置归一化 / 模板渲染纯函数进 `frontend/test/`（镜像目录）并登记 `npm test` 清单；管理 UI 控件全走 `core/form-controls.js`（表单硬规范，基线只许调小）。

### 1.5 风险与护栏

- **只影响「出现与顺序」，不动语义**：`readOnlyMode` 下「新建」入口的 disabled 判定（`explorer-ops.js:645`）必须保留在合成层，不能被配置绕过。
- 自定义模板内容会写进 settings（localStorage）——模板内容设个长度上限（如 4 KB）防 settings 膨胀。
- 归一化对未知 id（配置残留已删除的自定义项）直接丢弃，不报错。

## 1.6 工作量：0.5–1 天，纯前端，风险低。

---

## 2. 临时文件

> **本节为 2026-11-18 二次复核版（替换原稿）：原稿的「落盘草稿」结论方向正确，但有三处判断需要修正，目录建议从 `.cadt/tmp` 改为 `.cadt/scratch`，工作量 0.5 → 0.5–0.7 天。**

### 2.0 复核结论（先看这里）

| # | 原稿说法 | 复核结果（行号按 2026-11-18 工作区实测） |
|---|---------|----------------------------------------|
| 1 | 落盘草稿 → 会话恢复天然带回，重启不丢 | **高估**。`serializeSession` 只记路径（`frontend/src/shell/session-restore.js:113` `filter(d => d.path)`），恢复时 `restoreSession` → `openPathsHere` 按路径**从盘上重读**；而 `settings.autoSave` 默认 false（`main.js:1507`）。所以会话恢复带回的是「标签」，不是「文字」——没按 Ctrl+S 的输入照样丢。要兑现「随手写、不用管」的预期，必须给草稿文档加静默落盘。 |
| 2 | 有 path → 全链路自然工作 | **成立，但漏了可见性**：`.cadt` 在文件树/列表里都是跳过项（`explorer.js:152` `LIST_SKIP_DIRS` 含 `.cadt`）。草稿建好后树里根本看不到，现有 `refreshDir` + `selectPath` 一行视觉反馈都没有。找回只剩两条路：`Ctrl+Shift+T` 重新打开关闭的标签（`editor-groups.js:1595`，栈深 12）与 文件 → 最近打开（`app-actions.js:27-45`，12 条）。 |
| 3 | Go 零改动（`CreateEntry` + `SaveFile` 够用） | **半成立，但靠的不是这两者**。`CreateEntry` 只建一层、父目录必须已存在（`internal/fsops/fsops.go:247-258`，同名在 `:264` 报错）；`SaveFile` 是裸 `os.WriteFile`（`internal/fileio/fileio.go:365-373`），**不建父目录**。真正现成的是已对前端开放的 `backend.AIEnsureDir`（MkdirAll 幂等，`internal/aichat/chat.go:247`，`ai-panel.js:7754` 早就在用）。零 Go 改动能成立，前提是用它。 |
| 4 | 草稿与 AI 产物同放 `.cadt/tmp` 是特性 | **建议放弃**。`.cadt/tmp` 是 AI 的**免审写区**：`isAutoWriteRisky()` 对 `.cadt/tmp/**` 直接返回 false（`ai-panel.js:7636-7639`），隔离 worktree 期间主根只读也对它例外放行（`ai-worktree.js:84-85`）。用户草稿放这里 = 与免审写区共用目录，AI 覆盖同名文件不需要任何确认；清缓存 `ws-tmp` 时还会连草稿一起清。 |

### 2.1 需求解读

explorer「新建」子菜单里的「临时文件」——快速建一个草稿开始写，不污染工作区正式目录，也不需要先想文件名。

补充原稿没写的现状定位：应用已有两种「新建」，都不是这个语义——

- 文件 → 新建 → 类型：内存未命名文档（`properties-ui.js:9-30` → `newDocumentWith`，`main.js:3471`），即 Ctrl+N 那条路，无 path，重启即丢；
- explorer → 新建 → 类型：先弹名字、再建到被点目录（`explorer-ops.js:353-390`），要先想名字。

「临时文件」填的是中间的空档：**免起名 + 落盘有 path**。

### 2.2 方案建议（修订）

**仍推荐「落盘草稿」，但补三件事：换到独立目录、静默落盘、保存容错。**

1. **目录**：`<ws>/.cadt/scratch/`，文件名 `草稿-YYYYMMDD-HHMMSS.<ext>`（秒级时间戳；`CreateEntry` 同名报错，撞了加序号重试一次）。`<ext>` 由入口决定，见 2.6。一律建在**工作区根**（用 `deps.workspaceFolder`），与右键点的那个目录无关——`newFileMenuItems(dirPath)` 的 `dirPath` 只用于判定入口可用性，不能拿它拼草稿路径。理由见 2.0 第 4 条：不能让用户草稿住在 AI 免审写区。
2. **建目录**：`backend.AIEnsureDir(dir)`（MkdirAll，已有绑定）→ `CreateEntry` → `SaveFile` 写初始内容（空或一行 md 头）→ `openPath`。**不做** `explorer.refreshDir`（`.cadt` 不在树里，刷了也看不见），改为 flash 一行「已建临时草稿：.cadt/scratch/草稿-….<ext>」。3. **静默落盘（关键补充）**：新建时给文档打 `doc.draft = true`；`scheduleAutoSave` 的唯一实现（`writing-ui.js:269-276`）门条件从 `settings.autoSave` 放宽为 `settings.autoSave || 当前文档是 draft`（`setDirty` 已无条件调用它，见 `writing-ui.js:256`）。另有一处「切标签前先存上一个文件」的门在 `editor-groups.js:1451`，同一个条件同样要放宽，否则切走再切回来前的那次输入不落盘。草稿输入 1 秒防抖自动保存，重启回来还是原文；普通文件行为不变。
4. **语义与找回**：草稿就是普通文档，保存/另存为/diff/全局搜索全部照旧（`.cadt` 不在 `searchSkipDirs`，`search.go:35`，草稿可被搜索到）。同会话找回靠 `Ctrl+Shift+T`；跨启动靠 文件 → 最近打开——所以草稿**有意**进最近列表，不屏蔽。
5. **入口两处**：explorer「新建」里的 `scratch` 项（它已是 `new-file-menu.js` 的 `SPECIAL_IDS` 之一，当前因无实现而灰显）+ 文件 → 新建 子菜单同一条（`properties-ui.js:9-30`，无工作区时 disabled）。`explorer-ops.js:427-433` 已留好 `deps.createScratchFile` 钩子（注释写明「编排可能落在本模块或经 deps 注入」），签名扩成 `(dirPath, ext)` 即可接上，**不用改 `new-file-menu.js`**（配置只管出现与顺序，语言选择属动作层）。命令面板会自动收录文件菜单子项（`main.js:4356-4364` `flattenPaletteItems`），不用另写一份。
6. **无工作区**：`workspaceFolder` 为空时两个入口都 disabled，v1 不做「应用数据 scratch/」——省一条 Go 清理条目，真需要时再加。
7. **只读**：父项「新建」已挡 `settings.readOnlyMode`（`explorer-ops.js:692`），子项再挡一层防绕过；`doc.draft` 不得越过只读锁与大文件保护。
8. **存储条目（推荐，约 6 行）**：`internal/storage/specs.go` 加 `id: "ws-scratch"`、`kind: KindCache`、**`inCache: false`**、`workspaceTarget("scratch")`。`inCache: false` 的含义是「一键清缓存不碰用户草稿，需要时单条清」（`specs.go:59`）；`TestSpecTable` 会校验 label/note/targets，`TestCacheIDs`（`storage_test.go:184`）不吃非 inCache 项，**测试零改动**。

### 2.3 改动面

- `explorer-ops.js`：`scratch` 项接 `createScratchDraft()` 编排（AIEnsureDir → CreateEntry → SaveFile → openPath → flash），并进新建历史（撤销 = 删草稿，走回收站）；签名 `(dirPath, ext)`，语言清单复用 `BUILTIN_FILE_TYPES`，不新增表。
- `properties-ui.js`：文件 → 新建 加同一条目（复用同一编排，经 deps 注入，不复制实现）。
- `main.js`：`scratchDraftName(now)` 纯函数（时间戳格式 + 撞名序号）；`doc.draft` 标记随 createDoc/保存流程保值。
- `writing-ui.js`：`scheduleAutoSave` 门条件放宽一条（draft）。
- `editor-groups.js`：切标签前「先存上一个文件」的门（`:1451`）同款放宽。
- Go：`internal/storage/specs.go` +6 行（推荐项）；不想要这条就退回 `.cadt/tmp`，接受 2.0 第 4 条风险。
- 测试：`frontend/test/` 加文件名纯函数用例（时间戳格式 / 撞名序号）并登记 `package.json` 的硬编码 test 清单（`test-manifest.test.mjs` 双向对账）。

### 2.4 风险与护栏

- **清缓存删掉 `scratch/` 后，已打开的草稿再保存会 ENOENT**（`SaveFile` 不建父目录）。护栏：保存失败且错误是「路径不存在」时，`AIEnsureDir` 重建目录后静默重试一次（`main.js` save 分支，约 3 行）。
- `doc.draft` 只买「自动保存」这一个特权，绝不能连只读锁、大文件保护、脏标记语义一起绕。
- 工作区若没有忽略 `.cadt`（本仓 `.gitignore:18` 有，用户目录未必），草稿会出现在 `git status` 里。落地时确认一次；需要就在建目录时补 `.cadt/.gitignore` 一行（10 秒的事，但不该默认假设）。
- 树里不可见是**设计取舍**而不是缺陷：草稿本来就不该占文件树的注意力。代价是不给 flash 就完全没有反馈——所以 flash 是 v1 必做项，不是锦上添花。

### 2.5 工作量：0.5–0.7 天（原 0.5 天上调；多出的是静默落盘、保存容错与一条 storage 条目）。风险仍低，**四项里性价比最高，建议最先做**。

### 2.6 草稿的语言 / 高亮怎么定（2026-11-18 追加）

**事实：本应用没有内容识别高亮，也没有「每文档切换语言」的机制，高亮完全由文件名（扩展名 / 少数固定文件名）决定。**

- 唯一入口 `aceModeFor(fileName, driver)`：`basename → 已知文件名表 fileNameAceModes → extensionAceModes[ext] → 驱动自身的 aceMode → 'text'`（`frontend/src/core/formats.js:509-515`），实际下发给 Ace 的位置是 `frontend/src/editor/editor-ace-hooks.js:29-32`（`session.setMode('ace/mode/…')`）。
- 虚拟文档也是「扩展名定高亮」（`ai/ai-constants.js:524` `cadt.openVirtualDoc(name, content)` 的描述），同一约定。
- `isKnownCodeFileName`（`formats.js:523-526`）只兜「无扩展名但文件名已知」的一批（Dockerfile / Makefile / .gitignore…），是静态白名单，不是嗅探。
- **扩展名不止管着色**：运行配方按它取（`terminal/run.js:452-453` `RECIPES[extOf(doc.name)]`）、图标按它取（`core/fileicons.js`）、格式驱动与可用视图也按它定（`formats.js:427-455` `detectFormat` → 树视图 / 表格视图 / 预览）。所以草稿不能「随便给个 .txt 再靠识别」。

**结论：草稿必须带扩展名，选语言 = 选扩展名。**

- **v1（推荐，零新机制）**：把 `scratch` 项做成二级菜单，语言清单**复用** `BUILTIN_FILE_TYPES`（`explorer/new-file-menu.js:28-54`，25 项，`top`/`more` 已分好层）。顶层「临时文件」= 上次用过的扩展名（`settings.scratchExt`，缺省 `.md`）一键建；二级列常用项 + 「更多…」。文件名 `草稿-YYYYMMDD-HHMMSS.<ext>`。
- 一键到底的做法：顶层项直接用 `.md`（或上次扩展名）建，二级才是「临时文件（选择语言）」。多一层菜单就少一分「什么都不用想」的爽感，别让默认路径变长。
- **不做内容嗅探**：规则永远不全，且与「扩展名决定一切」的既有分派链打架（嗅探出 Python 但 `doc.format` 仍是 text，运行配方、图标、视图全都对不上）。
- **后续（另立项，与本项解耦）**：真正的「文档语言覆盖」——`doc.langOverride` 传给 `aceModeFor` 第三参，只改 Ace 着色，**绝不能改 `doc.format`**（否则 `.py` 会被 JSON 驱动器解析，树/表格视图与保存序列化一起乱）；持久化进 `sessions.views`（`rememberDocView`/`knownDocViews`）；入口放状态栏语言区或标签右键。它顺带解决存量痛点：`.txt` 里的 Python、无扩展名脚本今天完全没法高亮。

---

## 3. 群聊智能体分组（强制分组）

### 3.1 需求解读

智能体按用途强制分组（如「写作」「编码」），不选分组归「默认」组。动因：智能体多起来后（上限 32 个，`ai-agent-model.js:10`），平铺列表找不到人；写作任务下会建一批写作相关智能体，希望聚在一起。

### 3.2 现状（代码事实）

- 智能体真源：`ai-config.json` 的 `agents[]`（`main.js:613` 注释；`ai-agent-settings.js:1-4` 头注）。字段归一在 `normalizeAgent`（`ai-agent-model.js:53-79`）：id / name / color / role / modelRef / personaText / replyStyle / temperature / slowTier / chair / enabled / createdAt / updatedAt——**无 group 字段**。
- 管理 UI：设置 → AI → 智能体（`ai-agent-settings.js`），`renderAgentsPane` 平铺卡片列表（:67-125）+ 编辑器居中弹窗（:134-240，表单全走 form-controls 工厂）。
- 新建群聊弹窗：`ai-group-sidebar.js:162` `openCreateDialog`，成员是平铺开关列表（`gc-member-list`，:196-227），逐成员预检徽标，主持人下拉来自 `chair` 标记。
- AI 代建：app_control `get_agents` / `create_agent`（`ai-agent-model.js:194-238`），创建走 `agentsUpsert` 纯函数。
- 群聊按 agentId 引用成员（meta.json memberIds），不按组；群聊方案 `docs/finished-plans/ai-group-chat.md` §6.1 的 schema 未提分组，G5 增强也未含此项。

### 3.3 方案建议

**核心判断：分组不该是独立存储实体，就是 agents[] 上的一个必有值字段。** 「强制分组」的实现即「归一化时字段必有值，空 → 『默认』」——分组列表 = `agents[].group` 的去重集合，天然满足「不选就归默认」，且不产生第三份真源（不进 SQLite、不建单独文件），与现有「agents[] 即真源、就地改 + saveAIConfig」模式（`ai-agent-settings.js:275-286`）完全一致。

1. 数据层（`ai-agent-model.js`）：
   - `normalizeAgent` 加 `group: clampText(source.group, 16) || '默认'`（去空白，NFC）；
   - 加纯函数 `agentGroups(agents)`（保序去重，'默认' 恒在）与 `agentsByGroup(agents)`（分区聚合，供两处 UI 共用）；
   - 旧配置零迁移：归一化时无 group 自动落「默认」。
   - 防膨胀：组数上限（如 12），超出在 `agentsUpsert` 报错；组名走 `agentNameError` 同款校验（禁空白两端、限长）。
2. 管理 UI（`ai-agent-settings.js`）：
   - 编辑器弹窗加「分组」行：`createSelect`，选项 = 现有组 + 「＋新建分组…」（选中弹出命名输入框，非 select 的 optgroup——行式下拉增强不支持嵌套）。缺省「默认」。
   - `renderAgentsPane` 按 `agentsByGroup` 分区渲染：组头（组名 + 计数）+ 组内卡片；空组不显示（组随最后一个成员删除而消失，无需显式删组）。组内排序沿用现有顺序。
   - 重命名组 = 就地改所有成员的 group 字段；删组 = 成员落回「默认」。都是字段操作，无 API。
3. 新建群聊弹窗（`ai-group-sidebar.js:196-227`）：成员列表按组分区渲染（组头行 + 组内开关行），`memberSwitches` / `collectCreateDraft` 数据结构不动（仍按 agentId 收集）。组多（>4）时在成员区顶部加「分组过滤」下拉（全部 / 某组），过滤是纯展示。
4. AI 代建：`create_agent` 参数加可选 `group`（描述写明「缺省归默认分组」），`get_agents` 返回带 group；`resolveModelByKeyword` 等不动。
5. 不受影响：预检（按 agentId）、主持人机制（chair 标记跨组有效——主持人可以在任何组，不强制归组）、群 meta 存储。

### 3.4 改动面

- `ai-agent-model.js`（数据层 + 纯函数）、`ai-agent-settings.js`（列表分区 + 编辑器行）、`ai-group-sidebar.js`（成员分区 + 过滤）、`ai-panel.js` 的 `create_agent` 分支（透传 group）。
- `frontend/wailsjs/`：无 Go 改动则不需要重新生成（group 是 ai-config.json 内部字段，不走 Wails 绑定）。
- 测试：`ai-agent-model` 纯函数用例（归一化落默认 / 组聚合保序 / 组数上限 / AI 代建 group 透传）；登记 `npm test`。

### 3.5 风险与护栏

- 低。注意两点：组名「默认」本身是保留组名（用户不能新建一个叫「默认」的第二组——去重集合天然保证，但 UI 要禁住）；`@点名` / 保留名机制（`AGENT_RESERVED_NAMES`）不受影响，组名与成员名是两个命名空间。

## 3.6 工作量：0.5–1 天，纯前端，风险低。

---

## 4. AI search 增强

> **已完成（2026-11-18，一期 + 二期全做）**：本节为原始评估；实施结果见 `docs/finished-plans/ai-search-enhancement.md`。

### 4.1 需求解读

给 AI 的 `search_text` 受限：只支持字面量子串，而 AI 自己写 grep（run_command）表达力强得多。评估封装工具能否更丰富，而不是逼 AI 绕 shell。

### 4.2 现状（代码事实）

- 工具面：`search_text`（`ai-tool-defs.js:59-72`）参数仅 query / path / caseSensitive / filePattern，默认 200 条；描述里明确调度原则「有专用工具就不要用 run_command 绕：…搜索…用 search_text」（`ai-tool-defs.js:1172`）。
- 执行：`ai-panel.js:8611-8661`，走 `resolveScanRoot` 读根授权链（这是它比 run_command 安全的根本原因：不弹审批卡也能受控出工作区，`ai-read-roots.js`）。
- Go 引擎双路径（`internal/search/`）：
  - 系统 rg 路径：`exec.LookPath("rg")`（`search_rg.go:222`）——**rg 不打包**（体积红线），用户装了才有；参数 `-F`（**固定串，无正则**）+ `-i` + `--glob` + 两趟产物档降权（`search_rg.go:24-66`）。
  - 内置 Go 扫描兜底（`search.go:285-383`）：字面子串匹配，同样无正则；fzf 式模糊（`SearchWorkspaceFuzzy`）只给 UI 全局搜索用，AI 面不走。
  - 共同限额：预算 3.5s、单文件 30 命中、单文件 4 MB、结果 ≤1000（`search.go:22-30`）。
- 结果输出：`相对路径:行号: 预览` 纯文本（`ai-panel.js:8647-8660`）。

### 4.3 用户判断的评估

**部分成立，且根因明确：受限的不是架构而是匹配表达力（字面量 only）与输出形态（纯行命中）。** 「AI 自己写 grep 更强」的另一面是：run_command 要审批、引号/编码转义易错、还有权限旁路风险——调度原则（1172 行）的方向是对的，正路是**把 grep 最常用的那部分表达力搬进 search_text 参数**，而不是放开 shell。约束只有一条是硬的：**rg 不打包 → 新能力必须 rg 路径与内置扫描路径同时实现**，否则「装没装 rg」行为分裂（内置路径现在是纯手写字面量循环，加正则要用 Go `regexp`，RE2 线性时间，无回溯风险）。

### 4.4 方案建议（按性价比排序）

| 参数 | rg 实现 | 内置扫描实现 | 价值 | 建议 |
|------|---------|-------------|------|------|
| `regex: true` | 去掉 `-F`，pattern 直传（`-e`） | Go `regexp` 逐行匹配 | **最大**（`\w+\(` 、`foo|bar` 、锚点） | 一期 |
| `wholeWord: true` | `-w` | `regexp` `\b` 包裹 | 中高 | 一期 |
| `excludePattern` | `--glob !pattern` | walk 时 `globMatchPath` 取反（`:464` 旁） | 中高（「除 tests 外」） | 一期 |
| `outputMode: 'files'/'count'` | rg 原生 | 聚合 hits | 高（大结果先拿文件清单再 read_file，省大量 token） | 二期 |
| `context: N`（≤3） | `-C` | `scanSearchFile` 加前后行缓冲 | 中（token 成本放大，必须限 N） | 二期 |
| maxResults 参数化（100–1000） | 透传 | 透传 | 中 | 一期顺带 |

明确不做：多行正则（rg `-U` + 内置跨行扫描，复杂度/收益比差）；把 rg 任意 flags 透传给模型（失控面）；用 run_command 跑 rg 作为常规路径（与调度原则冲突）。

### 4.5 改动面（按 AGENTS.md「AI 工具增删改」清单核对）

- Go：`internal/search` 的 `searchWorkspace` / `rgGlobalArgs` / `scanSearchFile` 加参数（建议聚成一个 options struct，避免第八个位置参数）；`*_test.go` **两条路径同断言**（可用 `DATALENS_NO_RG=1` 强制内置路径对拍，环境变量钩子已存在，`search.go:423`）。
- `app_fs.go` / 绑定层：`SearchWorkspace` / `SearchWorkspaceFiltered` 签名变化或新增 `SearchWorkspaceAdvanced`（旧签名保留兼容 UI 全局搜索——它也调这两个绑定，`global-search.js` 走 fuzzy 路径不受影响）；`frontend/wailsjs/` 重新生成。
- `ai-tool-defs.js`：参数 properties + 描述（何时用正则、何时字面量、outputMode 的 token 语义）；`AI_TOOL_CATALOG` blurb 若变同步测试断言。
- `ai-panel.js` executeTool 分支透传。
- **`dev/mock-backend.js` 补同名 mock**（漏了 dev 模式调用即崩——工具改动清单明确项）。
- 守卫：`ai-tool-wiring.test.mjs` 会核对「描述提到的参数名 ↔ properties ↔ 分支读取」，新增参数三处对齐；调度原则段（`ai-tool-defs.js:1172-1184`）检查分工句是否要补「正则用 regex:true」。
- 测试：Go 表驱动 + 前端纯函数（参数归一化、files/count 聚合格式化）。

### 4.6 风险与护栏

- 中低。主要风险是两条路径行为漂移——护栏就是双路径对拍测试进 CI；正则来源是模型输入，Go `regexp`（RE2）天然线性时间，无灾难性回溯，比直接放 shell 安全得多。
- token 预算：context 与 maxResults 放开都会放大结果体积，输出端保留现有 200 条截断 + 截断提示逻辑（`ai-panel.js:8638-8656`）作为最后一道闸。

## 4.7 工作量：一期（regex + wholeWord + excludePattern + maxResults）1 天；二期（outputMode + context）0.5–1 天。

---

## 5. 综合建议

1. **先做 2（临时文件）**：3 已完成（`db28961`），2 是剩下三项里最小的一件，今日复核后建议口径见 §2；0.5–0.7 天可收。
2. ~~**再做 4 一期**~~：**4 已一期 + 二期全做**（2026-11-18，见 `docs/finished-plans/ai-search-enhancement.md`）；对 AI 日常使用增益最大，Go 侧改动可控（环境变量对拍钩子现成）。
3. **1 最后**：价值最主观（取决于自用频率），且管理 UI 成本最高；机制不影响其他三项，随时可插入。
4. 立项后按本仓惯例各自另立方案文档（从本稿对应章节拷贝事实底座），实施完成移 `docs/finished-plans/`。
