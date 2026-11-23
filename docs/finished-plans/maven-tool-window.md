# 内置 Maven 工具窗口（分期方案）

> 状态：**已实施**（V1 + V2 同日交付，2026-11-23。评估 → 复核拍板 → 实施全程记录在案）。
>
> 实施与方案的偏差（均在评审拍板方向上，实现时按实际代码形态收敛）：
> - **pom 结构解析放 Go**（方案 §4.2 原文说前端读 pom 取 `<modules>`）：前端没有通用文本读取
>   绑定，`PatchReadText` 语义不合且 dev mock 无法提供 pom——改由 `internal/mavenproject.ReadProject`
>   纯文件读取（artifactId / name / packaging / 限深 4 层模块树 / settings.xml 位置），
>   经 `MavenProjectInfo` 绑定下发。§9.5 的拍板（effective-pom 等解析在前端）不变。
> - **数据命令合并为单一绑定 `MavenData(workspaceRoot, mvnPath, timeoutMs, kind, moduleRelPath)`**
>   （kind：effective-pom / effective-settings / dependency-tree）——三个目标共用「-B + 临时文件输出」
>   通道，mock 只补一份；未采用方案 §6.6 的 MavenEffectivePom / MavenSettings 两绑定命名。
> - **模块树递归展开**：方案 §4.3 说 V1 只读一层 `<modules>`；实现直接做了限深递归（纯文件 stat，
>   零进程成本），子模块有自己的生存期与依赖项。
> - 触发判定 / 启动消毒 / AI 白名单刻意不动等拍板结论均已按 §9 落地；行号漂移按符号锚点处理。
>
> 目标形态：类 IntelliJ IDEA 的「Maven」工具窗口——侧边栏一个 Maven 图标，点开是一个面板，
> 树形展示当前 Maven 项目的生存期命令、子模块、依赖、插件、仓库；点节点直接执行对应命令，
> 输出复用应用已有的「运行」通道。
>
> 本文分两期：**V1** 交付「识别 + 生存期命令执行 + 多模块」的高频闭环；**V2** 补齐依赖树 / 插件 /
> 仓库浏览、配置文件快捷入口与执行开关。两期各自可独立交付、独立验证（实际同批交付）。
>
> 行号按 2026-11-23 工作区实测（方案期），实现时已按符号锚点定位。

---

## 1. 结论摘要

1. **可行，基础设施已覆盖约一半**。本机 Maven 探测（`internal/toolchain`）、命令执行通道
   （`internal/run` 的 `RunExec` + 流式输出 + 超时杀树）、侧边栏面板框架（活动栏 + sidebar + 视图切换）
   三块都已存在，可直接复用。真正新增的是 **pom.xml 项目识别**、**Maven 项目数据模型** 与 **侧边栏面板 UI**。
2. **前端为主、Go 侧小改**。V1 的 Go 侧只需给 `runproject` 的标记表加一个 `pom.xml` 分支（约 20 行）；
   V2 再加一个薄的 Go 绑定（只起命令返回原文）。其余都在前端。零新依赖（解析在前端做，见 §9.5）。
3. **数据获取策略是核心决策**：生存期命令用固定列表（不解析 pom）；子模块读 `<modules>`；
   依赖 / 插件 / 仓库**调 `mvn` 命令拿输出再解析**（`dependency:tree` / `help:effective-pom` /
   `help:evaluate`），不自造完整 Maven 模型——后者要处理 properties、parent 继承、profile、
   dependencyManagement，成本极高且永远追不上 Maven 的语义。
4. **执行必须复用现有运行通道**，不新开进程通道。只读模式、首次确认、并发上限、超时杀树、
   GBK 解码这些约束全部继承，不能绕过。
5. **分期建议**：V1（约 2–3 天）先交付高频闭环验证需求；V2（约 2–4 天）再补树浏览类能力。
   不建议一上来对标 IDEA 全功能。

