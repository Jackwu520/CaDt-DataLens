# 前端拆分第三阶段：目录归位 + 多域混装文件解耦

> 状态：**进行中**（2026-11-14 初版；同日二次评估增补 §0 目录约定与 4 个新候选，批次重排为「目录分组」）
> 实施记录（2026-11-14 22:10 起，四项决策全按推荐：11 目录 / 先 Z / 可选批次都纳入 / S2 拆两次）：
> - Z 目录归位 `3cb7ca0`：64 文件 git mv + 106 行 import 重写，顶层只剩 main.js；npm test 234/234、双构建通过
> - A1 `d71ee73`：ai-session-store 750 → 255（+ ai-session-disk 512）
> - R1 `4077cbf`：bridge-ui 632 → 203（+ terminal-view 212 / git 177 / cli-convert 77）
> - R2 `5541c35`：terminal-ui 853 → 414（+ run-ui 214 / terminal-sessions 268；顺带去掉返回面重复键）
> - H1 `a46977a`：titlebar-popovers 856 → 57（+ project 185 / git-branch 641）
> - S1 `6825aa7`：settings-ui 1105 → 759（+ dialogs 158 / select 119 / search 112）
> - 另：前端归位四条 misfit + AGENTS.md 按目录重写（`7813ad6`）；Go 侧评估与同包拆文件见 `go-layout.md`（patch/ai/app 三大文件已拆）
> 前置阅读：`docs/finished-plans/frontend-split-phase2.md`（两阶段实施记录与教训）、`.cadt/memory/frontend-module-refactor-audit.md`（验证方法论：tokenizer 重写、三类扫描、对照验证、退出码纪律）
> 范围：阶段 Z 目录归位 + 11 个「多域混装 / 内聚但体量逼近红线」文件的解耦；**不动** ai-panel.js（交子代理消息化方案）、main.js 组合根、editor-groups.js 编排核心
> 目标：把「未来拆分会很痛」的文件在低耦合期提前解耦（预防性拆分），不是追行数指标；同时终结 src/ 顶层平铺
> 原则：函数体逐字搬移（main.js 系需 deps 重写）；每批独立提交、独立验证、可单独 revert；0 新依赖

---

## 0. 先立目录，再谈拆分（2026-11-14 增补）

### 0.1 现状：src/ 顶层平铺 64 个文件

`frontend/src/` 只有三个域目录（`ai/` 27 个、`reading/` 7 个、`dev/` 1 个），**其余 58 个 `.js` 全部平铺在顶层**。本阶段初版要新增 10 个模块，二次评估后增至 25 个 —— 继续平铺会得到 83 个同级文件，「按文件名猜归属」彻底失效（`writing-ui.js` 里装着四个设置 pane，就是平铺化的典型症状）。

因此本阶段**先做一次纯机械归位（阶段 Z），再按目录分组拆分**。归位本身就是零逻辑改动的一次性动作，单独成批、单独 revert；拆分产生的所有新文件直接落进目标目录，不做二次搬运。

### 0.2 目标目录树

```
frontend/src/
├─ main.js                        组合根：唯一留在顶层的文件
├─ ai/                            AI 助手（既有 27 个 → +4 新拆分 + 2 迁入）
├─ reading/                       阅读模式（既有 7 个，本阶段不动）
├─ dev/                           dev mock（既有，动态 import，不动）
├─ core/                          零 DOM / 跨域共享的纯逻辑与服务
│    formats · markdown · diff · icons · fileicons · fileicons-os
│    jsonpath · jsonrepair · jsonschema · writing · activity-log
│    image-clipboard · plugins
├─ editor/                        编辑器内核
│    editor-groups · editor-ace-hooks · editor-csv-view · editor-split-preview
│    editor-sql-view · editor-browser-tab · editor-doc-extras · editor-export-menus
│    editor-menus · patch-view · find-bar · json-query · schema-panel
│    structure · structure-panel · structure-worker · format-convert
├─ explorer/                      资源管理器与工作区检索
│    explorer · explorer-ops · global-search · diff-dialog
├─ shell/                         窗口外壳与应用级动作
│    menu-bar · titlebar-popovers · mode-switch · palette · quick-switch
│    contextmenu · app-actions · app-links · update-check · properties-ui
│    cursor-themes · session-restore · image-lightbox · debugconsole · message-center
├─ settings/                      设置域（pane 渲染器天然属于这里）
│    settings-ui · activity-pane + settings-pane-*（本阶段从 writing-ui 拆出）
├─ writing/                       写作模式
│    writing-ui（壳） + writing-mode（本阶段从 writing-ui 拆出）
├─ bridge/                        进程桥 / 虚拟文档 / 浏览器标签 / git 浅集成
│    bridge-ui + bridge-*（本阶段拆出）
└─ terminal/                      终端、运行、调试控制台
     terminal-ui + terminal-sessions + run + run-ui（后三个本阶段拆出）
```

