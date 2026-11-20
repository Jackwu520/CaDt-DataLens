# Wails v2 → v3 迁移评估

> 状态：**已实施完成**（2026-11-20，`v3-migration` 分支 P0–P3；手工回归清单见 §11）
> 范围：框架迁移（单窗口行为等价）+ 多窗口改造（一进程多窗口）+ 迁移后清理
> 非范围：Linux/macOS GUI（见 `cross-platform.md`，不受本次迁移影响）

## 1. 背景与动机

- Wails v3.0.0 已于 2026-10 发布正式版（2026-08 beta），**原生多窗口**（`application.NewWebviewWindow`，窗口即一等对象）是主打特性；v2 的声明式单窗口 API 官方明言不适配多窗口。
- 动机一：**一进程多窗口（JetBrains 模型）**——跨窗口通信变进程内调用，消除跨进程竞态面；JetBrains Open Recent 对已打开项目默认聚焦已有窗口，是「复用优先」交互的业界先例。
- 动机二：本仓库 `multi-window-session-reuse.md` 的 windowreg 文件信箱，是一窗口一进程约束下对这类竞态的必要补偿（撤回/时效/ack）。v3 多窗口落地后 windowreg 可**整体删除**——它是可抛弃的脚手架，先交付不浪费。
- 时序决策（2026-11-20）：**先实施 windowreg 并发布（约 600 行、每期可回滚），再开迁移分支做 v3**。理由：迁移 2–3 人周且 v3 生态刚满一个月，先把即期功能用最小成本交付。

## 2. 实测耦合面（2026-11-20 统计，口径可信）

| 项 | 实测数据 | 说明 |
| --- | --- | --- |
| wails 耦合隔离面 | 根壳 Go 共 5,313 行；**21 个 `internal/` 域包零 wails 依赖** | `go-layout.md` 引擎下沉的红利在此兑现：迁移不触碰任何域引擎 |
| runtime 调用 | 根目录 9 个文件 48 处 `runtime.*` | v2 全局 runtime 包 → v3 窗口/应用对象方法，机械替换 |
| 事件（Go） | 28 处 `EventsEmit/EventsOn` | → `app.Event.Emit/On`，机械替换；**事件名精确匹配是常见故障点** |
| 绑定方法 | 301 个（`wailsjs/go/main/App.d.ts` 729 行） | v2 `Bind: []interface{}` → v3 `application.NewService(...)`，方法名不变 |
| 前端绑定调用 | **聚合点仅 1 处**（`main.js:121` `backend = window.go.main.App`），951 处 `backend.XXX` 调用全走它；直接 import wailsjs 的仅 2 个文件（`ai-panel.js` / `ai-worktree.js`） | 关键红利：v3 绑定重新生成后保持对象形状（方法名 + Promise 返回），951 处调用**零改动**，只换聚合点。**2026-11-20 评审补记**：v3 绑定是 ES module，`window.go.main.App` 全局在 v3 不存在——除聚合点外，`main.js:115` 的 `hasWails` 探测（同时决定 dev 模式 mock-backend 动态 import 分支）也要改用 v3 探测方式（绑定模块可解析性或注入标志），属净增改动。**P0 实测修正**：v3 绑定可走 `-b` 引用 `/wails/runtime.js`；**最终实现**是不生成绑定、不引 npm——动态 import 运行时 + `Call.ByName('main.App.<Method>')` Proxy，951 处调用零改动（见 §10） |
| 事件（前端） | 48 处 `EventsOn/EventsEmit/EventsOff`，分布 5 个文件（main.js / memo-term.js / mock-backend.js / reading.js / run-ui.js） | → `@wailsio/runtime` 的 `Events.*` |
| 托盘 | 自研 `internal/tray` + `trayhost_windows.go` 平台对（v2 无原生托盘才自研） | 基本直接留用；或换 v3 原生 `app.SystemTray` 反而简化 |
| 单实例锁 | v2 的 `SingleInstanceLock`/`OnSecondInstanceLaunch`（`main.go:83`、`app_core.go:187`）→ **v3 内置同形 API**（官方 Single Instance 指南，`options.SingleInstance{UniqueID, OnSecondInstanceLaunch}`，2026-11-20 复评修正：初评误判为无对应物需自研） | `secondInstance` 回调三分支逻辑几乎可平移 |
| 构建流水线 | `wails build` / `wails dev` → v3 `wails3` CLI；受影响存量：`tools/rebuild-exe.ps1`（测试门 + 便携副本替换）、`scripts/build-installer.ps1` + `build/windows` NSIS、`frontend/package.json.md5` 门控 | **2026-11-20 评审补记**：工作量表未计入的整条工具链切换，约 0.5 天；spike 跑起来第一关就是它。**P0 实测修正**：v3.1.0 已切到 **Wake**（`wails.yaml` 工程配置；`wails3 build` 需 `WAILS_EXP_USE_WAKE=1`，Taskfile 回退已关闭），不是 Taskfile 流程 |
| fork 的 webview2 | `go.mod:54` 本地 replace `third_party/go-webview2`，2 个本地补丁（迷你菜单禁用、闪退隔离） | **不确定度最高**：v3 自带 webview2 栈，补丁注入点要重找，0.5–2 天。**P0 实测解决**：迷你菜单禁用由 v3 原生 `Windows.DisabledFeatures` 覆盖（运行时命令行已证实，与上游 feature 自动合并）；闪退隔离的两条历史崩溃路径（畸形 postMessage / `WebResourceRequested` 失败）v3.1.0 已原生硬化。**不需要为这两个补丁 fork `wails/v3`**；`third_party/go-webview2` 的 replace 只为 `internal/browser` 保留（内嵌浏览器仍直接依赖它）。剩余：v3 的 COM 回调 panic 无 `recover()`、embed 失败仍 `os.Exit(1)`（仅 WebView2 控制器创建失败），记入 P2 风险 |
| 官方迁移指南估计 | 「典型应用 1–4 小时」 | 对 hello-world 级成立；本项目回归面（见 §3）决定下限，不适用 |