---

## 2. 需求解读与目标形态

用户诉求（原话要点）：识别到仓库是 Maven 且本机扫描到 Maven 时，在左侧工具栏加一个 Maven 图标，
点开是如图所示的面板，可直接执行相关功能。

对照截图，目标面板包含：

- 顶部工具条：刷新、重新加载、下载源码、添加 / 移除、执行目标（运行任意 goal）、折叠、跳到源码、
  停止、设置等按钮。
- 树：
  - **配置文件**：pom.xml / settings.xml 快捷入口。
  - **<项目名>**（如 sky）：
    - **生存期**：clean / validate / compile / test / package / verify / install / site / deploy。
    - **插件**、**依赖项**：树形浏览。
    - **仓库**：local（本地仓库路径）、central、public 等，附 URL / 路径。
  - **子模块**（sky-admin / sky-common / …）：每个模块可展开出自己的生存期 / 依赖 / 插件。

V1 覆盖：图标 + 面板骨架 + 配置文件入口 + 生存期命令 + 多模块（每个模块可展开出生存期命令）+ 执行 / 停止。
V2 覆盖：依赖项 / 插件 / 仓库树、执行任意 goal、执行开关（离线 / 跳过测试 / 强制更新快照）、
跳到源码 / 配置文件编辑。

---

## 3. 现状（代码事实，2026-11-23 核对）

> 复核结论：本节事实逐条核对成立；`run.js` 的 `runProject`（`:1228`）**未导出**（控制器 return 只暴露
> 12 个方法），抽公开入口的必要性成立。行号漂移见文首说明。

### 3.1 Go 侧可复用基础

| 模块 | 现状 | 复用点 |
|---|---|---|
| `internal/toolchain/toolchain_windows.go` | Maven 探测**已实现**：`candidateExes` 的 `case "maven"` 返回 `mvn`（`:118`），`toolchainGlobs` 扫 `apache-maven*` 安装目录与 chocolatey（`:181`），`defaultVersionArgs` 默认 `--version`，`DetectToolchain`（`:373`）返回路径 + 版本 | 判断「本机有 Maven」直接查已有扫描缓存，无需新探测 |
| `internal/run/run.go` | `RunExec(id, exe, args, cwd, pathPrepend, timeoutMs)`（`:506`）：`exec.CommandContext` + `procctl.ApplyCancel` 杀进程树、stdout/stderr 流式 `run-out`、结束 `run-exit`、GBK 解码、PATH 前置、stdin 队列 | 所有 Maven 命令的执行通道，V1/V2 共用 |
| `internal/procctl/procctl.go` | `NormalizeArgs`（`:68`）校验 exe 非空、参数 ≤128；`WorkDir`（`:79`） | 执行前的参数校验 |
| `internal/runproject/runproject.go` | 项目感知探测：向上最多 8 层、`.git` 边界、主目录拦截；`runProjectMarkers`（`:38`）= package.json / go.mod / Cargo.toml / pyproject.toml / Makefile，**没有 pom.xml** | 「仓库是 Maven」识别的现成骨架，加一个 marker 分支即可 |

### 3.2 前端可复用基础