规模：顶层 `58 个 .js` → `1 个`（main.js）；11 个域目录，除 `ai/`（29）、`editor/`（17）、`shell/`（15）外每个 2–14 个文件。

**可选裁剪**：若嫌目录数偏多，`writing/`（仅 2 个文件）可并入 `editor/`，`core/` 可散回各域 —— 但 `settings/` 与 `bridge/`、`terminal/` 建议保留，它们各自对应一个已存在的 Wails 域职责。本方案按 11 目录写。

### 0.3 归位成本与纪律

- 需改写的 import：`main.js` 46 处、顶层文件互引 95 处、`ai/` 指向父目录 18 处、`reading/` 2 处 —— 合计约 160 行，全部是 `'./x.js'` → `'./<dir>/x.js'` 或 `'../x.js'` 的机械替换。
- 三个非纯路径的坑：
  1. `structure-panel.js:39` 用 `new URL('./structure-worker.js', import.meta.url)` 起 worker —— worker 必须与被移动的宿主**同目录**（两者都进 `editor/`，相对路径原样保留）。
  2. `frontend/package.json` 的 test script 是**硬编码路径列表**（23 个），其中 7 个顶层测试文件要逐条改；目录归位后 `npm test` 全绿才算过。
  3. `main.js` 第 1–3 行的 `import 'katex/dist/katex.min.css'` / `'./style.css'` / `'./reading.css'` —— css 与 index.html 不动，只改 js 路径。
- 用 `git mv` 保留 rename 识别（`git log --follow` 不断代）；提交信息 `refactor(frontend): 目录归位（零逻辑改动）`。
- **归位必须与拆分分开提交**：否则 revert 一个拆分批会把整个目录结构一起带走。
- **前置条件**：当前工作树有 12 个在途修改文件（`main.js`、`settings-ui.js`、`writing-ui.js`、`ai-*` 等）。归位会与这些改动正面相撞 —— **等作者提交后再执行 Z**，不要带着未提交改动做 160 行路径替换。

---

## 1. 现状锚点（按目录分类）

> 行数复核时点：**2026-11-14 22:10**（开工前）。相比 13:10 首测，当日大批功能提交使四个目标文件增长：`settings-ui` +154、`ai-settings-dialog` +68、`ai-takeover` +73、`writing-ui` +20，并新增顶层 `message-center.js`(261)。§1 的行数已按新值更新，**§4 批次表里的行号区间是旧锚点，动手前必须重新 grep**（见 §3 规则 7）。

### 1.1 `settings/` + `writing/`：设置域被劈成两半（本阶段最大发现）

| 文件 | 行数 | 混装内容 |
| --- | --- | --- |
| `src/settings-ui.js` | 1105 | 设置核心（主题/字体/缩进/只读锁/`applySettings` 403–521）+ **行式下拉增强（578–689）** + `selectSettingsPane`(690)/`openSettings`(753) + **设置搜索（789–893）** + 集成状态（894–950）+ 对话框族（522–568、951–1041）+ 字数统计（1042–1105） |
| `src/writing-ui.js` | 2943 | 写作模式 + 字数统计 + goto/命名对话框 + `LANG_DEFS` + **运行配置 pane** + **插件 pane/市场** + **环境变量 pane** + **格式/语言/工具链 pane** + 编码/视图/EOL 缩放弹出层 + markdown/mermaid 渲染管线 + 脏标记/自动保存/窗口标题 |

证据：`settings-ui.js:690` 的 `selectSettingsPane` 正是通过 deps 调用 `writing-ui` 的 `renderFormatPane` / `renderLangPane` / `renderPluginsPane` / `renderRunPane` / `renderEnvVarsPane` —— 设置页的 pane 宿主在 settings-ui，pane 渲染器却在 writing-ui，且 `writing-ui` 的返回面有 **50 个成员**被 `main.js` 整体解构。这是全仓库最严重的「名字与内容不符」，也是唯一一个 >2900 行却从未排进任何拆分阶段的文件（phase 2 只列了 editor-groups 与 main.js）。

