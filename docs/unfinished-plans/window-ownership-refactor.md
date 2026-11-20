# 窗口归属重构（per-window ownership，2026-11-21 审查遗留）

状态：**未开工**（2026-11-21 子代理全面审查发现，独立立项）

## 背景

v2 是「一窗一进程」，窗口间天然隔离；v3 一进程多窗口后，一批**进程级单例**在多窗口下语义失效。2026-11-21 四路子代理审查发现以下五项同根问题——修复思路统一为「按调用方窗口键控/归属」（与 `event_owner.go`、`SetDirty` 同一套思路），改动面横跨 watch/memo/browser/screenshot/dialog 多个域，故单独立项而不是零散修补。

## 待修清单（按影响排序）

1. **工作区监听单槽顶掉（P1）**：`internal/watch/watch.go` 是单槽 Watcher，两个主窗口先后 `WatchWorkspace` 会互相替换——后开窗口顶掉先开窗口的 `workspace-changed`，先开窗口的资源管理器自动刷新失效，**wipe-guard L2 对其工作区静默失明**。修法：绑定按调用方窗口键控（watcher 表 key = 窗口名，或引擎改多 root）；关窗时只摘自己的登记（与 `MemoUnwatch` 语义对齐）。
2. **memo 单写者租约同进程双写（P1）**：`internal/memo/memo.go` 的 refcount 是进程内重入计数，两个主窗口 `MemoLeaseAcquire` 同一作用域都会拿到 `Acquired:true`——v2 的「第二个窗口只读 + PID 横幅」保护静默消失（只剩 Save 的 mtime CAS 兜底）。修法：refcount 按「调用方窗口名」分桶，同窗口重入才 refs++，跨窗口返回 Busy；AGENTS/文档口径随之校准。
3. **`findWailsWindow()` 多窗口不确定（P1）**：按 PID 枚举第一个 `WailsWebviewWindow`，浮窗 TOPMOST 几乎总在首位——内嵌浏览器 WebView2 控件的父窗口、AI `screenshot` 的截图目标、第二个主窗口的任务栏图标补打都可能落到错误窗口。修法：从绑定 ctx 的 `callerWindow` 取 `win.NativeWindow()` 注入（浏览器/screenshot/图标三处统一）。
4. **对话框无属主（P2）**：`wailsApp.Dialog.*` 是 app 级 builder，创建的对话框无 owner——不模态、不跟随调用窗口，浮窗置顶时可能被压住。修法：改走 `callerWindow(ctx).Dialog().OpenFile()...`（窗口级 builder 带 owner）。
5. **资源监听同 key 替换式登记（P2）**：`internal/watch/resource.go` 对同 `kind|key` 先 stop 再登记——两个窗口 MemoWatch 同一 scope 时共用一条，先关窗口会把后开窗口依赖的推送拆掉。修法：与第 1 项同批，key 前缀加窗口名。

## 备注

- 1/5 同根、2/3/4 各自独立；1+5 与 2 都需要「窗口名 → 归属」的通用小工具（可从 `event_owner.go` 抽）。
- 未修期间的行为偏差：多主窗口下后开窗口的 watcher 顶掉先开窗口（wipe-guard L2 失明）、双窗口 memo 同时可写（靠 mtime CAS 兜底）、浏览器标签可能挂错父窗口——已知并在审查记录中声明，不作为未预期缺陷。
- 修复后同步校准 AGENTS.md 的「多窗口单写者」描述与 terminal-popout.md 的「AI 看不到弹出终端」口径。
