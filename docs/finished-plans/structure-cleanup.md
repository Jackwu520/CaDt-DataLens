# 仓库结构治理（杂物清理 + 前端模块化）实施计划

> 状态：**全部实施完成（阶段 0–3 + 阶段 3a）**（2026-11-14 归档）
> 实施记录：
> - 阶段 0（仓库卫生）：完成（提交 `33f441c`）——.gitignore 补 `*.exe~` 与 `/nul`，清掉根目录残留旧 exe
> - 阶段 1（ai-* 归目录）：完成（提交 `7248a86`）——8 模块 + 7 测试迁入 `src/ai/`；session-outline.js 经核实被 structure.js 引用，留在 src 根（与本文档假设不同）；顺带补入了从未执行的 ai-permissions 测试
> - 阶段 2（main.js 拆分）：完成（提交 `e00d77a`）——21,188 → 7,447 行（-65%），22 个域模块，factory + deps 延迟求值；本文档原定锚点已全部失效，实际按域边界重新切分；15672–19560 无注释区全部拆出
> - 阶段 3（ai-panel.js 拆分）：**完成**（提交 `23f730c` + `96be9f1`/`952de6f`/`07c1d97`/`976209e`/`9ce0513` 五批）——常量先行拆出后，闭包内 17 个兄弟模块分 5 批抽完；18,023 → 11,040 行（-39%）。重启依据：2026-11-13 多会话并发整写丢失近 1k 行代码（未进提交历史，靠快照救回），拆分从「导航性收益」升级为「数据安全」需求。抽取模式：factory + ctx 注入（重赋值 let 经 getter/setter 访问器，互引模块经惰性转发箭头解环），函数体逐字搬移；每批独立提交 + 三类静态扫描（ctx 键一致性 / return 键 / 裸引用与反向悬空）+ npm test + 构建。扫描共捕获 15 处真实缺陷（含删除段误伤的 toolMeta/acceptPlan、updateCtxBanner 迁移未导出、aiThinkKey 等 9 个漏传 ctx 键），全部为「构建不报、运行才炸」类；另修复 sessionHasLiveBgJob 重复定义
> - 阶段 3a（write_file 陈旧缓冲防护，并发丢码根因）：完成（提交 `5468052`）——见 §10
> - §5 Go 拆包：维持暂缓
> 范围：阶段 0–3a（仓库卫生、`ai-*` 归目录、`main.js` / `ai-panel.js` 拆分、AI 写路径防护）；Go 拆包明确暂缓（§5）
> 版本号：不变更（结构与卫生；写防护记 CHANGELOG）
> 决策依据：2026-11-13 对外部结构批评的评估结论——临时文件混入成立立刻修；Go 扁平是已记录的取舍暂缓；前端主要矛盾是两个万行单体而非 36 个文件平铺；2026-11-13 并发写丢码事故推翻阶段 3 的「风险/收益比不佳」搁置结论

## 1. 背景

外部批评两点：根目录过载（Go 文件 + 临时/二进制文件混放）、`frontend/src` 平铺。实测核对：

- 根目录 111 个 `.go`（约 70 源 + 40 测试，2.56 万行）；`datalens.exe` 已被 gitignore；真正未清理的是 `nul` 与 `autoapprove-probe.md`（均 untracked）。
- `frontend/src` 36 个平铺文件共 4.29 万行，其中 `main.js` 19,633 行 + `ai-panel.js` 14,895 行占 80%。其余文件最大仅 1,898 行，平铺本身不构成主要问题。
- 批评建议的 `src/tests/` 集中测试**不采纳**：`.test.mjs` 与源码同目录是本仓库既有实践，移走只增加 import 路径长度、改名时测试失联。

## 2. 目标与非目标

### 目标

- 阶段 0：清掉 `nul`、`autoapprove-probe.md`，补 `.gitignore` 防复发。
- 阶段 1：`ai-*` 前端文件（8 源 + 7 测试）归入 `src/ai/`，沿用 `reading/` 先例。
- 阶段 2：`main.js` 按域分 7 批抽出，保留组合根职责。
- 阶段 3：`ai-panel.js` 抽出可独立演进的子模块。
- 全程 0 新依赖、不改任何运行时行为、每批可独立提交与回滚。

### 非目标（明确不做）

- 不做 Go 根目录拆包（暂缓理由见 §5）。
- 不建 `src/tests/`、`src/lib/`、`src/features/` 等空目录层；不引入框架/状态库。
- 不改打包方式（仍 Vite 单入口），不动 `frontend/wailsjs/` 与 `frontend/dist/`。
- 不追求把 `main.js` 拆到 0 行：前 3,435 行核心枢纽（标签页、编辑器、菜单、设置骨架、CSV 表格、Markdown 预览）保留在 `main.js`。

## 3. 阶段 0：杂物清理（约 10 分钟）