### 1.2 `shell/`

| 文件 | 行数 | 混装内容 |
| --- | --- | --- |
| `src/titlebar-popovers.js` | 856 | 项目选择弹层（1–220）+ **Git 分支弹层（221–855，含克隆/推送/更新项目流程）** |
| `src/message-center.js` | 261 | 状态栏消息中心（本轮新增，单域内聚，本阶段只随目录归位搬进 `shell/`，不拆） |

### 1.3 `bridge/` + `terminal/`

| 文件 | 行数 | 混装内容 |
| --- | --- | --- |
| `src/bridge-ui.js` | 632 | 进程桥/虚拟文档 + 浏览器标签 + 后台终端视图 + git 浅集成 + CLI 转换 + **应用启动编排 IIFE** |
| `src/terminal-ui.js` | 853 | 侧栏视图/git 面板 + 终端面板/dock + **运行代码接线（274–566）** + **终端会话管理（567–853）** |

### 1.4 `ai/`

| 文件 | 行数 | 混装内容 |
| --- | --- | --- |
| `src/ai/ai-settings-dialog.js` | 2133 | 端侧分类器设置区（288–391）+ 权限 pane（392–513、项目级规则 669–820）+ 偏好 pane（514–668）+ 模型/账号 pane（998–1260）+ 配置导入导出（1261–1451）+ **单体事件绑定器 `bindSettingsPane`（1452–2080，约 630 行）** |
| `src/ai/ai-takeover.js` | 1066 | 纯函数 `classifyVerdictRows`(12–74) + 补丁卡（114–371）+ 审批卡（379–628）+ **ask 卡（629–928，含 plan 辅助）** + 计划卡（929–1022）+ 分发器（1023–1066） |
| `src/ai/ai-subagents.js` | 1055 | 子代理运行时（`runSubAgent`/`runSubRound`/`runSubToolRound`/`handleSubEvent`/`finalizeSubAgent`）+ **头部 HUD 与 chips 弹层（125–424）** + 子代理详情视图 + 后台命令桥 |
| `src/ai/ai-session-store.js` | 750 | 编解码纯函数（1–256）+ **磁盘适配（257–750）** |

### 1.5 `explorer/`

| 文件 | 行数 | 混装内容 |
| --- | --- | --- |
| `src/explorer.js` | 1352 | 树视图引擎（treeRow/appendTreeRows/loadNode/mergeChildren/refreshTree） + **扁平列表视图引擎（scanListEntries/loadList/listRow/renderList，613–772）** + 选择/剪贴状态 + 外部变更增量刷新 + 路径重写（remapPath/rewriteSubtree/pathRenamed） |

### 1.6 明确豁免（本阶段不动）

`structure.js`(1986)、`run.js`(1152)、`ai/ai-tool-defs.js`(606)、`ai/ai-constants.js`(842)、`ai/ai-local-classifier.js`(527)、`dev/mock-backend.js`(2292)、`editor-groups.js`(1521)、`ai/ai-panel.js`(11582)、`main.js`(4453)、`style.css`、`reading.css`、`index.html`、整个 `reading/` 域 —— 表驱动/常量/样式级联/窗口结构/组合根，拆分只会增加查找成本。

---

## 2. 候选评估与取舍（按目录）

判据（四条同时满足才入选本阶段）：**① 混装 ≥2 个可独立冒烟的子域；② 行数 ≥900 或单域已逼近 1000 行红线；③ 拆分后每块 <1000 行；④ 与其它批次不碰同一文件。**

