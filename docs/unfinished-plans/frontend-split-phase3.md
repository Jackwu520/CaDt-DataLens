# 前端拆分第三阶段：多域混装文件解耦（bridge-ui → session-store → terminal/titlebar → settings → takeover）

> 状态：未开工（2026-11-14 调研成文，作者拍板拆分顺序）
> 前置阅读：`docs/finished-plans/frontend-split-phase2.md`（两阶段实施记录与教训）、`.cadt/memory/frontend-module-refactor-audit.md`（验证方法论：tokenizer 重写、三类扫描、对照验证、退出码纪律）
> 范围：6 个「多域混装 / 内聚但体量逼近红线」文件的解耦；**不动** ai-panel.js（交子代理消息化方案）、main.js 组合根、editor-groups.js 编排核心
> 目标：把「未来拆分会很痛」的文件在低耦合期提前解耦（预防性拆分），不是追行数指标
> 原则：函数体逐字搬移（main.js 系需 deps 重写）；每批独立提交、独立验证、可单独 revert；0 新依赖

## 1. 现状锚点（2026-11-14 实测行数）

| 文件 | 行数 | 混装内容 |
| --- | --- | --- |
| `src/bridge-ui.js` | 632 | 进程桥/虚拟文档 + 浏览器标签 + 后台终端视图 + git 浅集成 + CLI 转换 + **应用启动编排 IIFE** |
| `src/ai/ai-session-store.js` | 750 | 编解码纯函数（1–256）+ **磁盘适配（257–750）** |
| `src/terminal-ui.js` | 853 | 侧栏视图/git 面板 + 终端面板/dock + **运行代码接线（274–566）** + **终端会话管理（567–853）** |
| `src/titlebar-popovers.js` | 856 | 项目选择弹层（1–220）+ **Git 分支弹层（221–855）** |
| `src/settings-ui.js` | 949 | 设置核心（1–511）+ **对话框族（512–568、795–885）** + 集成状态 + 字数统计（886–949） |
| `src/ai/ai-takeover.js` | 989 | 接管卡三族：补丁卡（47–304）+ 审批/计划卡 + **ask 卡（554–851）** + 分发器 |

## 2. 通用拆分纪律（phase 2 教训全集，必须遵守）

1. **main.js 系与 ai 系的模式差异**：bridge-ui / terminal-ui / titlebar / settings-ui 是 `createXxx(deps)` 工厂，函数体已是 `deps.X` 引用——纯搬移 + 兄弟模块共用同一 deps 对象（Object.create 委托）；ai-takeover 是 `createAITakeover(ctx)`，同名 ctx 模式。
2. **跨模块注入名必须重写**（E 批 46 处裸名的教训）：新模块若调用宿主内部函数，调用点一律改写为 `deps.X`；重写候选集 = **宿主全部 `\w+Deps\.(\w+) =` 箭头注入名**（不是「宿主顶层定义 ∩ 裸名」——跨模块转发名会漏）。
3. **转发层三件套**：宿主返回同名惰性转发箭头 `const X = (...a) => mod.X(...a)`；let 状态导出必须 getter（禁止值快照，见 phase 2 的 splitRoot 缺陷）；被模块回写的状态在宿主构造块提供 setter。
4. **每批固定验证序**：模块自洽扫描（未知标识符只剩关键字/对象键）→ deps 键一致性（模块内 `deps.X` ⊆ 构造块）→ return 键 vs 调用方 → `npm test` → `npm run build` → `wails build -devtools` → 定向冒烟。**构建/测试命令不许接 grep/tail 管道核对退出码**（M3 带病提交的教训）。
5. **块尾发现只允许从已知函数名前向扫描收尾 `}`**；`git checkout` 恢复后先统一 `\n`（CRLF 陷阱）。
6. **命名先 grep 防撞**（phase 2 的 createStructurePanel 教训）；工厂改名要同步构造行/import/转发模板三处。

## 3. 批次

### B1 `bridge-ui.js`（632 → 约 210）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `bridge-terminal-view.js` | 后台终端标签页视图（`bgTermSplitRatio`～`renderBgTermTabTitle`，77–281）、`openBgTermTab` | ~205 |
| `bridge-git.js` | git 浅集成（`gitRootDir`～`gitRollbackPaths`，282–450，含 `gitStateCache` let） | ~170 |
| `bridge-cli-convert.js` | CLI 转换模式（`convertTargetDriver`/`maybeRunConvertJob`，452–约 500） | ~50 |

留守：`openVirtualDoc` / `openBrowserTab`（小域）+ **应用启动编排 IIFE（约 505–628，绝不动）** + 转发/返回面。
注意：`gitStateCache` 是 main.js 与会话恢复共用的 let——新模块持有它，桥壳返回 `get gitStateCache()` 活引用，main.js 的 deps getter 零改动。返回面 13 个成员（createBgTermView/gitRootDir/notifyAIGitEntry…）在桥壳补同名转发。
冒烟：浏览器标签打开/导航、AI 后台终端作业视图渲染与停止、标题栏 git 分行与 diff、`--convert` CLI 路径、**冷启动全流程**（启动编排回归）。