| 模块 | 现状 | 复用点 |
|---|---|---|
| `frontend/src/writing/writing-ui.js` | `LANG_DEFS`（`:28-39`）中 Java 一项（`:32`）已含 `{id:'maven', name:'Maven'}` 与 gradle 工具 | 工具链扫描结果落在 `settings.langEnv.java.tools.maven` |
| `frontend/src/settings/settings-pane-lang.js` | `langEnvFor` / `toolEnvFor` / `effectiveToolEnv`（`:65-112`）读写工具链缓存；`DetectToolchain` 调用在 `:361` | 取本机 Maven 路径 / 版本的单一来源 |
| `frontend/src/terminal/run.js` | 运行控制器 `createRunController`：配方表 `RECIPES`（含 bat/cmd 的 `cmd /c` 范式）、`resolveTool`（`:1359` 走 `ResolveRunShell`）、`execSteps` / `startStep`（`RunExec` 调用）、会话标签 / 输出渲染 / 停止 / 超时 | Maven 执行 + 输出展示直接复用；项目运行 `runProject(info, cmd)` 已是「给 exe+args+cwd 起一个会话」的范式 |
| `frontend/index.html` | 活动栏 `<nav id="activity-bar">`（`:2427`）、侧栏 `<aside id="sidebar">`（`:2482`）、各面板 div（结构 `:2498`、git `:2511`、app-pages `:2542`、database `:2551`） | 新增 Maven 按钮 + 面板 div 的落点 |
| `frontend/src/main.js` | `els` 登记（`:822-842`）、`initActivityBar`（`:3976`）、`applySidebarUI`（`:3867-3901`）、`toggleSidebarView` 注入（`:6022`） | 活动栏按钮接线 + active 态渲染 |
| `frontend/src/terminal/terminal-ui.js` | `currentSidebarView`（`:250`）/ `switchSidebarView`（`:256`）/ `toggleSidebarView`（`:274`），视图白名单 `['files','git','structure','chats','app-pages','database']` | 新视图 `maven` 要登记进这三处 |
| `frontend/src/dev/mock-backend.js` | `DetectToolchain` mock（`:1636`） | 新增绑定必须补同名 mock |
| `frontend/src/core/icons.js` | `iconSvg()` 图标注册表 | 新图标先注册再用，禁内联 SVG（守 `icon-guard.test.mjs`） |
| `frontend/src/core/form-controls.js` | `createSwitch` / `createSelect` / `createInput` / `createTextarea` | V2 开关 / 输入框的合规控件（守 `form-controls-factory.test.mjs`） |
| `frontend/src/core/overlay-stack.js` | 页面级浮层栈 | V2「运行任意 goal」弹窗的合规落点（守 `overlay-esc-guard.test.mjs`） |

### 3.3 架构约定（来自 AGENTS.md，必须遵守）

- 纯引擎下沉 `internal/<域>`，不 import main、不碰 App；根壳留 `*_app.go` 薄绑定。
- 前端新域模块用 `createXxx(deps)` factory + 显式依赖注入，不回填 `main.js`；依赖走 getter 延迟求值。
- 平台相关代码 `*_windows.go` + `*_other.go` 成对出现；平台无关文件不许出现 Windows 专属符号
  （守 `crossplatform_guard_test.go`）。
- 图标走 `core/icons.js` 的 `iconSvg()`；表单走 `core/form-controls.js`；弹层走 `core/overlay-stack.js`。
- 新增纯逻辑配测试并登记 `npm test` 清单；Go 表驱动 `*_test.go`；`go test` 一律后台执行并带 `-timeout`。
- 用户可见改动同步 `CHANGELOG.md` / `README.md`。

---

## 4. 总体架构决策

### 4.1 触发条件（图标何时出现）

两个条件**同时成立**才显示 Maven 图标：

1. **当前工作区是 Maven 项目**：从工作区根（或当前活动文件）向上探测到 `pom.xml`（纯文件 stat，零成本）。
2. **本机有 Maven**：`settings.langEnv.java.tools.maven` 的扫描缓存里 `envs` 非空（含有效 path）。

顺序有讲究：**先判 pom（零成本），命中后才处理工具链**——此时经 `terminal/run-ui.js` 的
`ensureToolchainForRun('java', 'maven')`（`:96`，注意不在 main.js，main.js 没有这个函数）惰性扫一次
并写回设置缓存。这样只装了 Maven 但从没进过设置页的用户也能看到图标，避免「扫描缓存为空 → 图标
永不出现」的冷启动死胡同；扫过之后就是纯内存判断。**不要**在启动时无条件起探测进程。

