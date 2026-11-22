# CLI 启动参数收口：--help/--version + 转发路径行为修正 + 文档对齐（方案）

> 状态：**已实施**（2026-11-23；提交 `3aec7dc` help/version → `251b79c` 静默丢路径 → `26ed524` 转发修正与工作区路由 → docs 批次。落地决策与偏离记录见 §7）
> 决策依据：2026-11-22 讨论——CLI 面两年间持续生长（`文件:行:列` → `--new-window` → `--open-settings` / `--memo` / `--ai-session` → `--ai-float` / `--debug-console` / `--quit` → `--convert` / `--*-patch` / `--integrate` 三组 headless 子命令），解析结构本身是清晰的（GUI 开关在 `internal/launchargs`，headless 各占一包），**不需要重写**；但①没有顶层 `--help` / `--version`，一半开关是「读源码才知道」的隐藏知识，三处文档各记一部分互不一致；②转发/解析路径上有五个真实行为缺陷。用户裁定：先出方案文档，审完再实施。
> 2026-11-23 复核——用户确认多窗口文件投递补**缺陷 E（按文件所属工作区路由）**：文件属于某个已开主窗口的工作区 → 投那个窗口加标签页，不属任何已开工作区 → 维持投主窗口；**目录目标不路由**（维持投主窗口现状，不选「目录目标走同工作区复用」扩展项）。归属判定经讨论定为**祖先链逐级精确匹配取最深命中**（见 §3.4 E）。
> 范围：P0 可发现性（`--help` / `--version` + help 护栏测试 + 三处文档对齐）· P1 行为修正（A 静默丢路径 / B `--ai-session` 误投 CWD / C 转发丢会话 id / D 转发丢 settings+memo 组合参数 / E 多窗口文件投递按工作区路由）
> 体积影响：零新依赖，纯 Go 侧 + 文档；无前端改动、无新绑定（`dev/mock-backend.js` 不动）。

## 1. 背景与现状（代码事实，2026-11-22）

### 1.1 现有 CLI 面全景

| 类别 | 参数 | 解析/消费点 | 文档现状 |
| --- | --- | --- | --- |
| 打开定位 | `路径[:行[:列]]`、`--line/-l`、`--column/-c`、`--goto/-g` | `launchargs.ParseOpenTargets`（launchargs.go:112） | README + AGENTS.md + skill 均有 |
| 窗口形态 | `--new-window` | `app_core.go:229`；ParseOpenTargets 跳过（launchargs.go:118） | 仅 skill 有；README 命令行节无 |
| 定点打开 | `--open-settings=<pane>` | `launchargs.go:19` → `app_core.go:197` | **三处均无** |
| 定点打开 | `--memo=<locator>` | `launchargs.go:30` → `app_core.go:209` | README + AGENTS.md 有 |
| 定点打开 | `--ai-session=<id>` | `launchargs.go:41` → main.go:142 / app_core.go:234 | **三处均无** |
| 窗口形态 | `--ai-float` | main.go:146 / app_core.go:186 | **三处均无** |
| 窗口形态 | `--debug-console` | main.go:150 / app_core.go:190 | **三处均无** |
| 退出 | `--quit` | main.go:154 / app_core.go:182 | 仅 CHANGELOG 有 |
| headless | `--convert`（`--to/-t`、`--out/-o`、`--stdout`、`--force`） | `convertcli.ParseArgs` | README 有 |
| headless | `--check-patch` / `--apply-patch` / `--revert-patch`（`--dir`、`--only`、`--partial`、`--yes`、`--json`…） | `patchcli.ParseArgs`（patchcli.go:36） | README 补丁段落一句带过 |
| headless | `--integrate=…` / `--unintegrate=…`（安装包专用） | `installercli.Run`（installercli_windows.go:55） | 打包文档有，用户文档不需要 |
| 裸启动 | 无参数 → CWD 作工作区 | `launchargs.StartupCwdTarget` | README 无（冷启动 GetStartupTargets 兜底同一函数，app_core.go:309） |

### 1.2 缺陷（按严重度排序）