| 目录 | 文件 | 行数 | 判定 | 理由 |
| --- | --- | --- | --- | --- |
| `writing/`+`settings/` | `writing-ui.js` | 2943 | **纳入（必做）** | 6 个子域、返回面 50 成员、设置 pane 与宿主分居两文件；>2900 行却从未被规划过 |
| `ai/` | `ai-settings-dialog.js` | 2133 | **纳入（建议）** | 4 个 pane + 630 行单体绑定器；与 ai-panel 的主对话框逻辑已剥离，边界清晰 |
| `shell/` | `titlebar-popovers.js` | 856 | 纳入（原 B4） | 两个弹层各自成域，几乎零共享状态（只共享定位工具） |
| `bridge/` | `bridge-ui.js` | 632 | 纳入（原 B1） | 4 个子域 + 启动编排 IIFE 混杂 |
| `terminal/` | `terminal-ui.js` | 853 | 纳入（原 B3） | 运行接线与终端会话管理互不相干 |
| `ai/` | `ai-takeover.js` | 1066 | 纳入（原 B6） | 三族卡片 + 分发器，卡渲染可独立 |
| `ai/` | `ai-session-store.js` | 750 | 纳入（原 B2） | 纯函数 / 磁盘适配一刀切，最无痛 |
| `ai/` | `ai-subagents.js` | 1055 | **纳入（可选）** | 头部 HUD（125–424，约 300 行）与子代理运行时无耦合，可剥；剩余 750 行内聚良好 |
| `explorer/` | `explorer.js` | 1352 | **纳入（可选）** | 树/列表两套渲染引擎 + 刷新引擎，列表视图（约 300 行）与树弱耦合，可剥 |
| `settings/` | `settings-ui.js` | 1105 | 纳入（原 B5） | 设置核心 + 行式下拉/搜索/对话框三族混装；**无分节注释**，需先跑依赖扫描 |
| `editor/` | `editor-csv-view.js` | 1012 | **暂缓** | phase 2 刚拆出（E2），二次拆分抖动收益比低 |
| `editor/` | `editor-split-preview.js` | 906 | **暂缓** | 同上（E3），且分屏状态机是全仓最纠缠处 |
| `ai/` | `ai-tool-cards.js` | 882 | **暂缓** | phase 2 刚拆出且有在途改动；未破 900 |
| `reading/` | `reading/reading.js` | 1498 | **暂缓** | 渲染管线/分页/滚动状态强耦合，纯函数层已分离到 reading-model；风险高于收益 |
| `editor/` | `structure.js` | 1986 | **豁免** | 17 语言解析表驱动，拆开只会让「加一种语言」变难 |
| 其余 | `ai/ai-session-list.js`(675)、`explorer-ops.js`(608)、`patch-view.js`(584)、`ai/ai-composer.js`(559)、`jsonpath.js`(664) | — | **不入选** | 单域内聚、未逼近红线 |

---

## 3. 通用拆分纪律（phase 2 教训全集，必须遵守）

1. **两种工厂模式的差异**：`bridge-ui` / `terminal-ui` / `titlebar-popovers` / `settings-ui` / `writing-ui` / `explorer` 是 `createXxx(deps)`，函数体已是 `deps.X` 引用 —— 纯搬移 + 兄弟模块共用同一 deps 对象（`Object.create` 委托）；`ai-*` 是 `createAIXxx(ctx)`，同名 ctx 模式。注意 `writing-ui.js` 是特例：函数定义在工厂闭包内但**共享一组模块级 `let`**（`writingLastSig` 等，且 `footPopover` 等 DOM 常量在模块顶层求值），拆分时状态必须随域迁入新工厂，禁止跨模块共享模块级变量。
2. **跨模块注入名必须重写**（E 批 46 处裸名的教训）：新模块若调用宿主内部函数，调用点一律改写为 `deps.X`；重写候选集 = **宿主全部 `\w+Deps\.(\w+) =` 箭头注入名**（不是「宿主顶层定义 ∩ 裸名」——跨模块转发名会漏）。
3. **转发层三件套**：宿主返回同名惰性转发箭头 `const X = (...a) => mod.X(...a)`；let 状态导出必须 getter（禁止值快照，见 phase 2 的 splitRoot 缺陷）；被模块回写的状态在宿主构造块提供 setter。
4. **每批固定验证序**：模块自洽扫描（未知标识符只剩关键字/对象键）→ deps 键一致性（模块内 `deps.X` ⊆ 构造块）→ return 键 vs 调用方 → `npm test` → `npm run build` → `wails build -devtools` → 定向冒烟。**构建/测试命令不许接 grep/tail 管道核对退出码**（M3 带病提交的教训）。
5. **块尾发现只允许从已知函数名前向扫描收尾 `}`**；`git checkout` 恢复后先统一 `\n`（CRLF 陷阱）。
6. **命名先 grep 防撞**（phase 2 的 createStructurePanel 教训）；工厂改名要同步构造行/import/转发模板三处。
7. **行号一律以 grep 重定位为准**：§4 的区间是 13:10 首测锚点，22:10 复核时四个文件已因功能提交漂移（`settings-ui` 1105、`ai-settings-dialog` 2133、`ai-takeover` 1066、`writing-ui` 2943），动手前重跑 `wc -l` + grep 定位每个函数的首尾。
8. **开工前查工作树洁净度**：目标文件若有未提交改动，先等落地（2026-11-14 22:10 复核时工作树已清空，仅剩 `datalens.exe.running-old` 构建残留）。

