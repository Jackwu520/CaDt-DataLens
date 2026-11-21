# 临时文件（落盘草稿）：explorer「新建」里的免起名草稿

> 状态：**已实施（2026-11-21）**——方案原文保留不变，实施时与方案的三处偏差、以及落地后的实际接线见 §8；同日晚按用户反馈补了**文件树内的「临时草稿」节点**并更正了「树里看不见」这处事实错误，见 §8.1。
> 事实底座：从 `docs/finished-plans/feature-evaluations-2026-11-18.md` §2 抽离成独立方案；原稿「落盘草稿」结论方向正确，二次复核修正三处判断（目录 `.cadt/tmp` → `.cadt/scratch`、补静默落盘与保存容错），行号按 2026-11-18 工作区实测。
> 范围：前端为主 + Go 侧 6 行存储条目；不改会话存储格式，不新增依赖。

## 0. 复核结论（先看这里）

| # | 原稿说法 | 复核结果（行号按 2026-11-18 工作区实测） |
|---|---------|----------------------------------------|
| 1 | 落盘草稿 → 会话恢复天然带回，重启不丢 | **高估**。`serializeSession` 只记路径（`frontend/src/shell/session-restore.js:113` `filter(d => d.path)`），恢复时 `restoreSession` → `openPathsHere` 按路径**从盘上重读**；而 `settings.autoSave` 默认 false（`main.js:1507`）。所以会话恢复带回的是「标签」，不是「文字」——没按 Ctrl+S 的输入照样丢。要兑现「随手写、不用管」的预期，必须给草稿文档加静默落盘。 |
| 2 | 有 path → 全链路自然工作 | **成立，但漏了可见性**：`.cadt` 在列表视图里是跳过项（`explorer.js:152` `LIST_SKIP_DIRS` 含 `.cadt`；**更正见 §8.1：这张表当时只作用于列表引擎与文件通知，树其实把 `.cadt` 原样显示**）。草稿建好后没有任何视觉反馈，现有 `refreshDir` + `selectPath` 也用不上。找回只剩两条路：`Ctrl+Shift+T` 重新打开关闭的标签（`editor-groups.js:1595`，栈深 12）与 文件 → 最近打开（`app-actions.js:27-45`，12 条）。 |
| 3 | Go 零改动（`CreateEntry` + `SaveFile` 够用） | **半成立，但靠的不是这两者**。`CreateEntry` 只建一层、父目录必须已存在（`internal/fsops/fsops.go:247-258`，同名在 `:264` 报错）；`SaveFile` 是裸 `os.WriteFile`（`internal/fileio/fileio.go:365-373`），**不建父目录**。真正现成的是已对前端开放的 `backend.AIEnsureDir`（MkdirAll 幂等，`internal/aichat/chat.go:247`，`ai-panel.js:7754` 早就在用）。零 Go 改动能成立，前提是用它。 |
| 4 | 草稿与 AI 产物同放 `.cadt/tmp` 是特性 | **建议放弃**。`.cadt/tmp` 是 AI 的**免审写区**：`isAutoWriteRisky()` 对 `.cadt/tmp/**` 直接返回 false（`ai-panel.js:7636-7639`），隔离 worktree 期间主根只读也对它例外放行（`ai-worktree.js:84-85`）。用户草稿放这里 = 与免审写区共用目录，AI 覆盖同名文件不需要任何确认；清缓存 `ws-tmp` 时还会连草稿一起清。 |

## 1. 需求解读

explorer「新建」子菜单里的「临时文件」——快速建一个草稿开始写，不污染工作区正式目录，也不需要先想文件名。

补充原稿没写的现状定位：应用已有两种「新建」，都不是这个语义——

- 文件 → 新建 → 类型：内存未命名文档（`properties-ui.js:9-30` → `newDocumentWith`，`main.js:3471`），即 Ctrl+N 那条路，无 path，重启即丢；
- explorer → 新建 → 类型：先弹名字、再建到被点目录（`explorer-ops.js:353-390`），要先想名字。