## 3. 工作量估算

**合计约 2–3 人周**，可分期，非「全框架重写」（评审初期曾误判为一个数量级，已按上表实测修正）：

| 块 | 估算 |
| --- | --- |
| Go 侧（启动段 v3 三段式 + 48 处 runtime + 28 处事件 + NewService 绑定 + 自研单实例锁 + 托盘留用） | ≤ 1 周 |
| 前端（聚合点 1 行 + `hasWails` 探测改 v3 方式 + 2 个文件的 wailsjs import + 48 处事件 + mock-backend 适配） | 1–2 天 |
| 构建流水线（`wails3` CLI + Wake、`tools/rebuild-exe.ps1` / `scripts/build-installer.ps1` 适配） | 0.5 天（2026-11-20 评审补记；P0 实测：`wails3 build` 9.3s / 10.1 MiB 已跑通） |
| fork webview2 补丁对齐 | ~~0.5–2 天~~ **P0 消解**：补丁 1 走 v3 原生选项、补丁 2 主要路径已原生硬化；仅 `internal/browser` 继续用现有 fork |
| **回归验证（成本大头）**：301 个绑定方法签名核对、21 个域包集成测试（MCP 假 server / ConPTY / WebView2）、无边框窗口（`main.go` `Frameless: true`）、AI 浮窗、调试控制台、双实例转发、wipeguard、手工双窗口场景 | 3–5 天 |

## 4. 风险与缺口

1. **v3 生态成熟度**：v3.0.0 发布刚满一个月，本项目压着大量 Windows 深度特性（无边框、AI 浮窗、托盘、单实例转发）。`internal/` 域包的纯 Go 能力（ConPTY、DPAPI、wipeguard ACL、sessionstore）不受迁移影响，但窗口壳层还原度必须实测。→ P0 spike 专门验证。
2. **fork 补丁注入点**：v3 重写了 webview2 栈，两个本地补丁（迷你菜单禁用、闪退隔离）不一定有对应挂点；丢不起的部分要在 spike 里确认。
3. **单点故障面变化**：v3 多窗口共享一个 Go 进程——一个窗口把 Go 侧拖死（panic/阻塞）会连坐所有窗口；WebView2 渲染进程仍按窗口隔离，JS 卡死不连坐。对「多格式查看器经常开大文件」的场景，这是相比现有一窗口一进程模型的真实损失，评估多窗口改造时权衡。
4. **多进程基建冗余化**：v3 多窗口后，`resourcelease` / `internal/watch` 资源监听 / multi-instance-sync 体系大部分仍服务于「用户双击 exe 开第二进程」「AI 浮窗」等场景，不会作废，但部分语义要重审（P3 清理阶段处理，不阻塞迁移）。