**A. 不存在的路径被静默丢弃**——`ParseOpenTargets` 对 stat 失败的参数直接 `continue`（launchargs.go:151-162），`datalens.exe typo.json` 打开欢迎页、零反馈。这条链正是给 agent 用的高频路径（`docs/skills/cadt-datalens/SKILL.md` 教 agent 用 CLI 开文件），agent 打错路径拿不到任何失败信号。前端已有现成反馈链：转发/启动目标经 `openTargets`（main.js:3574）→ `openPathsHere`，`OpenFile` 报错进 `lastError` → `flash('打开失败：' + lastError, true)`（main.js:3442）——Go 侧不再过滤，错误自然落进这条链。

**B. `--ai-session` 单独传参误投 CWD**——转发分支 targets 为空时兜底 `StartupCwdTarget()`（app_core.go:222），把**调用方 shell 的当前目录**当打开目标投给主窗口（可能触发工作区切换），会话 id 反而丢弃。`datalens.exe --ai-session=x` 在 `D:\tmp` 下执行，运行中窗口可能被切到 `D:\tmp`。

**C. `--ai-session=<id> 文件` 转发丢会话 id**——`--new-window` 分支带 `SessionID`（app_core.go:232-236），投递已有主窗口的分支 `deliverOpenTargets` 只投 targets（app_core.go:239），SessionID 静默丢失。冷启动路径正常（main.go:142 → windowSpec → 窗口启动上下文，window_factory.go:356）。

**D. `--open-settings` / `--memo` 与文件参数组合转发时文件被丢**——两个分支命中即 return（app_core.go:197-219），同命令行里的文件参数不投递。冷启动无此问题（windowSpec 四项字段并存）。

**E. 多窗口文件投递不按工作区路由**——默认投递分支一律投 `winReg.primary()`（app_core.go:239 → windowmeta.go:321：名为 `main` 的窗口，否则名字序最早的主窗口），与文件真实归属无关：同时开窗口 A（Alpha 项目）与窗口 B（CaDt-DataLens）时，CLI 打开 B 工作区下的文件，标签页落在 A 里——文件走绝对路径能打开，但 AI 会话列表 / Git 状态 / 便签作用域等 per-workspace 上下文跟的是 A 的工作区，与文件归属错位。`findByWorkspace`（windowmeta.go:302）与 `pathKeyForCompare` 归一键比较（windowmeta.go:341）已有现成基础；「同一工作区禁止双开」的 openMainWindow 复用逻辑（window_factory.go:348-364）只对 `spec.Workspace` 非空的目录场景生效，文件目标不走它。

**遗留死代码**：`launchargs.PathArgs` / `FirstPathArg`（launchargs.go:52-72）全仓无外部调用方（仅包内测试引用），是 v2 文件信箱协议删除后的遗留——与缺陷 A 的「第二套路径 stat 过滤」语义重叠，顺手清理。

### 1.3 会话 → 工作区解析的现成基础

B/C 修复需要「会话 id → 工作区路径」。会话磁盘布局为 `<root>/<ws8>/<id>/`，桶归属以 `meta.json` 的 `workspace` 字段为**真源**（sessionstore.go:280-291 注释明确「现存目录永远按 id 扫桶定位，workspace 不参与定位」）；`lockSessionDir` 已有按 id 扫全部桶的定位逻辑（sessionstore.go:292），`Service.AISessionList` 已有全桶遍历先例（service.go:43）。补一个 `ResolveSessionWorkspace(id) (string, error)`：按 id 扫桶定位目录 → 读 `meta.json.workspace`，十几行。

## 2. 目标与非目标

### 目标

1. 顶层 `--help/-h`（全部开关 + 三组 headless 子命令的中文用法文本）与 `--version/-v`（打印 `appVersion`）；打印前 `attachParentConsole()`（GUI 子系统无控制台，同 convert/patch 先例 main.go:61）。
2. 缺陷 A/B/C/D/E 修复；`PathArgs`/`FirstPathArg` 死代码清理。
3. help 护栏测试：源码里的 `--xxx` 开关字面量与 usage 文本双向对账，未来加开关漏写 help 直接红。
4. README 命令行节、AGENTS.md 命令行能力节、`docs/skills/cadt-datalens/SKILL.md` 三处对齐到同一份清单。

### 非目标（明确排除）