| 项 | 动作 |
| --- | --- |
| `nul` | Windows 保留设备名误产物（untracked），普通 `del nul` 删不掉；用 `cmd //c del "\\?\D:\OraSkyC\Project\CandySweet\CaDt-DataLens\nul"` |
| `autoapprove-probe.md` | 一次性复测记录（untracked，内容为自动审批第 2 轮结果），直接删除；如作者想留档自行移入 `docs/` |
| `.gitignore` | 追加 `/nul` 与 `/*.exe~`（现仅有 `/datalens.exe~`，防 `CaDt-DataLens-dev.exe~` 类产物复发） |
| 根目录 `datalens.exe` | 已被 gitignore 的本地构建/自更新产物，**保持现状不动** |

验证：`git status` 无上述 untracked 项；资源管理器根目录无残留。

## 4. 阶段 1：`ai-*` 归入 `src/ai/`

### 移动清单（`git mv` 保留历史）

- 源 8：`ai-panel.js`、`ai-session-store.js`、`ai-command-rules.js`、`ai-git.js`、`ai-app-message.js`、`ai-tool-args.js`、`ai-permissions.js`、`ai-config-model.js`
- 测试 7：对应 `.test.mjs`（`ai-panel.js` 无独立测试）
- 全部移至 `frontend/src/ai/`，测试继续与源码同目录。

### 引用更新点

1. `frontend/package.json` test script：`src/ai-xxx` → `src/ai/ai-xxx`（10 个路径）。
2. `main.js:15`：`'./ai-panel.js'` → `'./ai/ai-panel.js'`。
3. `src/ai/*` 内部对共享模块的引用加 `../` 前缀（已定位：`icons.js`、`contextmenu.js`、`image-clipboard.js`、`image-lightbox.js`、`fileicons.js`；以移动后 `npm run build` 报错为准全量修齐）。
4. `ai-*` 之间的相对引用同目录平移，不变。
5. `writing.js:2` 注释提到 `ai-command-rules.test.mjs`，仅注释，顺手同步路径。

### 已确认无影响面

- `plugins/` 样例不 import 任何 `src/` 路径（已验证 scene-carousel）。
- `index.html` 不直接引用 `ai-*` 文件；`frontend/wailsjs/` 与此无关。

### 验证

`cd frontend && npm test`（node --test 全绿）→ `npm run build` → `wails build -devtools` 冒烟 AI 面板（新建会话、发一轮消息）。

## 5. 暂缓项：Go 根目录拆包（记录不做的理由）

- 扁平根包是 AGENTS.md 记录在案的设计；文件按前缀分组（`ai_*`、`browser_*`、`reading_*`、`session*`），`*_windows.go`/`*_other.go` 成对平铺，AGENTS.md 已充当目录地图。
- 几乎全部逻辑挂在 `*App` 方法上，Wails 绑定自 App 结构体生成；拆包需 facade 化重构约 70 个源文件，收益仅为导航性，成本/风险不成比例。
- 触发条件（满足其一时重启本节）：单包超过 4 万行；或某域（如 sessionstore/activity）需要被独立复用。届时叶子优先：`sessionstore*` → `internal/sessionstore`、`activity*` → `internal/activity`、`pathinfo`、`logging`。

## 6. 阶段 2：拆 `main.js`（主线）

### 现状锚点

- 19,633 行、699 个顶层定义、约 175 个模块级状态变量、11 处 `// =====` 分节注释。
- 仓库已有成熟抽取模式：factory + 依赖注入（`createExplorer` / `createPalette` / `createAIPanel` / `createReadingMode`），新模块照此办理，不引入全局单例。

### 批次（由小到大、由低耦合到高耦合，每批独立提交）

| 批 | 行段锚点 | 内容 | 目标文件 | 规模 |
| --- | --- | --- | --- | --- |
| B6 | 18429–18601 | Win11/系统光标候选 | `cursor-themes.js` | ~170 行 |
| B8 | 19220–19633 | 进程桥/虚拟文档、浏览器标签页、git 浅集成 | `bridge-ui.js`（或按 3 域拆小） | ~415 行 |
| B7 | 18602–19219 | 内置终端 | `terminal-ui.js` | ~620 行 |
| B1 | 3436–4320 | 操作留痕 UI（设置页 + 事件桥） | 并入现有 `activity-log.js` 或新建 `activity-ui.js` | ~890 行 |
| B4 | 12776–14625 | 标题栏弹层：项目选择 + Git 分支 | `titlebar-popovers.js` | ~1,850 行 |
| B2 | 4321–6930 | 写作模式 UI | `writing-ui.js`（排版纯逻辑已在 `writing.js`） | ~2,610 行 |
| B3 | 6931–12775 | 编辑器分栏（编辑器组 + 二叉分割树） | `editor-groups.js` | ~5,845 行，最大，最后做 |

行段以实施时实际 grep 为准；分节注释之间的隐式段落（设置对话框、CSV 表格、Markdown 预览，位于 0–3435 与 14626–18428 区间内）本阶段不动，留作后续独立批次，避免单批过大。

### 约束