## 5. 迁移分期

| 期 | 内容 | 出口判据 |
| --- | --- | --- |
| P0 spike | 独立分支：只迁 `main.go` 启动段跑起来，验证 **Frameless 无边框 / 托盘 / 单实例转发 / AI 浮窗 / fork 补丁注入点 / 定向事件 / 每窗口独立 JS context** 七项还原度（2026-11-20 复评加两项：定向事件——issue #6608 报 `window.EmitEvent()` 实际广播到所有窗口，term-out/ai-chat/resource-changed 在多窗口下必须真定向或全前端过滤；每窗口独立 JS context 是 per-window 装配的前提）；起跑先过**工具链关**（2026-11-20 评审补记：`wails3` + Taskfile 迁移、`wails dev` 等价热重载——机械适配，不占七项名额、不设暂停条件）。**2026-11-20 已完成**（`spike/wails3/` 独立模块，见 `docs/reports/wails-v3-p0-spike.md`） | 七项中五项可用 → 继续；fork 补丁无挂点、Frameless 缺失或定向事件不工作 → 暂停迁移，回到 v2 路线（windowreg 方案不受影响）。**实测：6 项通过；定向事件确认广播（#6608），`sender` 可用于前端过滤；按「可用 + 兜底成本」判定继续，P2 先落事件过滤** |
| P1 框架等价迁移 | 绑定 NewService、48+28 处 runtime/事件替换（事件订阅按 `wails-v3-event-filtering.md` 走桥接层）、自研单实例锁、前端聚合点与事件、mock-backend；**保持单窗口，行为零变化** | 全量 Go + 前端测试过；`tools/rebuild-exe.ps1` 测试门过；手工回归 §3 清单 |
| P2 多窗口改造 | `--new-window` 改 `app.Window.New`（同进程开窗）；窗口注册表改进程内对象；AI 浮窗 / 调试控制台改窗口对象 | 手工双窗口场景与 v2 时代行为对照 |
| P3 清理 | 删除 `internal/windowreg` 及其绑定/前端接线；重审 resourcelease / watch 在新模型下的语义；`AGENTS.md` / CHANGELOG 收口 | 文档与代码一致 |

每期独立 commit、可单独 revert；P1 完成即可合回 master（等价迁移本身有独立价值），P2/P3 是否继续由 P0/P1 的实际体验决定。

## 6. 与 windowreg 方案的关系

- 短期（v2）：`multi-window-session-reuse.md` 照常实施——v2 单窗口约束下唯一可行且成本最小的复用路径。
- 长期（v3）：P2 落地后 windowreg 的注册表/信箱/撤回协议整体删除，「点别的工作区会话」变成进程内路由，本方案处理过的竞态（迟到双开、事件丢失）从架构上消失。
- 两方案的评审结论互相引用：本文件 §1 时序决策 ↔ `multi-window-session-reuse.md` §8-D。

## 7. 复评（2026-11-20 晚，windowreg 交付后）

初评的两大不确定项一个消除、一个恶化，风险分布改变，总判断不变（P0 spike 先行）：

**升级 ×2**

- **单实例锁 v3 内置**（官方 Single Instance 指南，`options.SingleInstance` 同形 v2）：初评「无内置对应物、自研 1 天」作废；`secondInstance` 回调三分支（设置页 / memo locator / 打开目标）几乎平移。
- **v3.1.0 于 11-01 发布**（3.0.0 后一周）：维护活跃；附带 CGO-free 实验性桌面构建——对 `cross-platform.md`「Linux GUI 必须 cgo+gtk3」的前提是动摇信号，那边立项时重估。

**降级 ×1**

- **事件定向发射有已知广播 bug**（wails#6608：`window.EmitEvent()` 实际广播到所有窗口）。本项目 `term-out`（4 KiB 高频终端块）/ `ai-chat` 流 / `resource-changed` 在 v2 单窗口下全局广播无感，v3 多窗口下全部变成跨窗口噪音——P2 必须做「定向事件真工作」或「全前端按 key 过滤」，后者是净增成本。这是初评完全没计入的工作量，P2 上修。

**同日实证**