判定做成**惰性 + 缓存**：工作区切换 / 设置变更 / 手动刷新时重算一次，结果缓存在内存；
不在每次启动或每次渲染时全盘扫描。未命中时图标不显示，避免给非 Maven 用户制造噪音。

### 4.2 「仓库是 Maven」的识别

复用 `internal/runproject.Detect` 的上溯骨架，新增 `pom.xml` 标记。两种落地口径：

- **方案 A（推荐，改动最小）**：在 `runProjectMarkers` 加 `pom.xml`，`runProjectFromMarker` 加
  `case "pom.xml"` 分支，返回 `Kind="Maven"`、`Marker="pom.xml"`、根 = pom 所在目录。
  命令候选先给空（Maven 命令由前端面板驱动，不走 F5 项目运行弹窗）。
- **方案 B**：另起一个 `internal/mavenproject` 包做专用探测，返回 pom 路径 + 模块树。
  V1 不需要，V2 解析模块时才考虑。

V1 采用方案 A：Go 侧改动约 20 行，前端调 `DetectRunProject(path)` 拿项目根，再自己读 pom.xml 取 `<modules>`。
注意 `runproject.Detect` 的标记优先级是**数组顺序**；pom.xml 的插入位置已拍板（§9.3）：
`pyproject.toml` 之后、`Makefile` 之前。

涟漪（已验证可接受）：加 marker 后 F5 项目运行链路（`run-ui.js` `:214`）也会命中 Maven——
`showProjectChoice` 对空命令的行为是 `flash(note)`（run.js `:1196`），即按 F5 只会闪一条
「请用 Maven 工具窗口执行目标」，不弹窗卡流程，比静默好。

### 4.3 数据获取策略（关键）

| 树节点 | 数据来源 | 理由 |
|---|---|---|
| 生存期命令 | **前端固定列表** | clean/validate/compile/test/package/verify/install/site/deploy 是 Maven 标准生命周期，不随项目变；不解析 pom |
| 项目名 / artifactId | 读 pom.xml 的 `<artifactId>`（缺失时回退目录名） | 轻量 XML 解析即可 |
| 子模块 | 读 pom.xml 的 `<modules><module>` | 只需一层顺序读取；`${...}` 属性与 parent 继承 V1 不做，V2 用 effective-pom 补 |
| 依赖项 / 插件 | **V2：调 `mvn dependency:tree` / `help:effective-pom` 解析输出** | Maven 语义（properties / parent / profile / dependencyManagement）自造解析器成本极高 |
| 仓库 | **V2：读 `~/.m2/settings.xml` 的 `<localRepository>` + `help:effective-settings` 的 `<repositories>`** | 本地仓库路径与镜像配置由 settings 决定 |

### 4.4 执行通道

所有 Maven 命令经 `RunExec` 执行，复用 `createRunController` 的会话 / 输出 / 停止 / 超时逻辑：

- **`.cmd` 批处理坑（关键技术点）**：Windows 上 Maven 是 `mvn.cmd`，Go `exec.Command` 直接跑 `.cmd`
  不可靠。必须像现有 bat/cmd 配方（`run.js` RECIPES 的 `shell:'cmd'` + `['/c', …]` 范式）那样包一层
  shell：`ResolveRunShell('cmd')` 拿 `cmd.exe`，用 `cmd.exe /c mvn.cmd <goals...>`。解析失败**直接报错**，
  不做 shell 回退——`SHELL_FALLBACK`（run.js `:62`）没有 cmd 项，且回退 pwsh 跑 `mvn.cmd` 语法不对；
  cmd.exe 在 Windows 上必在，失败只可能是系统级异常。Go 侧零改动。
- 执行前继承现有门禁：`isReadOnly()` 拒绝、`hasConfirmed` 首次确认、并发上限（MAX_RUNNING）、
  用户可见错误走 `flash`。
