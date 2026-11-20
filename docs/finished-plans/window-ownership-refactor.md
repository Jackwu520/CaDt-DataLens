# 窗口归属重构（per-window ownership，2026-11-21 审查遗留）

状态：**已实施**（2026-11-21 当日落地，随手工回归批次完成；五项全部收口）

| 项 | 落地 |
|---|---|
| 3. findWailsWindow 多窗口不确定 | 浏览器：`BrowserOpen` 加 ctx，`ParentForCall`（callerWindow+NativeWindow）按发起窗口挂控件，实例记 `ownerHWND`，关窗 `BrowserCloseByOwner` 回收；截图：`CaptureAppScreenshot(Region)` 同构改造；任务栏图标：`applyTaskbarIconTo(hwnd)` 逐窗补打 |
| 1. 工作区监听单槽顶掉 | `Watcher` 改按归属者多槽（`WatchWorkspaceFor(owner, root)`），绑定经 ctx 取窗口名；同窗口换根替换自己，跨窗口互不影响 |
| 5. 资源监听同 key 替换 | `ResourceWatcher.Watch/Unwatch` 增 owner 维度（内部 id `kind\|owner\|key`，事件 key 保持裸值）；`UnwatchByOwner` 关窗只摘自己的 |
| 2. memo 租约同进程双写 | `memoLeaseEntry.refs` 改 `holders map[窗口名]int`：同窗口重入计数、跨窗口 Busy（v2 只读横幅语义回归）；横幅 label 并入窗口名（同进程 PID 相同，靠窗口名区分）；`ReleaseLeaseByOwner` 关窗释放 |
| 4. 对话框无属主 | 七个对话框入口加 ctx，`dialogOwner(ctx)`（调用方窗口 → 回落当前主窗）+ `AttachToWindow(w)` 挂属主 |

窗口关闭统一收口在 `window_factory.go` 的 WindowClosing 钩子：`releaseWindowOwnedState(窗口名)`（watch 槽位 / 资源监听 / memo 租约）+ `BrowserCloseByOwner`。护栏：`internal/watch/ownership_test.go`（双窗槽位互不顶掉 / 按归属摘除）、`internal/memo/memo_lease_test.go`（跨窗口 Busy / 按归属释放）。

## 背景

v2 是「一窗一进程」，窗口间天然隔离；v3 一进程多窗口后，一批**进程级单例**在多窗口下语义失效。2026-11-21 四路子代理审查发现以下五项同根问题——修复思路统一为「按调用方窗口键控/归属」（与 `event_owner.go`、`SetDirty` 同一套思路），改动面横跨 watch/memo/browser/screenshot/dialog 多个域，故单独立项而不是零散修补。

## 待修清单（按影响排序）

1. **工作区监听单槽顶掉（P1）**：`internal/watch/watch.go` 是单槽 Watcher，两个主窗口先后 `WatchWorkspace` 会互相替换——后开窗口顶掉先开窗口的 `workspace-changed`，先开窗口的资源管理器自动刷新失效，**wipe-guard L2 对其工作区静默失明**。修法：绑定按调用方窗口键控（watcher 表 key = 窗口名，或引擎改多 root）；关窗时只摘自己的登记（与 `MemoUnwatch` 语义对齐）。
2. **memo 单写者租约同进程双写（P1）**：`internal/memo/memo.go` 的 refcount 是进程内重入计数，两个主窗口 `MemoLeaseAcquire` 同一作用域都会拿到 `Acquired:true`——v2 的「第二个窗口只读 + PID 横幅」保护静默消失（只剩 Save 的 mtime CAS 兜底）。修法：refcount 按「调用方窗口名」分桶，同窗口重入才 refs++，跨窗口返回 Busy；AGENTS/文档口径随之校准。
3. **`findWailsWindow()` 多窗口不确定（P1）**：按 PID 枚举第一个 `WailsWebviewWindow`，浮窗 TOPMOST 几乎总在首位——内嵌浏览器 WebView2 控件的父窗口、AI `screenshot` 的截图目标、第二个主窗口的任务栏图标补打都可能落到错误窗口。修法：从绑定 ctx 的 `callerWindow` 取 `win.NativeWindow()` 注入（浏览器/screenshot/图标三处统一）。
4. **对话框无属主（P2）**：`wailsApp.Dialog.*` 是 app 级 builder，创建的对话框无 owner——不模态、不跟随调用窗口，浮窗置顶时可能被压住。修法：改走 `callerWindow(ctx).Dialog().OpenFile()...`（窗口级 builder 带 owner）。
5. **资源监听同 key 替换式登记（P2）**：`internal/watch/resource.go` 对同 `kind|key` 先 stop 再登记——两个窗口 MemoWatch 同一 scope 时共用一条，先关窗口会把后开窗口依赖的推送拆掉。修法：与第 1 项同批，key 前缀加窗口名。

## 备注

- 原则：引擎按「归属者」键控，绑定一律带 ctx 从调用方窗口取归属键（窗口名或原生句柄）；窗口关闭统一收口。
- 归属键取窗口名（watch/memo）或原生 HWND（浏览器控件父窗口、任务栏图标、截图目标）——前者要参与前端/磁盘语义过滤，后者只面向 Win32。
- 行为偏差（原「未修期间声明」）全部消除：双窗口工作区刷新/wipe-guard L2 正常、memo 第二窗口恢复只读横幅、浏览器不再挂错窗口、对话框带属主。