- **解析器单遍化重构**（现在 4 个 Parse 函数各扫一遍 args）：功能等价的纯内部整洁，不与行为修正混在同一批 diff，另行评估。
- **`--open-page=<id>`**（应用页面 CLI 入口）与 **`--db`**（数据库连接入口）：新入口需要交互设计讨论，另立方案。
- **转发成功与否的进程间回执**（agent 场景拿退出码）：单实例转发即退，回执通道成本高；缺陷 A 修复后「文件不存在」至少有窗口内 flash 反馈。
- `--integrate` 帮助文本（安装包专用参数，不进用户文档）。

## 3. 设计

### 3.1 `--help` / `--version`（P0）

- main() **最前**（`installercli.Run` 之前）：`launchargs.HasFlag(os.Args[1:], "--help") || HasFlag(…, "-h")` → `attachParentConsole()` + 打印 usage + `os.Exit(0)`；`--version` / `-v` 同构打印 `appVersion`。
- usage 文本拼接放 main.go（它已 import 全部四个 CLI 包，避免 launchargs 反向 import headless 包的层次倒挂）：
  - `launchargs.TopLevelUsage`（新增常量）：GUI 开关全清单 + 裸启动语义 + 三组 headless 的一句话索引；
  - `convertcli.Usage`（已有，convertcli.go:221）原样并入；
  - `patchcli.Usage`（新增常量，把 patchcli.go 文件头注释里的用法正式化）。
  - `convertcli.ParseArgs` 里现存的 `--help` 分支删除（顶层先行处理，留着就是两份 help 的漂移源）。
- `--convert --help` 行为变化：原打印 convert 专属 usage，改打印总 usage（含 convert 段）——可接受，总文本覆盖原内容。

### 3.2 help 护栏测试（P0）

根包新增 `cli_help_guard_test.go`，纯静态文件扫描、毫秒级（先例：`crossplatform_guard_test.go`）：

- 正向：正则扫 `main.go`、`app_core.go`、`internal/launchargs/`、`internal/convertcli/`、`internal/patchcli/`、`internal/installercli/` 源码里的 `--xxx` 字面量，断言每个出现在拼接 usage 文本里（`-l` / `-c` / `-g` / `-h` / `-v` / `-t` / `-o` / `-d` 等短开关单独维护断言表）；
- 反向：usage 文本里提到的每个 `--xxx` 在上述源码中存在（防文本先行漂移）；
- 豁免表写明原因（如 `--tags` 出现在注释里不属于 CLI 开关）。

### 3.3 缺陷 A：不存在的路径不再静默丢弃（P1）

- `ParseOpenTargets` 去掉「stat 失败 continue」（launchargs.go:160-162）：stat 只保留在 `splitPathLine` 里作「这是不是 `path:line` 形态」的判定依据，不存在的裸参数照常进 targets。冷启动 `GetStartupTargets` 与转发 `deliverOpenTargets` 都会带进前端，落在 `flash('打开失败：…')`。
- `splitPathLine` 行为保持：`D:\不存在.json:42` 拆分失败后按原样整体作为路径进 targets，前端报「文件不存在」，不会误开成别的。
- 删除 `PathArgs` / `FirstPathArg` 及其测试（launchargs_test.go 的 `TestFirstPathArgSkipsExeAndFlags` / `TestPathArgsKeepsFilesAndDirs`）。
- 风险评估：原先 stat 过滤顺带挡住「非路径垃圾参数」；改后垃圾参数会 flash 报错——**有反馈优于静默**，是期望行为。开关判定不变（`-` 前缀跳过）。

### 3.4 缺陷 B/C/D/E：secondInstance 转发路径（P1）

决策逻辑抽成纯函数便于表驱动测试（`app_test.go` 已有根包测试先例；secondInstance 本体碰 winReg/emit 难单测）：

```go
// secondInstancePlan：转发参数 → 动作 的纯决策函数（app_core.go）
type targetGroup struct { // E：按所属工作区分组后的投递单元
    windowName string                  // 命中的主窗口名；"" = 投主窗口（primary）
    targets    []launchargs.OpenTarget
}
type forwardPlan struct {
    kind      string  // "quit" | "float" | "debug" | "settings" | "memo" | "session-open" | "deliver" | "show"
    groups    []targetGroup
    sessionID string  // 修 C：deliver 时补投
    workspace string  // B/C：会话归属工作区（resolve 成功才有）
}
```