- 输出落在「运行」面板（复用现有会话标签），或 V1 也可在 Maven 面板底部内嵌一个只读输出区——
  **推荐复用运行面板**，零新增渲染代码，且天然支持「跳到源码 path:line」「发给 AI 分析」。

---

## 5. V1 实施契约（识别 + 生存期 + 多模块）

### 5.1 目标

交付最小闭环：装了 Maven、打开一个 Maven 项目 → 左侧出现 Maven 图标 → 点开看到项目树 →
点 `compile` / `test` / `package` 等直接执行，输出进运行面板，可停止。多模块项目每个模块独立展开。

### 5.2 Go 侧改动

| 文件 | 改动 |
|---|---|
| `internal/runproject/runproject.go` | `runProjectMarkers`（`:38`）加 `pom.xml`；`runProjectFromMarker`（约 `:90`）加 `case "pom.xml"`：`info.Kind="Maven"`、`info.Marker="pom.xml"`，命令候选留空，`info.Note` 说明「请用 Maven 工具窗口执行目标」。**`Detect` 兜底报错（`:83`）把标记清单写死在文案里，必须同步**。 |
| `internal/runproject/runproject_test.go` | **改既有测试**（文件已存在，114 行表驱动）：加 pom 命中与优先级用例；`.git` 边界、主目录拦截已有覆盖。 |

> 不新增 Wails 绑定：项目识别复用现有 `DetectRunProject`，工具链复用现有 `DetectToolchain`。
> 因此 `dev/mock-backend.js` V1 无需补新 mock（两个方法都已存在）。

### 5.3 前端改动

| 文件 | 改动 |
|---|---|
| `frontend/src/core/icons.js` | 注册 `maven` 图标（Maven 的「M」标识），供活动栏与树节点使用。 |
| `frontend/index.html` | 活动栏 `ab-group` 加 `<button id="ab-maven">`（照 `ab-database` 先例，放它后面）；sidebar 加 `<div id="maven-panel">`（含 `.sb-head` 工具条 + `<div id="maven-tree" class="sb-body">`，照 `#database-panel` 先例）。 |
| `frontend/src/main.js` | `els` 登记 `abMaven`；`applySidebarUI` 加 maven active 态（照 `abDatabase` 写法）；`initActivityBar` 加点击接线（`toggleSidebarView('maven')`）；按触发条件控制按钮显隐（照 `ab-debug` 的 `hidden` 类）。**启动消毒条件化放行**：`settings.sidebarView` 白名单处（照 `!['files','git','structure','chats'].includes(...)` 重置 `'files'` 的写法）让 `'maven'` 仅当 `isTriggerMet()` 时放行、否则兜底 `'files'`——sidebarView 是每窗键但 localStorage 共享单槽，重启可能带着 `'maven'` 起来而触发条件已失效。工作区切换 / 设置变更处在 `workspaceFolder` 变更点重算触发条件（main.js 目前没有「工作区条件显隐按钮」先例，这是新增挂点）。 |
| `frontend/src/terminal/terminal-ui.js` | `currentSidebarView`（`:250`）与 `switchSidebarView`（`:257`）的白名单加 `maven`；渲染钩子（`:269`，照 database 的 `deps.renderDatabaseNav` 先例）切到 maven 时调 `deps.renderMavenTree()`。 |
| `frontend/src/maven/maven-panel.js`（**新增**） | `createMavenPanel(deps)` factory：判定触发条件、渲染树（配置文件 / 项目 / 生存期 / 子模块）、绑定节点点击 → 执行命令、刷新。纯函数（树数据构造、触发判定、命令拼装）拆出便于单测。 |
| `frontend/src/maven/maven-tree.js`（**新增**，可选） | 若 `maven-panel.js` 超过职责边界，把树构造 / 展开折叠状态拆到这里。文件头 2–3 行职责注释。 |
| `frontend/src/terminal/run.js` | 暴露一个「按 exe+args+cwd 起会话」的入口供面板调用：`runProject(info, cmd)`（`:1228`）已是此范式但**未导出**（控制器 return 只暴露 12 个方法），抽成公开方法 `runCommand({label, exe, args, cwd})` 加进 return；Maven 面板经 deps 注入调用。避免面板自己碰 `RunExec`。 |
| `frontend/src/main.js`（接线） | 注入 `mavenUi` 的 deps：`backend`、`settings`、`ensureToolchainForRun`（来自 `terminal/run-ui.js` `:96`，经 getter 注入）、`runCommand`、`flash`、`workspaceFolder`、`getActiveDoc`、`applySettings` 等 getter。 |
| （刻意不改）`main.js` AI `toggle_sidebar` / `set_sidebar_view` 白名单 | V1 **不给 AI** 切 Maven 面板的能力——数据库 / 应用页面也没加，先例一致；写明是决定不是漏改，防后续被当 bug 补上。菜单「视图」子菜单同样不用加（结构/AI 会话才有条目，git / database 也没有）。 |
| `frontend/test/maven/maven-panel.test.mjs`（**新增**） | 纯函数测试：触发判定（有/无 Maven × 有/无 pom）、树数据构造、Maven 命令拼装（`mvn clean` / `mvn -pl sky-admin compile`）。登记进 `npm test` 清单。 |
| `CHANGELOG.md` / `README.md` | 用户可见改动记录。 |