「临时文件」填的是中间的空档：**免起名 + 落盘有 path**。

## 2. 方案建议

**仍推荐「落盘草稿」，但补三件事：换到独立目录、静默落盘、保存容错。**

1. **目录**：`<ws>/.cadt/scratch/`，文件名 `草稿-YYYYMMDD-HHMMSS.<ext>`（秒级时间戳；`CreateEntry` 同名报错，撞了加序号重试一次）。`<ext>` 由入口决定，见 §6。一律建在**工作区根**（用 `deps.workspaceFolder`），与右键点的那个目录无关——`newFileMenuItems(dirPath)` 的 `dirPath` 只用于判定入口可用性，不能拿它拼草稿路径。理由见 §0 第 4 条：不能让用户草稿住在 AI 免审写区。存储位置经 JetBrains 调研复核后**维持不变**，理由见 §7.2。
2. **建目录**：`backend.AIEnsureDir(dir)`（MkdirAll，已有绑定）→ `CreateEntry` → `SaveFile` 写初始内容（空或一行 md 头）→ `openPath`。**不做** `explorer.refreshDir`（`.cadt` 不在树里，刷了也看不见），改为 flash 一行「已建临时草稿：.cadt/scratch/草稿-….<ext>」。
3. **静默落盘（关键补充）**：新建时给文档打 `doc.draft = true`；`scheduleAutoSave` 的唯一实现（`writing-ui.js:269-276`）门条件从 `settings.autoSave` 放宽为 `settings.autoSave || 当前文档是 draft`（`setDirty` 已无条件调用它，见 `writing-ui.js:256`）。另有一处「切标签前先存上一个文件」的门在 `editor-groups.js:1451`，同一个条件同样要放宽，否则切走再切回来前的那次输入不落盘。草稿输入 1 秒防抖自动保存，重启回来还是原文；普通文件行为不变。
4. **语义与找回**：草稿就是普通文档，保存/另存为/diff/全局搜索全部照旧（`.cadt` 不在 `searchSkipDirs`，`search.go:35`，草稿可被搜索到）。同会话找回靠 `Ctrl+Shift+T`；跨启动靠 文件 → 最近打开——所以草稿**有意**进最近列表，不屏蔽。**另加一个轻量的「临时草稿」入口补上持久找回路径**（flash 一闪而过、关闭标签栈与最近列表都有上限），见 §7.3 第 1 条。
5. **入口三处**：explorer「新建」里的 `scratch` 项（它已是 `new-file-menu.js` 的 `SPECIAL_IDS` 之一，当前因无实现而灰显）+ 文件 → 新建 子菜单同一条（`properties-ui.js:9-30`，无工作区时 disabled）。`explorer-ops.js:427-433` 已留好 `deps.createScratchFile` 钩子（注释写明「编排可能落在本模块或经 deps 注入」），签名扩成 `(dirPath, ext)` 即可接上，**不用改 `new-file-menu.js`**（配置只管出现与顺序，语言选择属动作层）。命令面板会自动收录文件菜单子项（`main.js:4356-4364` `flattenPaletteItems`），不用另写一份。第三处：**编辑器选区 →「存为临时草稿」**，把选中文本作为草稿初始内容，见 §7.3 第 3 条。
6. **无工作区**：`workspaceFolder` 为空时两个入口都 disabled，v1 不做「应用数据 scratch/」——省一条 Go 清理条目，真需要时再加。
7. **只读**：父项「新建」已挡 `settings.readOnlyMode`（`explorer-ops.js:692`），子项再挡一层防绕过；`doc.draft` 不得越过只读锁与大文件保护。
8. **存储条目（推荐，约 6 行）**：`internal/storage/specs.go` 加 `id: "ws-scratch"`、`kind: KindCache`、**`inCache: false`**、`workspaceTarget("scratch")`。`inCache: false` 的含义是「一键清缓存不碰用户草稿，需要时单条清」（`specs.go:59`）；`TestSpecTable` 会校验 label/note/targets，`TestCacheIDs`（`storage_test.go:184`）不吃非 inCache 项，**测试零改动**。
9. **关闭空草稿自动删除**：关闭标签时若 `doc.draft` 且内容为空（或仅剩初始 md 头），删文件走回收站、不弹确认，见 §7.3 第 2 条。只针对 `doc.draft`，普通文件绝不自动删。

