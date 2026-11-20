# Wails v3 P0 Spike 实测报告

> 2026-11-20 · 分支 `v3-migration` · spike 模块 `spike/wails3/`（独立 go.mod，不参与根包 v2 构建）
> 目的：按 `docs/unfinished-plans/wails-v3-migration.md` §5 的 P0 出口判据，验证七项平台还原度 + 工具链关。

## 0. 环境与复现

- Go 1.27.3（windows/amd64）、wails3 CLI v3.1.0、WebView2 Runtime 143.0.3650.139
- 依赖：`github.com/wailsapp/wails/v3 v3.1.0`（模块代理可用；v3.0.0 / v3.1.0 均已发布）
- 复现：

```bash
cd spike/wails3
go mod tidy
go build -o cadt-v3-spike.exe .
./cadt-v3-spike.exe --spike-auto     # 无人值守自检，约 26s 后自动退出
# 日志：%TEMP%\cadt-v3-spike.log
```

- spike 内容：主窗口（Frameless + 托盘）+ 运行时创建第二窗口（模拟 AI 浮窗）+ 仅用 `/wails/runtime.js` 的前端（无 npm 依赖）+ `--spike-auto` 自检序列（开浮窗 → 定向事件 → ExecJS 探针 → 拉起第二实例 → 退出）。
- 注意：fresh worktree 没有 `frontend/dist`（构建产物、gitignored），根包 v2 的 `go build ./...` 需先在 worktree 内构建前端；spike 模块不依赖它。

## 1. 七项结论

| # | 项 | 结论 | 证据（`cadt-v3-spike.log` / 运行时核验） |
| --- | --- | --- | --- |
| 1 | Frameless 无边框 | **通过** | frame 内缩 `left=0 top=0 right=0 bottom=-1`（合计 ≤ 4）→ repr 为无边框。v3 的无边框是标准 custom-frame（`WS_OVERLAPPEDWINDOW` + `WM_NCCALCSIZE` 裁非客户区，保留 resize/阴影），**不能用 `WS_CAPTION` 位判定** |
| 2 | 托盘 | **通过（图标目视待人工）** | `SystemTray.New()` + `SetIcon/SetTooltip/SetMenu/OnClick` 全部成功，菜单 5 项（显示主窗口/开浮窗/发事件/ExecJS 探针/退出）无错误；v3 原生提供 `OnDoubleClick`、`SetLabel`、`HideOnFocusLost` 等，覆盖现有自研 tray 能力面 |
| 3 | 单实例转发 | **通过** | 第二进程 `--spike-second-instance hello-from-auto` 启动后被单实例锁拦截，回调收到 `Args`/`WorkingDir`，第二进程 exit 0；主窗口收到 `spike:second-instance` 事件 |
| 4 | AI 浮窗（一进程多窗口） | **通过** | 运行期 `app.Window.NewWithOptions` 创建第二窗口 id=2，与主窗口**同一 PID**，独立 URL/尺寸，`ProbeState` 从浮窗返回 `mainID=1, floatID=2` |
| 5 | fork 补丁注入点 | **通过（补丁 1 原生消化；补丁 2 大部分原生消化）** | 见 §2 |
| 6 | 定向事件 | **失败（已知 bug 复现，有兜底）** | `mainWin.EmitEvent("spike:ping")` 同时被 main 与 float 收到，`sender=spike-main`；v3.1.0 `CustomEvent` 无 target 字段，`dispatch` 遍历全部窗口监听器。**兜底可行**：JS 侧 `WailsEvent.sender` 可用，按 sender/业务 key 过滤 |
| 7 | 每窗口独立 JS context | **通过** | `ExecJS` 只写主窗口的标记仅 `[js:main]` 上报，float 从未上报；`REALM-PROBE` 两窗 `count`/`createdAt` 各自独立增长 |

**判定**：七项中 6 项通过 + 1 项已知不可用但存在低成本兜底（sender 过滤）。按 §5 出口判据（fork 补丁有挂点、Frameless 工作、定向事件不工作即暂停——其中「定向事件」一项需按兜底成本重估，见 §4），**建议继续迁移，P2 前先做事件过滤方案**。

## 2. webview2 补丁面（§2 最高不确定项的实测）

### 补丁 1：迷你菜单禁用 → v3 原生选项，无需 fork

v3.1.0 `application.WindowsOptions` 原生支持 `DisabledFeatures []string` / `AdditionalBrowserArgs []string`，并在 WebView2 环境创建时与上游 feature 合并。运行时核验 WebView2 浏览器进程命令行：

```text
msedgewebview2.exe ... --disable-background-timer-throttling \
  --disable-features=msSmartScreenProtection,msWebOOUI,msPdfOOUI,msEdgeMiniMenu,msEdgeTextSelectionMenu ...
```