---

## 4. 批次（按目录分组，先归位后拆分）

执行顺序建议：**Z → A1（ai-session-store，最无痛）→ R1/R2/H1 → S1/S2 → A2/A3/A4 → X1**。每批独立提交、独立 revert。

### 阶段 Z：目录归位（`refactor(frontend): 目录归位（零逻辑改动）`）

见 §0.3。一次性提交，验证只有三项：`npm test` 全绿、`npm run build` 通过、冷启动冒烟（工作区恢复/开标签/设置页/浏览器标签/AI 面板各点一次）。**零逻辑改动是硬要求**：只允许出现 import 路径行、`package.json` test 列表、`git mv` 的文件位置变化。

### 4.1 组 `bridge/` + `terminal/`

#### R1 `bridge/bridge-ui.js`（632 → 约 210，原 B1）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `bridge/bridge-terminal-view.js` | 后台终端标签页视图（`bgTermSplitRatio`～`renderBgTermTabTitle`，77–281）、`openBgTermTab` | ~205 |
| `bridge/bridge-git.js` | git 浅集成（`gitRootDir`～`gitRollbackPaths`，282–450，含 `gitStateCache` let） | ~170 |
| `bridge/bridge-cli-convert.js` | CLI 转换模式（`convertTargetDriver`/`maybeRunConvertJob`，452–约 500） | ~50 |

留守：`openVirtualDoc` / `openBrowserTab` + **应用启动编排 IIFE（约 505–628，绝不动）** + 转发/返回面。
注意：`gitStateCache` 是 main.js 与会话恢复共用的 let —— 新模块持有它，桥壳返回 `get gitStateCache()` 活引用，main.js 的 deps getter 零改动。返回面 13 个成员在桥壳补同名转发。
冒烟：浏览器标签打开/导航、AI 后台终端作业视图渲染与停止、标题栏 git 分行与 diff、`--convert` CLI 路径、**冷启动全流程**。

#### R2 `terminal/terminal-ui.js`（853 → 约 277，原 B3）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `terminal/run-ui.js` | 运行代码（F5）接线：`activeDocText`～`runArgsText`/`setRunArgs` 等（274–566） | ~290 |
| `terminal/terminal-sessions.js` | 终端会话管理与菜单：`activateTermSession`～`renameTermSession`（567–853） | ~286 |

留守：侧栏视图切换 + git 面板 + 终端面板/dock（1–273）。顺带修复返回面 `renderGitPanel` 重复键。
冒烟：F5 运行（语言配方/stdin/项目确认/运行按钮状态）、终端面板开合与 dock 切换、多终端标签新建/关闭/重命名、侧栏 git 面板刷新。

### 4.2 组 `shell/`

#### H1 `shell/titlebar-popovers.js`（856 → 约 50，原 B4）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `shell/titlebar-project.js` | 项目选择弹层 + 克隆流程（1–220） | ~220 |
| `shell/titlebar-git-branch.js` | Git 分支弹层（221–855） | ~635 |

留守：`isToolbarPopOpen`/`positionToolbarPopover`（定位工具）+ 转发/返回面（7 个成员）。
冒烟：项目弹层（切换/新建/克隆仓库）、Git 分支弹层（列表/搜索/切换/新建/推送/更新项目）。

### 4.3 组 `settings/` + `writing/`

#### S1 `settings/settings-ui.js`（1105 → 约 750，原 B5）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `settings/settings-dialogs.js` | 对话框族：`openDialogEl`/`closeTopDialog`/`closeDialogs`（522–568）+ 关于/保存冲突/命名对话框（`openAbout` 951–1041） | ~140 |
| `settings/settings-select.js` | 行式下拉增强（`setSelectCloseAll`/`setSelectRender`/`enhanceSetSelects`，578–689）—— 把原生 select 换成行式面板，含 MutationObserver 重建 | ~112 |
| `settings/settings-search.js` | 设置搜索（`buildSettingsSearchIndex`/`renderSettingsSearch`/`resetSettingsSearch`，789–893） | ~105 |