## 3. 改动面

- `explorer-ops.js`：`scratch` 项接 `createScratchDraft()` 编排（AIEnsureDir → CreateEntry → SaveFile → openPath → flash），并进新建历史（撤销 = 删草稿，走回收站）；签名 `(dirPath, ext)`，语言清单复用 `BUILTIN_FILE_TYPES`，不新增表。
- `properties-ui.js`：文件 → 新建 加同一条目（复用同一编排，经 deps 注入，不复制实现）。
- `main.js`：`scratchDraftName(now)` 纯函数（时间戳格式 + 撞名序号）；`doc.draft` 标记随 createDoc/保存流程保值；保存失败 ENOENT 重建重试（§4）。
- `writing-ui.js`：`scheduleAutoSave` 门条件放宽一条（draft）。
- `editor-groups.js`：切标签前「先存上一个文件」的门（`:1451`）同款放宽；关闭标签时空草稿自动删（§7.3 第 2 条）。
- `editor-menus.js`：编辑器右键加「存为临时草稿」（§7.3 第 3 条），初始内容取当前选区。
- `quick-switch.js`：新增「临时草稿」层，列出 `<ws>/.cadt/scratch/`（§7.3 第 1 条）。
- Go：`internal/storage/specs.go` +6 行（推荐项）；不想要这条就退回 `.cadt/tmp`，接受 §0 第 4 条风险。
- 测试：`frontend/test/` 加文件名纯函数用例（时间戳格式 / 撞名序号）并登记 `package.json` 的硬编码 test 清单（`test-manifest.test.mjs` 双向对账）。

## 4. 风险与护栏

- **清缓存删掉 `scratch/` 后，已打开的草稿再保存会 ENOENT**（`SaveFile` 不建父目录）。护栏：保存失败且错误是「路径不存在」时，`AIEnsureDir` 重建目录后静默重试一次（`main.js` save 分支，约 3 行）。
- `doc.draft` 只买「自动保存 / 关闭空删」这两项特权，绝不能连只读锁、大文件保护、脏标记语义一起绕。
- 工作区若没有忽略 `.cadt`（本仓 `.gitignore:18` 有，用户目录未必），草稿会出现在 `git status` 里。落地时确认一次；需要就在建目录时补 `.cadt/.gitignore` 一行（10 秒的事，但不该默认假设）。
- 树里不可见是**设计取舍**而不是缺陷（**2026-11-21 更正：改为树根下独立的「临时草稿」节点，见 §8.1**）：草稿本来就不该占文件树的注意力。代价是不给 flash 就完全没有反馈——所以 flash 是 v1 必做项，不是锦上添花；§7.3 第 1 条的草稿架是 flash 之外的持久兜底。

## 5. 工作量

0.8–1.1 天。原估 0.5–0.7 天（静默落盘 + 保存容错 + storage 条目），2026-11-21 纳入 JetBrains 调研的三条借鉴点后上调约 0.3–0.4 天：草稿架层 0.2–0.3、选区创建 0.1、关闭空删 0.05。若排期紧，草稿架层可后置 v1.1，其余两条留在 v1。风险仍低，在原四项功能评估里性价比最高，建议最先做。

## 6. 草稿的语言 / 高亮怎么定（2026-11-18 追加）

**事实：本应用没有内容识别高亮，也没有「每文档切换语言」的机制，高亮完全由文件名（扩展名 / 少数固定文件名）决定。**

