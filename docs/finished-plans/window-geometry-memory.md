# 窗口几何记忆与浮窗行为工程化（第一期）

状态：**已实施**（2026-11-20，`v3-migration` 分支）

## 背景

v2 时代的浮窗是「再起一个进程 + CSS 把主界面藏起来」，窗口位置/尺寸完全交给系统，用户每次打开 AI 浮窗、调试控制台都要重新摆一遍；多主窗口也总是叠在同一位置。Wails v3 一进程多窗口落地后，窗口成为进程内的一等对象，位置记忆与多屏收敛才有稳定的落点。

本期只做**窗口行为工程化**的第一块：几何记忆。它是后续终端 tear-off 的地基（新窗口创建、跨窗口 owner 改登记都要经过同一套窗口工厂）。

## 设计

### 存储

`<应用数据>/window-state.json`（`internal/windowgeom`，原子写）：

```json
{
  "version": 1,
  "windows": {
    "main":  {"x": 100, "y": 80, "width": 1280, "height": 800},
    "float": {"x": 1380, "y": 120, "width": 560, "height": 760},
    "debug": {"x": 420, "y": 620, "width": 780, "height": 460, "maximised": false}
  }
}
```

- **按窗口角色（main/float/debug）而不是窗口名做 key**：窗口名随打开顺序变化（这次的 `main-2` 下次可能是另一个工作区），按名字存会让位置在重启后错位。
- **额外主窗口不单独持久化**：`main-2` / `main-3` 只从 `main` 的还原矩形按 28px 级联，避免叠在同一位置；只有当前 primary 主窗口写入 `main`。
- 坐标一律是**物理像素**（与 Wails `Position()` / `Size()`、`Screen.PhysicalWorkArea` 同一口径），避免多显示器不同 DPI 下的 DIP 换算误差。

### 还原收敛（`windowgeom.Normalize`）

创建窗口时用保存的矩形，但先按当前屏幕布局收敛：

- 尺寸不小于窗口最小尺寸，且不超过所在工作区（从 4K 屏回到笔记本不会留一个巨大的窗口）。
- 与所有工作区几乎不相交（显示器被拔掉）→ 按主屏收敛尺寸并居中。
- 否则把位置夹到「标题栏可见 + 至少 160×48 在屏内」，防止窗口只剩一条边可点。

首个窗口在 `wailsApp.Run()` 之前创建，此时 v3 还没枚举显示器（`ScreenManager` 为空）。所以创建时先应用原矩形，`windowReady`（首屏导航完成、窗口仍隐藏）再按当前布局收敛一次并 `SetPosition/SetSize`；这是一次性的，后续 HMR/重载不会把用户拖过的窗口拉回初始位置。后续窗口（浮窗、调试台、新主窗）创建于 Run 之后，创建时即可收敛。

### 采集与落盘

- `events.Windows.WindowDidMove` / `WindowDidResize` / `WindowMaximise` / `WindowUnMaximise` 钩子采集（移动事件本身有 50ms 防抖）。
- 移动/缩放后 500ms 防抖写盘；**关窗前同步采集 + flush**，拖拽刚结束就关窗也不会丢；进程退出再兜底 flush 一次。
- 最大化时只置 `maximised` 标记，保留最大化前的还原矩形（最大化状态的 Position/Size 是屏幕尺寸，不能当还原尺寸）。
- 最小化/全屏时跳过采集。
- 浮窗「收起」（只留标题栏）时跳过采集：收起高度是 UI 程序化调整，不是用户偏好；收起/展开由前端经 `SetWindowCollapsed(ctx, bool)` 同步，保证下次打开仍是收起前的展开尺寸。

### 同批修复的浮窗关闭语义（v2 进程级假设遗留）

v2 里一个窗口就是一个进程，`runtime.Quit` 只关自己；v3 一进程多窗口后它是应用级退出。同批修正：

- 独立调试台的关闭改走按调用方窗口的 `ForceClose`（兜底 `WindowClose`），不再退出整个应用。
- 主窗口标题栏 X 改为 `WindowClose` 优先，重新经过 `WindowClosing`（托盘隐藏、脏数据/AI 回合确认、最后一个主窗口收口）。
- 显式退出（菜单/托盘）不能直接 `Application.Quit`（它不经过 `WindowClosing`）：`QuitApp` 汇总全部窗口与进程级任务，无风险直接 `ForceQuitAll`，有风险发 `app-quit-request` 复用关窗确认框。
- 生命周期口径：**最后一个主窗口关闭 = 退出程序**，带走浮窗/调试台（其 AI/未保存状态计入确认）；没有主窗口的模式（`--ai-float` / `--debug-console`）以最后一个窗口收口。
- 应用级服务（托盘/MCP/插件服务/工作区监听）收口抽成幂等的 `teardownAppServices`，只在应用退出时执行一次；关浮窗不再误停后台服务。
- 独立调试台窗口是无边框的，头部补拖动区（`body.console-only .dbg-head`），按钮 no-drag；停靠模式不受影响。
- 护栏 `frontend/test/core/window-close-semantics.test.mjs` 钉住这些路径。

### 最大化恢复

`windowReady` 在首屏导航完成后按保存的 `maximised` 决定 `Show()` 还是 `Maximise()`。主窗口仍走原有的 `showWindowWhenReady`（等 120ms 让任务栏图标有窗口线程余量）；浮窗/调试台直接显示或最大化。

## 明确不做（本期）

- **多入口打包（Vite main/float/console 分离）**：浮窗的大头是 AI 面板本体及其依赖链，多入口省不掉；代价是两套 bootstrap、每窗口 URL 与 `go:embed` 改动，以及每个新功能都要维护两条入口。先实测浮窗冷启动与内存，数字难看再谈。
- **float 隐藏任务栏 / 打开不抢焦点**：需要先定恢复路径（最小化后从哪里找回）与产品语义；两者都是窗口选项的一行开关，留到有结论时再做。
- **AI 面板跨窗迁移**：先定「回合状态归谁」，否则关浮窗就断流。
- **终端 tear-off**：下一期，复用现有 owner 路由（`?mode=terminal&term=<id>` → 重放 `TermRead` 环形缓冲 → `RegisterEventOwner` 改登记 → 主窗关标签，ConPTY 不断）。

## 验证

- `internal/windowgeom` 表驱动测试：可见区保留、拔屏居中、尺寸收敛、标题栏夹回、无屏幕降级、最大化标记保留、存储往返/损坏回退。
- 根包测试：角色 key（首次/级联/额外主窗口不覆盖）与持久化 key 规则。
- Go 全量测试、`tools/check-crossbuild.ps1`（linux/darwin `-tags purego`）、生产构建。
- GUI 烟测（独立 `APPDATA` + 独立单实例 ID）：主窗口移动→关窗→重启还原；`--ai-float` 浮窗移动→重启还原；最大化→关窗→重启保持最大化且还原矩形未被屏幕尺寸覆盖；`--new-window` 第二实例级联 28px 且只写 `main`；构造 (5000,3000) 的离屏存档→启动后收敛到主屏居中（DPI 150% 下实测物理坐标 (780,334)）。