### 5.4 生命周期命令表（固定）

```
clean → validate → compile → test → package → verify → install → site → deploy
```

- 根项目：`mvn <goal>`。
- 子模块：`mvn -pl <module> <goal>`（V1 用 `-pl` 按模块名，暂不做 `-am` 依赖模块联动）。
- 工作目录：项目根（pom.xml 所在目录）。

### 5.5 验证

- Go：`go test ./internal/runproject/ -timeout 60s`（后台执行）。
- 前端：`npm test`（含新增 `maven-panel.test.mjs`）；确认 `icon-guard` / `form-controls-factory` /
  `overlay-esc-guard` 三道基线不红。
- 手工：dev 模式（`npm run dev`）用 mock 后端验树渲染；真实环境用一个多模块 Maven 项目验
  `compile` / `test` 执行、输出、停止、只读模式拒绝。

---

## 6. V2 实施契约（依赖 / 插件 / 仓库 + 配置 + 开关）

> 前置：V1 已交付。V2 各子项可再拆小批，逐项交付。

### 6.1 依赖项树

- 数据：`mvn -DoutputType=text dependency:tree`，解析缩进树成 `{groupId:artifactId:scope:version}` 节点。
  解析函数写成纯函数（`parseDependencyTree`），配表驱动测试（含缩进、scope、省略号行）。
- 展示：复用 V1 的树组件，节点可展开；点击节点可「跳到源码」（若本地仓库有对应源码）或复制坐标。
- 注意：`dependency:tree` 输出可能很大，设行数 / 字符上限（参照 `run.js` 的 MAX_LINES），超出提示截断。

### 6.2 插件与仓库

- 插件：`mvn help:effective-pom` 输出 XML——**Go 只起命令返回原文，前端 DOMParser 解析** `<build><plugins>`。
  与 §9 拍板一致：薄绑定原则 + mock 免维护 XML fixture + 截断上限内前端解析无压力；
  Go 侧解析反而扩大测试面（跨平台用例 + XML fixture 维护）。
- 仓库：
  - 本地仓库路径：读 `~/.m2/settings.xml` 的 `<localRepository>`（缺省 `<user.home>/.m2/repository`）。
  - 远程仓库：`mvn help:effective-settings` 解析 `<repositories>` / `<mirrors>`，展示名称 + URL。
  - 这些是只读文件读取 + 命令输出解析，不改用户配置。

### 6.3 配置文件快捷入口