- 四个 mini-menu feature 全部生效，且与上游 `msSmartScreenProtection` **合并为同一个开关**（与本地 fork 的 `mergeBrowserArguments` 行为一致）。
- 结论：主窗口不再需要 go-webview2 fork；`third_party/go-webview2` 的 replace **仅为 `internal/browser` 保留**（内嵌浏览器标签页直接依赖 `go-webview2/pkg/edge`，fork 的迷你菜单注入与崩溃隔离仍在那里生效）。

### 补丁 2：闪退隔离 → 主要路径已被 v3 原生硬化

本地 fork 的两个具体崩溃原因，v3.1.0 已原生处理：

| 历史崩溃路径 | fork 的处理 | v3.1.0 行为 |
| --- | --- | --- |
| 页面 `postMessage` 非字符串 / 畸形消息 | 错误回调只通知、不退出 | `MessageReceived`：`dropping malformed web message` + log，进程继续 |
| `WebResourceRequested` 取 request 失败 | `log.Fatal` 改 `errorCallback` | 记录日志并丢弃该请求，进程继续 |
| COM 回调内 panic 穿透原生栈 | `guardCallback` recover | **仍是空白**：`internal/webview2` 全包无 `recover()` |
| Embed 失败 | 只通知、宿主隔离实例 | `errorCallback` 仍 `os.Exit(1)`（仅 WebView2 控制器创建失败路径） |

- 绑定调用（服务方法）在 v3 有独立 panic 兜底：`BoundMethod.Call` 把 panic 转成 `CallError`，不会带走进程（与 `PanicHandler` 选项配合）。
- 结论：**不为了「补丁 2」fork 整个 `wails/v3` 模块**（`internal/webview2` 是 internal 包，只能整模块替换，成本高、收益不确定）。剩余风险（COM 回调解 panic、embed 失败退进程）记入 P2 评估；如未来必须兜底，优先向上游提 issue / 提 PR。

## 3. 工具链关（v3.1.0 实际形态与方案文档的估计不同）

- **构建系统已换成 Wake，不是 Taskfile**：`wails3 build` 在找到 `wails.yaml` 时提示「this project has migrated to Wake; set `WAILS_EXP_USE_WAKE=1` (Taskfile fallback is disabled)」。设置该变量后构建通过：

```text
✓ build succeeded  9.3s
bin/cadt-spike-v3.exe  10.1 MiB
```

- **绑定生成可用且无需 npm 依赖**：`wails3 generate bindings -b ./...` 处理 261 包 / 1 service / 7 methods / 840ms，产物 `frontend/bindings/**` 直接 `import { Call } from "/wails/runtime.js"`（`-b` = bundled runtime）。默认模式才会 import `@wailsio/runtime` npm 包——**迁移可选择 `-b` 保持零 npm 依赖**。
- 无 `wails.yaml` 时 CLI 支持 `go run .` 直跑（`wails3 run` 的帮助文案）。
- 对方案 §3「构建流水线 0.5 天」的修正：主要成本是 `tools/rebuild-exe.ps1` / `scripts/build-installer.ps1` 改成 Wake 流程与 `wails.yaml`，而不是 Taskfile；估时不变。

## 4. 对迁移方案的影响（P1/P2 输入）

1. **§2 三行需修正**：构建流水线（Wake）、前端绑定（`-b` 可零 npm 依赖 + `window.go` 全局不存在）、fork 补丁（原生消化 + 仅 internal/browser 保留 fork）。
2. **P1 绑定聚合点**：v3 无 `window.go.main.App` 全局；`main.js` 的 `backend` 改为 `import * as App from './bindings/.../index.js'` 后 `backend = App`（方法名/Promise 形状不变，951 处调用不动）；`hasWails` 探测改用绑定模块可解析性或注入标志，mock-backend 分支同步改。
3. **P2 事件**：`window.EmitEvent` 全窗广播（#6608 复现）。`term-out` / `ai-chat` / `resource-changed` 需要二选一：① 全前端按 `sender` + 业务 key 过滤（sender 已验证可用）；② Go 侧用 `window.ExecJS` 定向投递（4 KiB 高频不建议）。建议 ①，成本主要在 `term-out` 的会话键过滤。
4. **多窗口单进程连坐风险**（方案 §4.3）实测成立：一个窗口的 WebView2 embed 失败会 `os.Exit(1)` 带走全部窗口；绑定调用 panic 已被隔离。P2 若保留多窗口默认，需接受该风险或向上游争取非致命化。
5. **AI 浮窗**：P2 从「独立进程 + `--ai-float`」改为 `app.Window.NewWithOptions` 已实测可行；`IsAIFloatWindow()` 的按进程判定要改成按窗口装配（与方案 §7 的判断一致）。

## 5. 未验证 / 留给人工

- 托盘图标在通知区的实际显示与点击行为（spike 创建成功，需目视确认）。
- 无边框窗口的拖拽/缩放/最大化行为（spike 只做静态 frame 内缩检测）。
- `wails3 dev` 热重载流程（本次只验证 `build`；`wails3 dev` 对 frontend.disabled 项目的形态在 P1 前补验）。
- 多显示器 / DPI 切换（v3 源码有专门处理，P1 回归清单保留）。