留守（约 750）：设置核心（字体下拉 125–202、主题 218–245、代码换行/参考线、置顶/全屏、只读锁 320–396、`applySettings` 403–521）、`selectSettingsPane`(690)/`openSettings`(753)、集成状态（894–950）、字数统计（1042–1105）。
**该文件没有分节注释** —— 面板序号已在 §1.1 按函数名给出，动手前先跑 deps 扫描确认三族与核心的交叉引用（`selectSettingsPane`/`openSettings` 与对话框族的交互是唯一风险点）。
冒烟：设置各 pane 打开/保存、设置搜索跳转、行式下拉（字体/模型/模板三类动态 options）、只读锁、关于、保存冲突对话框、命名对话框（新建/重命名）。

#### S2 `writing/writing-ui.js`（2943 → 约 120，新增，**最大的一批，拆两次提交**）

**S2a：写作模式与渲染管线**（→ 约 1300）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `writing/writing-mode.js` | 写作模式核心（`writingActive`～`writingFocusParagraph`，24–236）+ 字数统计/写作统计对话框/目标（237–332）+ 写作格式/名称/插入（339–420）+ 光标位置与 goto 对话框（421–618，含 `openCloseConfirm`） | ~595 |
| `editor/foot-menus.js` | 编码/视图/EOL 弹出层（`makeSelect` 1984、`footPopover` 1997、`openFootPopover` 2258–2313 全段）+ 其依赖的显示常量（1708–1868，编码表/视图表/`TEXT_MODE_NAMES`/`editorLocale`） | ~490 |
| `editor/markdown-mermaid.js` | 共享 markdown 渲染器构造（1871–1879）+ mermaid 占位/脚本注入/主题/块渲染（1880–1951）+ 图片解析（1952–1978） | ~107 |

**S2b：四个设置 pane**（→ 约 120 的壳）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `settings/settings-pane-run.js` | 运行配置 pane（`renderRunProfiles` 636～`renderRunPane` 862） | ~227 |
| `settings/settings-pane-plugins.js` | 插件 pane + 插件市场（`refreshPluginUI` 867～`marketDate` 1444：插件列表/错误/版本比较/市场 TTL 与列表/图表框） | ~578 |
| `settings/settings-pane-envvars.js` | 环境变量 pane（`ENVVAR_NAME_RULE` 1445～`setupEnvVarsSettings` 1707） | ~263 |
| `settings/settings-pane-lang.js` | 格式/语言/工具链 pane（`setupFormatSettings` 2314～`fmtSize` 2887） | ~574 |

留守（约 120）：`LANG_DEFS`(619–635) + 脏标记/自动保存/窗口标题（2888–2943） + **50 个成员的转发面**（`main.js` 整体解构，必须同名转发，调用方零改动）。
风险：pane 渲染器的宿主是 `settings-ui.js:690` 的 `selectSettingsPane` —— 新模块经壳转发被 settings-ui 调用，**不得反向 import settings-ui**。`writing-ui.js` 的模块级 `let` 与顶层 DOM 常量（`footPopover` 在 1997 行模块顶层 `getElementById`）必须随域迁入对应工厂，否则拆完就是隐式全局。
冒烟：写作模式开关（typewriter/焦点段落/字数/目标）、goto 与命名对话框、md 预览与 mermaid 出图、底部编码/EOL/视图/缩放弹出层、设置页 5 个 pane（run/plugins/market/envvars/fmt/lang）、插件安装与错误提示、自动保存与脏标记。

### 4.4 组 `ai/`

#### A1 `ai/ai-session-store.js`（750 → 350 留 250 + 新 493，原 B2）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `ai/ai-session-disk.js` | `createSessionDiskStore`（磁盘适配，257–750） | ~493 |

编解码/重放（1–256）与**全部现有测试零改动** —— 全阶段最无痛的一刀。`ai-panel.js:9` 的 import 拆成两行，全仓库仅此一处调用方。
冒烟：新建/切换会话、流式落盘、重启恢复、归档、回收站删除、跨进程写锁（两个窗口同会话）。