- 唯一入口 `aceModeFor(fileName, driver)`：`basename → 已知文件名表 fileNameAceModes → extensionAceModes[ext] → 驱动自身的 aceMode → 'text'`（`frontend/src/core/formats.js:509-515`），实际下发给 Ace 的位置是 `frontend/src/editor/editor-ace-hooks.js:29-32`（`session.setMode('ace/mode/…')`）。
- 虚拟文档也是「扩展名定高亮」（`ai/ai-constants.js:524` `cadt.openVirtualDoc(name, content)` 的描述），同一约定。
- `isKnownCodeFileName`（`formats.js:523-526`）只兜「无扩展名但文件名已知」的一批（Dockerfile / Makefile / .gitignore…），是静态白名单，不是嗅探。
- **扩展名不止管着色**：运行配方按它取（`terminal/run.js:452-453` `RECIPES[extOf(doc.name)]`）、图标按它取（`core/fileicons.js`）、格式驱动与可用视图也按它定（`formats.js:427-455` `detectFormat` → 树视图 / 表格视图 / 预览）。所以草稿不能「随便给个 .txt 再靠识别」。

**结论：草稿必须带扩展名，选语言 = 选扩展名。**

- **v1（推荐，零新机制）**：把 `scratch` 项做成二级菜单，语言清单**复用** `BUILTIN_FILE_TYPES`（`explorer/new-file-menu.js:28-54`，25 项，`top`/`more` 已分好层）。顶层「临时文件」= 上次用过的扩展名（`settings.scratchExt`，缺省 `.md`）一键建；二级列常用项 + 「更多…」。文件名 `草稿-YYYYMMDD-HHMMSS.<ext>`。
- 一键到底的做法：顶层项直接用 `.md`（或上次扩展名）建，二级才是「临时文件（选择语言）」。多一层菜单就少一分「什么都不用想」的爽感，别让默认路径变长。
- **不做内容嗅探**：规则永远不全，且与「扩展名决定一切」的既有分派链打架（嗅探出 Python 但 `doc.format` 仍是 text，运行配方、图标、视图全都对不上）。§7.3 第 3 条的选区创建也沿用此约束——扩展名取当前文档，不嗅探选区内容。
- **后续（另立项，与本项解耦）**：真正的「文档语言覆盖」——`doc.langOverride` 传给 `aceModeFor` 第三参，只改 Ace 着色，**绝不能改 `doc.format`**（否则 `.py` 会被 JSON 驱动器解析，树/表格视图与保存序列化一起乱）；持久化进 `sessions.views`（`rememberDocView`/`knownDocViews`）；入口放状态栏语言区或标签右键。它顺带解决存量痛点：`.txt` 里的 Python、无扩展名脚本今天完全没法高亮。

## 7. JetBrains Scratch 调研对照（2026-11-21）

来源：JetBrains 官方 IntelliJ IDEA 文档「Scratch files」（2026.3 版，2026-08-17 更新），https://www.jetbrains.com/help/idea/scratches.html 。Rider 等 JetBrains 系产品同套机制。

### 7.1 JetBrains 机制摘要

- **两类对象**：**Scratch file** —— 功能完整、可运行可调试、支持语法高亮与补全，数量不限；**Scratch buffer** —— 纯文本、无任何编码辅助，最多 5 个（默认 `buffer1.txt`…`buffer5.txt`），到第 5 个后**轮转复用**（提示清空重建），重命名可避免被回收。
- **存储**：默认在 **IDE 配置目录**的 `scratches/` 下，对用同一配置目录的任何 IDE / 项目可见——scratch **不绑定项目**；可用平台属性 `idea.scratch.path`（或 `idea.scratch.path/scratches`）改位置。
- **创建**：`File | New | Scratch File`（`Ctrl+Alt+Shift+Insert`）创建时选语言，同类型自动编号（`Scratch1.java`…）；也可从编辑器选区创建（`Alt+Enter` → Create new scratch file from selection），会**尝试探测选中片段的语言**，探测失败则沿用原文件类型/扩展名。Java scratch 自动生成 class 声明 + `main()`。
- **生命周期**：**关闭空 scratch 文件的标签 → 自动删除**。
- **找回**：Project 视图专门的 `Scratches and Consoles | Scratches` 节点 + `Show Scratch Files` 弹窗（`Ctrl+Shift+A`）+ `Ctrl+Q` 看位置/类型/大小/创建修改日期。
- **纳入项目**：F6 移动 / 拖拽 / 剪切粘贴，把 scratch 移进正式项目目录。
- **事后改语言**：右键 → Change Language（可搜索语言名）。