- 入参带两个依赖注入：`resolveSessionWorkspace func(string) (string, error)`（B/C 用）与 `routeWindowForPath func(path string) string`（E 用），表驱动覆盖：quit/float/debug/settings/memo 短路、session-only（B）、session+file deliver（C）、纯文件 deliver 按工作区分组（E）、裸 CWD 兜底。
- `secondInstance` 本体按 plan 分发，分发逻辑保持现有窗口操作语义：

  - **B（session-only）**：resolve 成功 → `a.openMainWindow(windowSpec{Workspace: ws, SessionID: id})`——openMainWindow（window_factory.go:351）自带「同工作区窗口复用 + 前置 + 投 `app-open-ai-session`」，正是期望语义；resolve 失败（会话不存在）→ `secondInstanceShow()` 只前置，**不再投 CWD**。
  - **C（session + file，无 `--new-window`）**：投递目标窗口取**第一个文件目标路由命中的窗口**（见 E）；`deliverOpenTargets` 之后，若会话归属工作区与目标窗口工作区一致，补投 `app-open-ai-session{workspace, sessionId}`——前端 `handleReuseSessionRequest`（main.js:3742）要求 workspace 匹配、无 reqId 不回执，语义刚好；不匹配 → 保持现状（丢 id）+ `writeAppLog` 一条 warn（现状是静默丢）。
  - **D（settings/memo + file）**：settings/memo 事件投递后不直接 return，同窗口再 `deliverOpenTargets`（targets 非空时），然后 return——顺序无冲突（前端两类事件独立消费）。
  - **E（文件投递按工作区路由，祖先链最深命中）**：deliver 分支不再一律投 `winReg.primary()`。路由数据源现成——每个主窗口打开/切换工作区时经 `WindowRegister`（window_app.go:30，前端 `syncWindowRegRegistration`）把当前工作区登记进窗口状态，切换即更新、关闭登记空串退出匹配。`routeWindowForPath` 算法：文件路径与各已登记工作区键统一过 `pathKeyForCompare`（`\`→`/`、小写、去尾斜杠，windowmeta.go:341）→ 从文件的父目录开始**逐级向上、每一级与窗口工作区键精确相等匹配**，第一个命中的级别即「最深包含工作区」，投那个窗口；爬到盘根（`dir == filepath.Dir(dir)` 终止）无命中 → 回落主窗口组。选最深而非前缀扫描的原因：①精确匹配逐级爬天然没有 `D:\a\b` 误吞 `D:\a\bc` 的边界问题；②嵌套工作区归最内层窗口（专门开的子目录工作区窗口管子目录文件，per-workspace 上下文——AI 会话分桶 / Git / 便签——最连贯）；③确定性可测试，无 MRU 类平局规则；④同一工作区禁止双开（window_factory.go:348），祖先链每级至多命中一个窗口。**目录目标不爬升**（维持投主窗口，前端 `openFolderSmart` 自有逻辑）；不存在的路径照常参与爬升（纯字符串祖先链，stat 不需要）——报错也报在归属窗口里。执行侧按组 `deliverOpenTargets` + `activateWindow`，多组时后投的窗口赢前置。单窗口场景行为完全不变（唯一主窗口既最深命中也是 primary）。
  - `--new-window` / 窗口打开模式分支与冷启动路径不动。

### 3.5 文档对齐（P0）

| 文档 | 改动 |
| --- | --- |
| `README.md` 命令行节 | 补 `--help` / `--version` / `--new-window` / `--open-settings=<pane>` / `--ai-session=<id>` / `--ai-float` / `--debug-console` / `--quit`；`--memo`、`--convert` 保持；headless patch 三参数给一行索引指向补丁段落；转发行为描述更新为「文件投给所属工作区的窗口（多窗口时），否则主窗口」 |
| `AGENTS.md` 命令行能力节 | 与 README 同清单同步（它是改动 CLI 时的工作参考） |
| `docs/skills/cadt-datalens/SKILL.md` | 补 `--help` 提示 + 会话/便签两类 agent 高频参数（`--ai-session` 修复后转发语义成立，可放心写进 agent 技能） |
| `CHANGELOG.md` | 收尾补用户可见变更 |

## 4. 实施切分（conventional commits，一批一主题）

1. `feat(cli): 顶层 --help/--version 与 usage 文本收口`——main.go / launchargs（TopLevelUsage）/ patchcli（Usage 常量）/ convertcli（死分支删除）+ `cli_help_guard_test.go`。
2. `fix(cli): 打开目标不再静默丢弃不存在的路径`——launchargs.go + `PathArgs`/`FirstPathArg` 清理 + launchargs_test.go 更新。
3. `fix(cli): --ai-session 转发修正与会话归属解析`——sessionstore.ResolveSessionWorkspace + app_core.go secondInstancePlan（B/C 分支）+ 表驱动测试。
4. `fix(cli): 多窗口文件投递按工作区路由`——secondInstancePlan 的 routeWindowForPath + 分组投递（E 分支）+ 表驱动测试。与 3 同函数同文件，但独立主题独立 commit、可单独 revert。
5. `docs: CLI 参数三处文档对齐`——README / AGENTS.md / SKILL.md。

每批提交前跑 `go test ./...`（后台执行、重定向日志、显式 `-timeout 300s`，按仓库规矩看退出码）；本方案无前端改动，`npm test` / `npm run build` 不强制，收尾跑一次确认无意外。

## 5. 测试清单

- `internal/launchargs/launchargs_test.go`：不存在的路径进 targets；`路径:行:列` 形态拆分不受影响；`--line` 后跟不存在路径仍作用于该目标。
- 根包 `cli_help_guard_test.go`：双向对账 + 豁免表。
- 根包 `secondInstancePlan` 表驱动：15+ 用例覆盖 §3.4 全分支，含 resolve 失败回退、C 的 workspace 不匹配丢 id + warn、D 的组合参数；E 专项——祖先链最深命中（嵌套工作区 `D:\proj` + `D:\proj\sub`，`sub\x.json` 归内层、`other.json` 归外层）、无命中回落主窗口、目录目标不爬升、不存在路径照常爬升、`D:\a\b` 与 `D:\a\bc` 不误匹配（精确相等口径）、大小写/反斜杠归一、盘根终止、单窗口场景与现状等价。
- `internal/sessionstore`：ResolveSessionWorkspace 命中 / 会话不存在 / 桶损坏回退。

## 6. 已知边界（记录，不在本方案处理）

- `--open-settings` / `--memo` 分支回退浮窗时（无主窗口），文件 targets 也投浮窗——语义上浮窗不是文件容器，维持「只投事件不投文件」的现有行为（D 修复只覆盖有主窗口的常规场景）。
- 转发即退，CLI 进程永远 exit 0（除 headless 子命令）——「文件是否真的打开了」没有进程级回执，见非目标。
- `splitPathLine` 对无 extension 的 `Makefile:42`、含冒号的 WSL 路径等边缘形态维持现有启发式，不动。

## 7. 落地记录（2026-11-23 实施）

- **提交切分偏离**：§4 原计划 5 批，实际 4 批——B/C/D/E 都落在同一个 secondInstance 决策重构里，拆开需要人为构造中间态，合并为一个提交（`26ed524`，主题统一为「转发路径修正与按工作区路由」，仍可整体 revert）。
- **E 实现细节**：`routeWindowForPath` 用 `os.Stat` 区分「存在的目录目标」（不路由，返回主窗口组）与文件/不存在目标（从所在目录起爬祖先链）——方案正文只写了「目录目标不爬升」，实现补充了判定手段；不存在的目标按文件处理，报错落在归属窗口。
- **deps 形态**：`secondInstancePlan` 的两个注入依赖收进 `forwardDeps` 结构（resolveSessionWorkspace + routeWindowForPath），比方案草图里的两个散参数好测（nil 字段有零值兜底）。
- **文档同步实际范围**：除方案列的三处（README / AGENTS.md / SKILL.md）外，skill 的 `reference/cli.md` 是第四处 CLI 参考文档，一并同步（参数表补全 8 个开关、拆分规则更新、多窗口路由描述）；顺手移除两处已失效的「多文件打开 = 多窗口」说法（appconfig `Read()` 自 2026-11-21 把 window 归一回 tab，后端恒按单窗口处理）。
- **README / CHANGELOG 未随 docs 批次提交**：两文件当时载有另一条在途功能线（Redis / 代码补全）的未提交文档，只改工作区避免混主题提交，待那条线收口时一并入库。