- 树顶部「配置文件」节点下列出 `pom.xml`、`~/.m2/settings.xml`。
- 点击走现有 `openPath` / `openLocation` 在编辑区打开；遵循只读模式（只读时仍可打开查看，不可编辑）。

### 6.4 运行任意 goal（弹窗）

- 面板工具条「执行目标（Execute Maven Goal）」按钮 → 弹窗输入 `groupId:artifactId:goal` 或命令行参数。
- 弹层走 `core/overlay-stack.js` 注册，Esc 按层退；输入框走 `core/form-controls.js` 的 `createInput`。
- 执行走 V1 暴露的 `runCommand`，继承所有门禁。

### 6.5 执行开关

- 面板工具条加开关（V2）：离线（`-o`）、跳过测试（`-DskipTests`）、强制更新快照（`-U`）、
  不传递构建（`-ntp`）。
- 控件走 `createSwitch`，状态存 `settings.mavenFlags`（偏好键，随设置同步通道持久化）。
- 命令拼装函数把这些 flag 插在 goal 前，配测试。

### 6.6 Go 侧改动（V2）

| 文件 | 改动 |
|---|---|
| `maven_app.go`（**新增**） | 薄绑定：`MavenEffectivePom(workspaceRoot)` / `MavenSettings()`，下沉到 `internal/mavenproject`。只做「读文件 + 起 mvn 命令 + 返回原始文本」，解析可在前端。 |
| `internal/mavenproject/`（**新增**） | 封装：定位 pom、调 `mvn help:effective-pom` / `help:effective-settings`、读 settings.xml。纯逻辑，无 App 依赖；平台相关（`.cmd` 包装）放 `*_windows.go` + `*_other.go`。 |
| `dev/mock-backend.js` | 补 `MavenEffectivePom` / `MavenSettings` 同名 mock。 |

### 6.7 验证

- Go：`go test ./internal/mavenproject/ -timeout 60s`（后台）；`go build` 确认绑定编译。
- 前端：`npm test` 全绿（新增依赖树 / 命令拼装 / settings 解析测试并登记）。
- 手工：多模块项目验依赖树展开、插件列表、仓库路径、goal 弹窗、开关组合、只读 / 首次确认 / 并发门禁。

---

## 7. 改动面清单（汇总）

| 阶段 | 文件 | 类型 |
|---|---|---|
| V1 | `internal/runproject/runproject.go`（含 `:83` 兜底文案同步）+ 既有 `runproject_test.go` | 改 |
| V1 | `frontend/src/core/icons.js` | 改（注册图标） |
| V1 | `frontend/index.html` | 改（按钮 + 面板 div） |
| V1 | `frontend/src/main.js` | 改（els / 活动栏 / applySidebarUI / 启动消毒条件化 / 触发重算挂点 / 接线） |
| V1 | `frontend/src/terminal/terminal-ui.js` | 改（视图白名单 + 切换钩子） |
| V1 | `frontend/src/terminal/run.js` | 改（暴露 runCommand） |
| V1 | `frontend/src/maven/maven-panel.js`（+ 可选 `maven-tree.js`） | 新增 |
| V1 | `frontend/test/maven/maven-panel.test.mjs` | 新增测试 + 登记 npm test |
| V2 | `maven_app.go` + `internal/mavenproject/`（含 `*_windows.go` / `*_other.go`） | 新增 |
| V2 | `dev/mock-backend.js` | 改（补 mock） |
| V2 | `frontend/src/maven/` 下依赖树 / 插件 / 仓库 / goal 弹窗模块 | 新增 |
| V2 | `frontend/test/maven/` 对应测试 | 新增 + 登记 |
| 两期 | `CHANGELOG.md` / `README.md` | 改 |

---

## 8. 风险与护栏