### 7.2 与本方案的对照

| 维度 | JetBrains Scratch | 本方案 | 结论 |
|---|---|---|---|
| 存储位置 | IDE 配置目录 `scratches/`，跨项目共享 | 工作区 `.cadt/scratch/` | **维持本方案**，见下方理由 |
| 对象分类 | scratch file + buffer（5 个轮转） | 单一落盘草稿 | 保持单一；buffer 轮转在 DataLens 场景价值低 |
| 命名 | 类型名 + 序号（`Scratch1.java`） | `草稿-时间戳.<ext>` | 保持时间戳，更利于找回 |
| 语言/高亮 | 创建选语言 + 选区探测 + 事后 Change Language | 选扩展名 = 选语言，不嗅探 | 保持；事后改语言已在 §6 列为后续 |
| 找回 | 项目树里的 `Scratches and Consoles` 节点 + Show Scratch Files 弹窗 | flash + 最近打开 + Ctrl+Shift+T → 后加 quick-switch 草稿架 + **树内「临时草稿」节点** | **补草稿架**（§7.3 第 1 条）；树节点见 §8.1 |
| 空文件 | 关闭空标签自动删 | 无规则 | **补**（§7.3 第 2 条） |
| 选区创建 | `Alt+Enter` 从选区建 | 无 | **补**（§7.3 第 3 条） |
| 纳入项目 | F6 移动 / 拖拽 | 另存为 | 保持另存为，够用 |
| 自动保存 | IDE 自动保存模型天然落盘 | `doc.draft` 放宽自动保存门 | 保持（§2 第 3 条） |

**存储位置维持工作区 `.cadt/scratch/`**：JetBrains 跨项目共享的前提是「这段代码片断以后别的项目也能用」，而 DataLens 的草稿绝大多数围着当前工作区的数据写（一段 JSONPath、CSV 清洗脚本、对照笔记），换目录即失效。工作区存放还有两个附带好处——备份/迁移时草稿自然跟着走、多工作区天然隔离（不会像 JetBrains 那样所有项目草稿堆在一个节点里互相干扰）。§0 第 4 条、§2 第 8 条、§4 的护栏已覆盖「不进 AI 免审写区 / 不进一键清缓存 / 目录被删重建」。

### 7.3 三条借鉴点的落地决定

1. **草稿架入口（找回）—— 建议纳入 v1，轻量版**。§0 第 2 条指出草稿在文件树不可见，flash 一闪而过、关闭标签栈（深 12）与最近列表（12 条）都有上限，缺少一个持久的集中入口。JetBrains 的 `Scratches` 节点证明草稿不该混进正式文件树、但需要专门的查看入口。落地：复用 `quick-switch.js` **现有层级机制**（已有「窗口」「书签」层先例），新增「临时草稿」层，列出 `<ws>/.cadt/scratch/` 下文件（按 mtime 倒序），选中即 `openPath`——零新 UI 组件、纯数据接入。边界：只读当前工作区的 scratch 目录（与存储决定一致）。若排期紧可后置 v1.1，但这是 flash 之外唯一持久的找回路径，建议 v1 做。**2026-11-21 追加决定见 §8.1**：主入口改成文件树里的固定节点（对齐 JetBrains），这一层保留为键盘入口。
2. **关闭空草稿自动删除 —— 纳入 v1**。借鉴 JetBrains「关闭空 scratch 标签自动删」。落地：`closeDocNow` 关闭标签时，若 `doc.draft` 且内容为空（或仅剩初始 md 头），删文件走回收站、不弹确认——复用 §3 新建历史撤销已有的删除通路。护栏：只删带 `doc.draft` 标记的文档，普通文件绝不自动删；删除失败静默忽略，不阻塞关标签。
3. **从选区创建草稿 —— 纳入 v1**。借鉴 JetBrains `Alt+Enter` → Create new scratch file from selection。落地：编辑器右键菜单（`editor-menus.js`）加「存为临时草稿」，把当前选区文本作为 `SaveFile` 初始内容，**扩展名取当前文档的扩展名，不嗅探选区内容**（与 §6 约束一致，避免 `doc.format` 与高亮分派错位）。无选区时该项不出现。选中一段 JSONPath / 代码随手存草稿，在 DataLens 里比走 AI 面板更直接。