- 每批：纯移动 + 改 import + 显式注入依赖（DOM 引用、状态 getter/setter 经 ctx 对象传入），函数体不改写。
- 模块级状态（~175 个）是主要风险：被抽域涉及的状态随域走或经 ctx 注入；禁止新增全局、禁止循环 import。B3 与核心标签页状态交叠最深，放最后，动手前先产出状态归属清单。
- 提交信息统一 `refactor(frontend): 拆出 <域>`，便于单批 revert。

### 验证（每批必做）

`npm test` → `npm run build` → `wails build -devtools` → 定向冒烟（如 B7 开内置终端执行一条命令；B3 双栏分割/拖拽/合并）+ 通用冒烟（开 3 种格式标签、切主题、设置保存）。

## 7. 阶段 3：拆 `ai-panel.js`（已完成，实际实施与原计划差异见下）

- 原 14,895 行（起步时实测 18,793 行），顶层仅 20 个定义，约 500 个函数全部在 `createAIPanel` 闭包内。
- 实施结果：常量与纯辅助函数拆出（`23f730c`）后，闭包内按域抽成 17 个兄弟模块，五批提交（`96be9f1` 纯数据与小 UI 族 7 模块 / `952de6f` 会话列表+输入区 / `07c1d97` 工具卡+接管区 / `976209e` 对话框族 / `9ce0513` 子代理域）；`ai-panel.js` 18,023 → 11,040 行（-39%）。留守核心：`executeTool`（934 行）、回合流程、会话持久化、config、消息渲染、三形态、init——探索确认的最高纠缠三件套不动闭包骨架。
- 抽取模式（新先例）：`createAI<域>(ctx)` 工厂；引用稳定的依赖（opts 常量、const Map/Set、提升函数）解构注入；重赋值 `let` 经 getter/setter 访问器；模块间互引经惰性转发箭头解环；函数体逐字搬移，仅状态引用改写。域私有状态（搜索状态、分组展开、attachment 计数器、设置编辑器状态、AI_SUB_* 常量）随域迁移。
- 验证每批固定五步：三类静态扫描（ctx 键一致性 / return 键 vs 调用方 / 裸引用+反向悬空，脚本 `.cadt/tmp-*.mjs` 用完即删）→ `npm test` → `npm run build` → `wails build -devtools -s` → 通用冒烟。扫描共捕获 15 处真实缺陷（见 §7 实施记录），方法论沉淀在 `.cadt/memory/frontend-module-refactor-audit.md`。
- 教训：按行号区间删除前，必须先枚举区间内全部顶层声明并逐一对账（`toolMeta`/`acceptPlan` 曾被工具卡提取段误伤，靠反向悬空扫描救回）。

## 8. 文档同步（已完成）

- AGENTS.md「目录结构」节：阶段 1/2/3 新模块清单已同步。
- CHANGELOG.md 已记结构整理与 write_file 防护（对贡献者/插件作者可见）。
- 本方案移入 `docs/finished-plans/`。

## 9. 风险与回滚

- 每批独立提交，`git revert` 单批可回。
- 最大风险是运行时未定义变量（构建不报、运行才炸）：冒烟按批次域定向覆盖；抽取域时先 grep 该域函数对模块级状态的引用。
- 阶段 1 纯机械移动，风险最低，先行交付可立刻验证流程。

## 10. 阶段 3a：write_file 陈旧缓冲防护（已完成，提交 `5468052`）

背景：2026-11-13 多 AI 会话并发编辑时，ai-panel.js 被陈旧缓冲整体覆盖丢失近 1k 行（靠补丁快照与会话记录救回，未进提交历史）。根因定位：`write_file` 是「整文件覆盖」语义且无任何陈旧性校验（读盘只为算 diff 统计）；`edit_file`（执行时重读 + oldString 严格唯一匹配）与 `propose_patch`（两阶段严格匹配 + 应用前快照）天然安全。

机制（纯前端 + 现有 Go 绑定，零 Go 改动）：
- 新模块 `frontend/src/ai/ai-write-guard.js`：会话级读取指纹（`session._readStats`：path → {mtime, size, at}，mtime 来自 Go `OpenFile` 的 `FileData.Mtime`）；`recordRead`（read_file 成功后记）/ `checkWriteFresh`（write_file 覆盖已存在文件前校验）/ `recordWrite`（写成功后回写）。
- 硬拒绝策略（作者拍板）：本会话没读过的文件 → 拒绝；读过但磁盘 mtime 已变 → 拒绝并提示重读（拒绝消息附尺寸变化，建议局部修改改用 edit_file）。新文件不设闸门；内部流（memory_write 等）不经此闸门。
- 落盘竞态双保险：`applyWorkspaceWrite` 的 `SaveFile` 换成编辑器同款 `SaveFileChecked`（expectMtime），读取到落盘瞬间被外部修改则拒绝覆盖；成功后回写指纹（同会话后续写入免重读）。
- 工具描述、工具目录、`<workspace_rules>` 三处提示词同步写入守则。
- 9 项单测（ai-write-guard.test.mjs）；冒烟双流：正常 read→edit→write 无感知；读后外部改 → 拒绝 → 重读后写入成功。