#### A2 `ai/ai-takeover.js`（1066 → 约 500，原 B6）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `ai/ai-patch-card.js` | 补丁审批卡：`requestPatchApproval`(114) + `renderPatchTakeover`(144–314) + `renderPatchApprovalBody`(315–371) | ~258 |
| `ai/ai-ask-cards.js` | 提问卡：`renderEnvAskTakeover`(629–691) + plan 辅助（692–722）+ `renderAskTakeover`(723–928) | ~300 |

留守（约 500）：纯函数 `classifyVerdictRows`(12–74) + 审批卡（379–628）+ 计划卡（929–1022）+ `updateComposerTakeover` 分发器（1023–1066）+ `el0`。**分发器留守**：卡模块化后分发器经转发调用，禁止把按 kind 分发逻辑拆走；`classifyVerdictRows` 有独立测试（`ai-takeover.test.mjs`），不得跨文件搬散。
冒烟：补丁审批卡（应用/部分应用/撤销/拒绝）、命令审批卡（含判定区结构化渲染：端侧引擎行 + AI 复核行）、计划审批卡、ask 提问（选项/自定义/取消/超时降级）、环境变量询问卡。

#### A3 `ai/ai-settings-dialog.js`（2133 → 约 950，新增）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `ai/ai-permission-settings.js` | 权限 pane：端侧分类器设置区（288–391）、审批规则渲染/删除（392–513）、项目级规则表与 `.cadt/permissions.json` 串行读写 + 审批记录（669–820） | ~580 |
| `ai/ai-preference-settings.js` | 偏好 pane（514–668）：偏好列表、编辑/新增、偏好文本提交 | ~155 |
| `ai/ai-model-settings.js` | 模型/账号 pane：模型列表、编辑器、条目 strip、字段写入口（998–1260） | ~263 |
| `ai/ai-settings-io.js` | 配置导入/导出（1261–1451） | ~190 |

留守（约 950）：`refreshSettingsPane`/`refreshChatSettings`/`refreshPromptSettings` 等分发器（821–997）+ **`bindSettingsPane` 单体绑定器（1452–2080，约 630 行）**。
风险点：绑定器是 630 行的单体事件绑定，与四个 pane 的渲染函数交叉引用 —— 绑定器留宿主，四模块只暴露 render/handler，经 `ctx` 惰性箭头互调；**不要试图按区块切绑定器**（比 phase 2 的 E3 更容易踩空）。宿主终态约 950 行，仍在 1000 红线内但接近，若绑定器继续膨胀需另立方案。
冒烟：设置页切 pane（模型/权限/偏好/提示词/记忆）、审批与项目级规则增删、分类器开关与测试框、偏好增删改、模型增删改与激活、配置导入导出。

#### A4 `ai/ai-subagents.js`（1055 → 约 750，可选）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `ai/ai-head-hud.js` | 头部 HUD：会话标题、智能体团队/后台终端 chips、chips 弹层渲染与定位、角标计数（125–424） | ~300 |

留守：子代理运行时四函数 + 详情视图 + 后台命令桥。
注意：HUD 与 `ai-tool-cards`、会话列表的运行中标记有回扫（`notifyBackgroundActivity`），改走 ctx 惰性转发。
冒烟：头部两个 chip 角标、chips 弹层（子代理/后台终端两个列表）、点后台终端打开内容区标签、会话列表运行中标记。

### 4.5 组 `explorer/`

#### X1 `explorer/explorer.js`（1352 → 约 1050，可选）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `explorer/explorer-list.js` | 扁平列表视图：`scanListEntries`（BFS 扫描含硬上限）、`loadList`、`listRow`、`renderList`、`refreshListSilently`（613–772 + 1002–1050） | ~300 |

留守：树视图引擎 + 选择/剪贴 + 外部变更增量刷新 + 路径重写（rename/delete 重映射是树与列表共用的，留宿主）。
注意：列表与树共享 `selection` 与 `setMode`/`setRoot`，切分时这两个入口留宿主并经 deps 注入。
冒烟：切树/列表模式、列表视图大目录扫描与截断提示、勾选与右键、重命名/删除后树与列表同步、外部改动自动刷新。

---

## 5. 预期终态（按目录）