- windowreg 撤回协议一天内三轮演进（remove → rename → O_EXCL claim），每版都被竞态用例在 Win10+ POSIX 语义下打脸——这正是 v3 一进程多窗口整类消灭的复杂度（进程内调用无文件协议、无跨进程竞态）。「先交付 v2 再迁移」的账结清：功能即期可用 + 迁移动机实证。
- 多实例基建去留矩阵已梳理（见仓库认知条目）：watch→重放保留改进程内事件；租约/claim 的窗口↔窗口协调消失（双击 exe 第二实例仍需单实例锁，v3 内置兜住）；per-workspace 分桶与 `activeSessionByWorkspace` 语义不变；startup 的 convert/浮窗/调试窗早退分支是**按进程参数判定**的，v3 下改按窗口装配（服务启动一次），属 P2 新增改造点。
- P3 成本下修：windowreg 已被 23 个 Go 用例 + 独立审查锁死，删除有 61 包测试基线护着。

**数字修正**：总量 2–3 人周维持；构成从 Go 侧为主偏移到前端事件与启动装配。P0 spike 清单五项 → 七项（加定向事件实测、每窗口独立 JS context 确认）。

**决策**：维持「先验收 windowreg → commit/push 收口 master → 开 `v3-migration` 分支跑 P0 spike」。七项中 fork 补丁挂点、Frameless、定向事件任一不过即暂停——今天只把「能不能迁」收敛为「七项还原度」，拍板等 spike 实测。

## 8. 参考