- **`.cmd` 执行**：mvn.cmd 必须包 `cmd.exe /c`，不能裸 `exec.Command`（见 §4.4）。这是 V1 能否跑通的关键。
- **触发判定噪音**：只在「本机有 Maven + 有 pom.xml」时显示图标；判定惰性 + 缓存，不做启动全盘扫描。
- **只读 / 安全门禁**：所有执行继承 `isReadOnly` / 首次确认 / 并发上限 / 超时杀树，不绕过运行通道。
- **图标 / 表单 / 弹层三道护栏**：新图标先注册 `icons.js`；V2 开关 / 输入框走 `form-controls.js`；
  goal 弹窗走 `overlay-stack.js`。三道 `*.test.mjs` 基线只许绿，不许加豁免。
- **命令拼装注入**：goal 输入框内容按 argv 数组传给 `RunExec`（不经 shell 拼接），沿用 `splitRunArgs`
  的拆词规则；禁止把用户输入拼进 `cmd.exe /c "..."` 字符串。
- **大输出**：`dependency:tree` / `effective-pom` 输出设上限，超出截断提示，防止撑爆内存与 DOM。
- **pom 语义复杂度**：V1 只读 `<modules>` 一层，不处理 `${...}` / parent / profile；V2 用 effective-pom
  兜底，不自造解析器。
- **跨平台**：Windows 实现与 `_other.go` 桩成对；平台无关文件不出现 Windows 专属符号。
- **多窗口 / 设置同步**：`settings.mavenFlags` 属偏好键，默认同步；若加「面板显隐 / 宽度」类键要登记
  `PER_WINDOW_LAYOUT_KEYS`（settings-sync.js）。
- **重启残留**：`sidebarView` 是每窗键但 localStorage 共享单槽（重启取最后写入者），可能带着 `'maven'`
  起来而触发条件已失效——启动消毒处条件化放行 + 兜底 `'files'`（见 §5.3）。

---

## 9. 待决问题（2026-11-23 复核拍板）

1. **图标显隐策略**：拍板「不显示」。配合 §4.1 惰性扫描后副作用缩小——只有既无 pom 又无 Maven 才不显示。
2. **输出落点**：拍板复用「运行」面板（零渲染代码，跳转 path:line / 发给 AI 免费拿）；V1 不内嵌输出区。
3. **pom 标记优先级**：拍板插在 `pyproject.toml` 之后、`Makefile` 之前——Makefile 是兜底性质且 Windows
   少见，pom 语义更具体。
4. **子模块命令**：拍板 V1 用 `-pl <module>` 够；`-am` 改变构建语义，V2 做成右键菜单可选项而非默认。
5. **V2 解析落点**：拍板 **Go 只起命令返回原文 + 前端 DOMParser 解析**（薄绑定、mock 免维护 XML fixture、
   截断上限内前端解析无压力）。
6. **仓库树数据来源**：拍板调 `help:effective-settings` 拿生效配置并**按次缓存**（点仓库节点时刷新）——
   纯读 `settings.xml` 会漏 profile 注入的仓库；一次 `--non-recursive` 调用成本可接受。
7. **（新增）触发判定的惰性扫描**：拍板 pom 命中后再经 `ensureToolchainForRun` 惰性扫一次并缓存
   （见 §4.1），不在启动时无条件起探测进程。
8. **（新增）AI app_control 白名单**：拍板 V1 不给 AI 切 Maven 面板（数据库 / 应用页面先例一致），
   决定写进 §5.3，防后续被当漏改补上。

---

## 10. 实施顺序建议

1. V1 Go 侧（pom 识别 + 测试）→ 前端面板骨架 + 图标 + 视图接线 → 生存期命令执行 → 多模块。
2. V1 全量验证（Go + 前端 + 手工）通过后单独交付，更新 CHANGELOG。
3. V2 按 §6 子项拆小批：依赖树 → 插件 / 仓库 → 配置文件入口 → goal 弹窗 → 执行开关，每批一 commit。
4. 全部完成后本稿移入 `docs/finished-plans/`，状态头改为已实施。