| 目录 | 文件 | 现状 | 终态 |
| --- | --- | --- | --- |
| 顶层 | `main.js` | 4453 | 4453（组合根，不动） |
| `writing/` | `writing-ui.js` | 2943 | ~120（壳：常量 + 脏标记 + 50 成员转发） |
| `settings/` | `settings-ui.js` | 1105 | ~750（+ dialogs 140 / select 112 / search 105） |
| `settings/` | — | — | + settings-pane-run 227 / -plugins 578 / -envvars 263 / -lang 574 |
| `writing/` | — | — | + writing-mode 595 |
| `editor/` | — | — | + foot-menus 490 / markdown-mermaid 107 |
| `bridge/` | `bridge-ui.js` | 632 | ~210（+ terminal-view 205 / git 170 / cli-convert 50） |
| `terminal/` | `terminal-ui.js` | 853 | ~277（+ run-ui 290 / terminal-sessions 286） |
| `shell/` | `titlebar-popovers.js` | 856 | ~50（+ project 220 / git-branch 635；另迁入 message-center 261 不拆） |
| `ai/` | `ai-session-store.js` | 750 | ~257（+ ai-session-disk 493） |
| `ai/` | `ai-takeover.js` | 1066 | ~500（+ patch-card 258 / ask-cards 300） |
| `ai/` | `ai-settings-dialog.js` | 2133 | ~950（+ permission 580 / preference 155 / model 263 / io 190） |
| `ai/` | `ai-subagents.js` | 1055 | ~750（+ head-hud 300）〔可选〕 |
| `explorer/` | `explorer.js` | 1352 | ~1050（+ explorer-list 300）〔可选〕 |

新增**25 个模块**（必做 23 + 可选 2；阶段 Z 不产新文件），最大单块 635 行（`titlebar-git-branch`）；`src/` 顶层文件数 58 → 1；拆分后无文件超过 1000 行（`writing-ui` 2943 与 `ai-settings-dialog` 2133 两处历史遗留清零，后者宿主 950 已贴近红线）。
整体体量：必做批次从目标文件扣减约 **8,100 行**（writing-ui −2,823、ai-settings-dialog −1,183、titlebar −806、terminal −576、takeover −566、session-store −493、bridge −422、settings-ui −355）。

---

## 6. 风险与回滚

- **Z 是全局风险最高的动作**（约 160 行路径替换 + 57 个文件 `git mv`）：必须零逻辑改动、单独提交、单独 revert。会同时改 `frontend/package.json`（test 路径）。
- **S2 是拆分风险最高的一批**：2943 行、6 个子域、50 成员返回面、模块级 let 与顶层 DOM 常量。拆两次提交（S2a/S2b），任一不过即 revert 该子批。
- **A3 的 `bindSettingsPane` 不可切**：630 行单体绑定器，切了就是 phase 2 的 E4 误吞重演。绑定器留宿主、pane 只出 render/handler。
- **R1 的启动编排 IIFE 是全场最高风险**：任何搬移不得触碰该段；冒烟必须含冷启动（工作区恢复、启动会话、启动设置、更新检查）。
- **B5/S1 依赖清单先行**：settings-ui 无分节注释，先跑 deps 扫描再动手；单批可 revert。
- **分发器留守原则**：`updateComposerTakeover`（A2）、`selectSettingsPane`（S1）、`setMode`/`showXView`（既有的视图族）—— 按 kind 分发的那一层永远留在宿主。
- 每批独立提交 `refactor(frontend): 拆出 <域>`，任一批冒烟不过即 revert 单批。
- 豁免清单见 §1.6。

---

## 7. 收尾

每批验证后：`docs/finished-plans/` 归档本方案、`AGENTS.md` 目录清单按新目录树重写（现有清单是按文件平铺列的，需要重排为按目录分组）、`CHANGELOG` 记录、`.cadt/memory` 补新教训（尤其 Z 的路径重写清单、S2 的写作模式状态迁移、A3 的绑定器边界）。

---

## 8. 待作者拍板

1. **目录树是否按 §0.2 的 11 个目录**，还是裁剪（`writing/` 并入 `editor/`、`core/` 散去）？
2. **Z 是否本阶段做**（一次性 160 行路径 diff），还是留到拆分结束后单独做？
3. **可选批次 A4（ai-subagents HUD）、X1（explorer 列表视图）是否纳入**？纳入则本阶段共 12 批。
4. **S2 是否拆分两次提交**（S2a 写作模式/渲染、S2b 四个设置 pane），还是一批到底？