## 8. 实施记录（2026-11-21）

全部落地。文件名 / 目录 / 标记 / 自动保存 / 空删 / 草稿架 / 选区创建 / 存储条目都按方案实现，**三处按实际风险与可测性做了调整**：

| # | 方案说法 | 实际实现 | 原因 |
|---|---------|---------|------|
| 1 | 存储条目 `kind: KindCache` + `inCache: false` | **`kind: KindData`** + `inCache: false` | `internal/storage/clear.go` 的 `removePath`：只有 `KindCache` 走 `os.RemoveAll` 直删，`KindData` 才送回收站。草稿是用户亲手写的内容，单条清除必须能取回；`inCache: false` 保证一键清缓存不碰它（`TestMustNotBeCached` 已加负向断言）。 |
| 2 | 「顶层项一键建」与「二级菜单选语言」两种说法并存 | `scratch` 项做成**一个子菜单**：首行「临时文件（.md）」= 上次扩展名一键建，其后是常用语言，末尾「更多…」 | 新建菜单里出现两行都叫「临时文件」的条目更难认；子菜单首行仍是一键到底（悬停 + 单击），且两个入口（资源管理器 / 文件 → 新建）共用一份 `scratchMenuItems`。 |
| 3 | `main.js` 里的 `scratchDraftName(now)` 纯函数 | 纯函数全部落在 **`frontend/src/core/scratch.js`** | `main.js` 依赖 DOM 无法单测；`core/` 同时被 explorer（编排）、editor（空删）、quick-switch（草稿架）引用，命名与判空只能有一份。 |

落地时多做了两件事（都属于「同一个语义只判一次」）：

- **`doc.draft` 的判定下沉到 `openPathsHere`**：不再只在新建时打标，而是「路径落在 `<ws>/.cadt/scratch/` 就是草稿」。这样从草稿架、最近打开、会话恢复进来的草稿同样享受静默落盘与关闭空删；`saveDoc` 落盘后再按落点重判一次（另存为到草稿目录外即失去草稿身份，避免关标签时误删用户文件）。
- **空白草稿关闭不弹「未保存」确认**：`requestCloseDoc` 对 `isBlankDraft(doc)` 直接走 `closeDocNow`，与「关闭空 scratch 标签自动删」是同一个交互决策的两半。

改动面（实际）：

- 新增 `frontend/src/core/scratch.js`（目录 / 命名 / 扩展名 / 空白判定 / 草稿架列表）+ `frontend/test/core/scratch.test.mjs`（6 例，已登记 `npm test` 清单）。
- `explorer/explorer-ops.js`：`createScratchFile`（AIEnsureDir → CreateEntry 撞名重试 → SaveFile → openPath → flash → 进新建历史）与 `scratchMenuItems`；`scratch` 项从灰占位改为子菜单。
- `shell/properties-ui.js`：文件 → 新建 加同一条目（复用 `scratchMenuItems`，不复制实现）。
- `editor/editor-menus.js`：选区「存为临时草稿」（全局只读锁下不出现；标签级只读锁不拦——只写新文件，不动原文档）。
- `writing/writing-ui.js` + `editor/editor-groups.js` + `settings/settings-ui.js`：自动保存的门改为 `settings.autoSave || doc.draft`（含切标签前那次 flush 与设置变更后的重挂）。
- `editor/editor-groups.js`：空白草稿关闭即回收站删除、不进关闭标签栈。
- `shell/quick-switch.js` + `main.js`：新增「临时草稿」层（进层时刷新 `<ws>/.cadt/scratch`，按 mtime 倒序）。
- `internal/storage/specs.go`：`ws-scratch` 条目；`storage_test.go` 的负向断言补一条。
- 未动：会话格式、关闭标签栈、最近打开（草稿**有意**进最近列表）。