### B2 `ai/ai-session-store.js`（750 → 350 留 250 + 新 493）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `ai/ai-session-disk.js` | `createSessionDiskStore`（磁盘适配，257–750） | ~493 |

编解码/重放（1–256）与**全部现有测试零改动**——本次拆分最无痛的一刀。`ai-panel.js:9` 的 import 拆成两行（`replaySessionLog` 留原模块、`createSessionDiskStore` 改新模块），全仓库仅此一处调用方。
冒烟：新建/切换会话、流式落盘、重启恢复、归档、回收站删除、跨进程写锁（两个窗口同会话）。

### B3 `terminal-ui.js`（853 → 约 277）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `run-ui.js` | 运行代码（F5）接线：`activeDocText`～`runArgsText`/`setRunArgs` 等（274–566） | ~290 |
| `terminal-sessions.js` | 终端会话管理与菜单：`activateTermSession`～`renameTermSession`（567–853） | ~286 |

留守：侧栏视图切换 + git 面板（`renderGitPanel` 等）+ 终端面板/dock（1–273）。顺带修复返回面 `renderGitPanel` 重复键（852 行对象字面量里出现两次）。
冒烟：F5 运行（语言配方/stdin/项目确认/运行按钮状态）、终端面板开合与 dock 切换、多终端标签新建/关闭/重命名、侧栏 git 面板刷新。

### B4 `titlebar-popovers.js`（856 → 约 50）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `titlebar-project.js` | 项目选择弹层 + 克隆流程（1–220） | ~220 |
| `titlebar-git-branch.js` | Git 分支弹层（221–855） | ~635 |

留守：`isToolbarPopOpen`/`positionToolbarPopover`（定位工具）+ 转发/返回面（7 个成员）。
冒烟：项目弹层（切换/新建/克隆仓库）、Git 分支弹层（列表/搜索/切换/新建/推送/更新项目）。

### B5 `settings-ui.js`（949 → 约 600）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `settings-dialogs.js` | 对话框族：`openDialogEl`/`closeTopDialog`/`closeDialogs`（512–568）+ `openAbout`/保存冲突（795–829）+ 命名对话框（829–885） | ~350 |

留守：设置核心（主题/字体/缩进/只读锁/applySettings）、设置搜索、集成状态、字数统计。该文件**没有分节注释**——动手前先列「对话框族 ↔ 设置核心」的依赖清单（`selectSettingsPane`/`openSettings` 与对话框族的交互是唯一风险点）。
冒烟：设置各 pane 打开/保存、设置搜索跳转、只读锁、关于、保存冲突对话框、命名对话框（新建/重命名）。

### B6 `ai/ai-takeover.js`（989 → 约 460）

| 新模块 | 搬移内容 | ≈行 |
| --- | --- | --- |
| `ai/ai-patch-card.js` | 补丁审批卡：`requestPatchApproval` + `renderPatchTakeover`（47–304） | ~260 |
| `ai/ai-ask-cards.js` | 提问卡：`renderEnvAskTakeover` + `renderAskTakeover`（554–851） | ~270 |

留守：命令审批卡 + 计划审批 + `updateComposerTakeover` 分发器 + `el0` 等工具。
冒烟：补丁审批卡（应用/部分应用/撤销/拒绝）、命令审批卡、计划审批卡、ask 提问（选项/自定义/取消/超时降级）、环境变量询问卡。

## 4. 预期终态

| 文件 | 现状 | 终态 |
| --- | --- | --- |
| bridge-ui.js | 632 | ~210 |
| ai-session-store.js | 750 | ~257（+ ai-session-disk 493） |
| terminal-ui.js | 853 | ~277（+ run-ui 290 + terminal-sessions 286） |
| titlebar-popovers.js | 856 | ~50（+ titlebar-project 220 + titlebar-git-branch 635） |
| settings-ui.js | 949 | ~600（+ settings-dialogs 350） |
| ai-takeover.js | 989 | ~460（+ ai-patch-card 260 + ai-ask-cards 270） |

新增 10 个模块，全部 <1000 行；无文件超过 phase 2 后基线。

## 5. 风险与回滚

- **B1 的启动编排 IIFE 是全场最高风险**：任何搬移不得触碰该段；冒烟必须含冷启动（工作区恢复、启动会话、启动设置、更新检查）。
- **B5 依赖清单先行**：settings-ui 无分节注释，先跑 deps 扫描再动手；单批可 revert。
- **B6 分发器留守**：`updateComposerTakeover` 按 kind 分发到各卡渲染函数——卡模块化后分发器经转发调用，禁止把分发逻辑拆走。
- 每批独立提交 `refactor(frontend): 拆出 <域>`，任一批冒烟不过即 revert 单批。
- 豁免清单（本阶段不动）：`structure.js`、`run.js`、`ai/ai-tool-defs.js`、`ai/ai-constants.js`、`dev/mock-backend.js`、`style.css`、`reading.css`、`index.html`——表驱动/常量/样式级联/窗口结构，拆分只会增加查找成本。

## 6. 收尾

每批验证后：`docs/finished-plans/` 归档本方案、AGENTS.md 目录清单补新模块、CHANGELOG 记录、`.cadt/memory` 补新教训（尤其 B1/B5 的实际依赖图）。