- [Wails 官方迁移指南 v2 → v3](https://wails.io/migration/v2-to-v3)（六步手动迁移，无自动化工具）
- [Wails 官方 Single Instance 指南](https://wails.io/guides/single-instance)（v3 内置单实例锁，复评修正依据）
- [Wails v3.1.0 发布](https://wails.io)（2026-11-01，CGO-free 实验构建 + Wake 工具）
- [wails#6608：window.EmitEvent() 广播到所有窗口](https://github.com/wailsapp/wails/issues/6608)（定向事件风险依据）
- [Wails v3 事件 API 参考](https://wails.io/reference/events)（Window-to-Window 定向模型）
- [GitHub Discussion #4509：v2→v3 迁移讨论](https://github.com/wailsapp/wails/discussions/4509)
- [Wails v3.0.0 发布公告](https://wails.io/blog/wails-v3-released)
- JetBrains 对照：一进程多窗口 + SocketLock 转发 + Open Recent 复用先例（来源见 `multi-window-session-reuse.md` §8）

## 9. P0 spike 实测结论（2026-11-20，分支 `v3-migration`）

完整证据与复现命令见 `docs/reports/wails-v3-p0-spike.md`；spike 代码在 `spike/wails3/`（独立 go.mod）。

| # | 项 | 结论 |
| --- | --- | --- |
| 1 | Frameless | **通过**（custom-frame：frame 内缩 0/0/0；v3 保留 `WS_OVERLAPPEDWINDOW` 走 `WM_NCCALCSIZE`，不能按 `WS_CAPTION` 判定） |
| 2 | 托盘 | **通过**（`SystemTray.New` + 菜单/点击回调；图标目视待人工） |
| 3 | 单实例转发 | **通过**（回调拿到 args/cwd，第二进程 exit 0） |
| 4 | AI 浮窗（一进程多窗口） | **通过**（运行期创建第二窗口，同 PID、独立 JS） |
| 5 | fork 补丁注入点 | **通过**：迷你菜单走 v3 原生 `DisabledFeatures`（运行时命令行证实）；闪退隔离两条历史路径已原生硬化；无需 fork wails |
| 6 | 定向事件 | **失败（#6608 复现）**：`window.EmitEvent` 广播到所有窗口；`WailsEvent.sender` 可用，前端过滤兜底 |
| 7 | 每窗口独立 JS context | **通过**（ExecJS 标记/REALM 探针均只命中目标窗口） |

**工具链**：`wails3 build`（Wake）9.3s 出包；`wails3 generate bindings -b` 840ms 生成（引用 `/wails/runtime.js`，零 npm 依赖）。

**结论**：P0 出口判据满足（6 通过 + 定向事件有低成本兜底），**迁移继续**；进入 P1 前先按 §2 三处修正更新估算，P2 首项落事件过滤设计。**事件过滤方案已独立立项**：`wails-v3-event-filtering.md`（P1 内建桥接层 + 48 处订阅迁移，估算 +2 天；P2 不再单列事件改造）。

## 10. P1 实施记录（2026-11-20，分支 `v3-migration`）

**已完成（`aa8921a` + 本批）**

- Go 启动段：`application.New` + `NewService(app)` + `WebviewWindow`（Frameless / Hidden / EnableFileDrop / Zoom）；生命周期映射：`ServiceStartup` ↔ v2 `OnStartup`、`WindowClosing`+`Cancel` ↔ `OnBeforeClose`、`Windows.WebViewNavigationCompleted` ↔ `OnDomReady`（非 Windows 由 8s 兜底显示）。
- 兼容层 `wails_app.go`：app 级/窗口级事件发射（窗口级带 sender）、窗口显示/隐藏/标题/尺寸/背景、剪贴板、退出；根壳 48 处 `runtime.*` 全部切换，对话框改 v3 builder。
- 前端绑定：`core/wails-runtime.js` 动态加载 `/wails/runtime.js`（`@vite-ignore` + 变量 specifier，Vite 不会在构建期解析），`backend` 用 `Call.ByName('main.App.<Method>')` Proxy——951 处调用零改动；`window.runtime` / `window.go` shim 兼容旧模块（ai-panel / reading / 插件）。
- 事件桥：`core/app-events.js` + `core/event-scope.js`，48 处订阅收口（守卫测试：`EventsOn` 只许出现在桥与 mock）；控制命令改 `emitWindowEvent`（sender = 窗口名）并经 `onWindow` 过滤；`run-ui` 等模块顶层订阅走就绪队列。
- 构建流水线：`tools/rebuild-exe.ps1` / `scripts/build-installer.ps1` 改为「npm run build → `wails3 generate syso` → `go build -tags production`」；产出 `build/bin/CaDt-DataLens.exe`（约 35 MB，含图标/清单/版本资源）。
- 验证：`go test ./...` 全绿；`npm test` 全绿；实机跑通首屏渲染、单实例文件转发（open-targets 落标签页）、AI 浮窗模式（独立进程 560×760）、调试控制台窗、关窗干净退出。
- 跨平台护栏：补齐 `portablewindows_other.go`（master 上缺失的 `countOtherPortableWindows` 桩）、`windowicon_other.go` 签名同步；`tools/check-crossbuild.ps1` 非 Windows vet 加 `-tags purego`（v3 CGO-free 要求）——linux/darwin 三目标全部通过。

**待办（P1 剩余 / P2 前置）**

- 手工回归：托盘、文件拖放、终端/运行/浏览器事件、多显示器/DPI、无边框拖拽与缩放。
- `wails3 dev` 热重载流程适配（开发体验，不阻塞交付）。
- P2：窗口注册表改进程内、`term-out`/`cmd-*` 等流事件加 owner 收紧 `onOwned`、AI 浮窗改窗口对象。
- P3：删除 `frontend/wailsjs`（v2 生成物）与 `internal/windowreg`。

## 11. P2 实施记录（2026-11-20，分支 `v3-migration`）

**已完成**

- **一进程多窗口**：新增 `windowmeta.go` 进程内窗口注册表（名字 / 形态 / 工作区 / 启动参数 / 每窗脏标记与 AI 状态）；绑定方法通过 `ctx.Value(application.WindowKey)` 归属调用方窗口（v3 在 `messageprocessor_call` 注入），`stateForCaller` 无上下文时回退主窗口（测试友好）。
- **窗口工厂 `window_factory.go`**：主窗口（可多开 `main` / `main-2`…）、AI 浮窗（单例 `float`）、调试控制台（单例 `debug`）统一创建；每个窗口独立注册 `WindowClosing` / `WebViewNavigationCompleted` 钩子。
- **单实例语义简化**：所有模式共用同一 UniqueID（`CADT_UNIQUE_ID` 可覆盖，供并行测试/便携多配置）；第二实例不再新起进程，由 `secondInstance` 决定开主窗口 / 浮窗 / 调试控制台。
- **进程内开窗**：`--new-window`、窗口打开模式、`OpenNewWindow`、`OpenDirInNewWindow`、`OpenWorkspaceForConversation`、`OpenAIFloatWindow`、`OpenDebugConsoleWindow` 全部改为同进程窗口；`OpenDirInNewWindow` 保留目录校验（空/不存在/非目录报错）。
- **跨窗口会话复用**：`WindowRegister` / `WindowReuseForSession` 改进程内注册表；命中目标工作区时直接投 `app-open-ai-session`（window 作用域事件）并前置目标窗口；`WindowInboxTake/Ack` 保留空实现兼容旧 drain 循环。
- **前端**：`app-open-ai-session` 纳入事件桥；浮窗/调试控制台形态判定改由调用窗口 context 决定（`IsAIFloatWindow` / `IsDebugConsoleWindow`）。
- **实机验证**：单进程同时存在 2 个主窗口 + 浮窗 + 调试控制台；第二实例 `--new-window <file>` 只在新窗口打开文件；关闭单个窗口其余存活、全关进程退出；浮窗（560×760，AI 面板单栏）与调试控制台（780×460，控制台输出）渲染正确（PrintWindow 截图）。

**待办（P2 收尾 / P3）**

- 会话复用命中后目标窗口切换失败（会话已删等）的源窗口兜底：v2 有 ack 协议，进程内投递当前无回执，需补一个结果事件或改为同步返回。
- `term-out` / `cmd-*` / `run-*` 等流事件加 owner 字段，把事件桥的 `onOwned` 真正收紧（当前仍是 app 级广播 + 消费端按 id 过滤）。
- 多窗口下的 session 快照共享（`cadt.session.v1` 是共享 localStorage；per-workspace 快照已按工作区隔离）、托盘「最后一个窗口」交互、手工双窗口回归。
- P3：删除 `internal/windowreg`、`internal/newwindow`、`frontend/wailsjs` 与 root 里的兼容空实现。

## 12. P3 清理记录（2026-11-20）

- **删除旧基建**：`internal/windowreg`（文件注册表 + 信箱协议与 23 个用例）、`internal/newwindow`（进程拉起）、`frontend/wailsjs`（v2 生成绑定）。
- **信箱收口**：`WindowInboxTake/Ack` 绑定、前端 `drainWindowInbox` 轮询/获焦兜底、`resource-changed` 的 `window-inbox` 分支全部删除；原 `handleInboxRequest` 更名 `handleReuseSessionRequest`，只服务 `app-open-ai-session` 事件。
- **死代码清理**：`wails_app.go` 只保留应用/主窗口/事件/剪贴板/退出接缝；`windowicon_windows.go` 去掉跨进程响应探测；`portablewindows_*`（跨进程窗口计数）删除。
- **文档收口**：`README.md`、`AGENTS.md`、`docs/packaging.md` 更新到 v3 构建（`wails3 generate syso` + `go build -tags production`）与 `Call.ByName` 绑定口径；本方案与事件过滤方案归档 `finished-plans`，`multi-window-session-reuse.md` 作为 v2 阶段实现留档。
- **验证**：Go/前端全量测试、linux/darwin 交叉编译、`tools/rebuild-exe.ps1` 测试门与构建均通过。

## 13. 收尾补强（2026-11-20，P3 后）

- **复用回执**：`WindowReuseForSession` 改为投递后等待目标窗口回执（`WindowReuseResult`，预算 2.5s）；目标切会话失败/超时返回空串，源窗口退化为开新窗口（等价 v2 信箱 ack）。
- **流事件 owner**：新增 `event_owner.go` 与 `RegisterEventOwner/UnregisterEventOwner` 绑定；`term-out`/`term-exit`/`cmd-*`/`run-*`/`browser-*`/`reading-search-progress` 按 id 查归属窗口定向发射，前端用事件桥 `onWindowOrBroadcast` 接收（未登记时的创建竞态仍走广播 + id 过滤）。
- **开发工作流**：补 `Taskfile.yml` + `build/config.yml`（`build/Taskfile.yml`、`build/windows/Taskfile.yml`），`wails3 task windows:build` 与 `wails3 dev` 可用；前端构建在 DEV 模式下跳过（Vite dev server 供资源），不生成绑定、不改图标。
- **版本与资源**：`v1.2.0`（appVersion / wails.json / build/windows/info.json / wails_tools.nsh 四处一致）；`build/windows/info.json` 改 v3 schema，修复此前 v2 模板导致 exe 版本资源为空的问题。