验证：前端全量 `npm test`（2055 项）、`npx vite build`、`go build ./...`、`go test ./internal/storage/` 全过。

已知取舍：`.md` / `.html` 的首屏在 `createDoc` 里统一是预览视图（写不了字）。草稿「立刻能写」是它的全部价值，所以**只对空草稿**在创建后切到代码视图（`createScratchFile` 里一行 `switchMode('code')`）；普通新建文件与带内容的草稿不受影响。

### 8.1 追加：文件树内的「临时草稿」节点（2026-11-21，用户反馈后）

用户拿 JetBrains 截图指出「临时文件和控制台 → 临时文件」是**项目树里的一个节点**。据此复核，方案里那条事实有两处偏差：

1. **JetBrains 确实在树里显示草稿**——不是混在真实目录里，而是项目节点（以及「外部库」「扩展」）同级的一个固定节点。方案 §7.2 的对照表把「不进文件树」写成 JetBrains 的做法，读错了。
2. **`.cadt` 在本应用的文件树里其实一直可见**。`explorer.js` 的 `LIST_SKIP_DIRS` 只被**列表引擎**（`explorer-list.js`）与文件系统通知过滤使用；树加载（`loadNode`）原样映射 `ReadDir` 结果，不过滤任何目录。方案 §0 第 2 条与 §4 据此得出的「树里看不见」是错的（此前只是没人展开 `.cadt` 所以没被发现）。

落地改动：

- **树根下新增固定节点「临时草稿」**（`explorer.js`：`scratchRoot` 选项 + `scratchNode`）。它不在 `tree.children` 里，由 `renderTree` 跟在工作区根之后追加；路径就是真实的 `<ws>/.cadt/scratch`，所以展开/读盘/打开文件全部复用既有节点逻辑。节点带 `root: true` 语义：不可拖拽、名字加粗（与工作区根同款视觉层级）。
- **右键只给四件事**：新建临时草稿 / 刷新 / 在文件管理器中显示 / 存储与清理…（`showExplorerMenu` 的 `info.scratch` 分支）。固定节点不是普通目录，不该出现「重命名 / 删除」——误删整个 scratch 目录会让已打开的草稿保存全部 ENOENT。
- **同一层隐藏 `.cadt`**（`filterTreeEntries`，只作用于工作区根这一层）：否则同一份草稿会在树里出现两次（`.cadt/scratch` 下一次、固定节点下一次）。其余 `.cadt` 内容各有界面（存储与清理 / 补丁库 / 便签 / AI 记忆），不需要在树里出现。
- **新建后展开 + 选中新草稿**（`refreshScratch({expand:true})` + `selectPath`）：比一句 flash 明确得多。空白草稿自动删除后同样刷一次节点（删除完成回调里，不等下一轮轮询）。
- **定时刷新与路径操作兼容**：`refreshTreeSilently` 把展开的草稿节点纳入；`flushExternalChanges` 与 `isNodeAttached` 认这个不在子树里的节点；`revealActive` / `revealPath` 命中草稿路径时改为展开固定节点（`revealPath` 也是「定位当前文件」与 `reveal_in_explorer` 的落点）。
- **补上方案 §4 的保存容错**：`saveDoc` 捕获到「路径不存在」且文档是草稿时，`AIEnsureDir(父目录)` 后静默重试一次。

quick-switch 的「临时草稿」层保留：树节点是主入口（看得到、能点），这一层对齐 JetBrains 的 `Show Scratch Files`，给键盘用户一个不占屏的快速切换。
