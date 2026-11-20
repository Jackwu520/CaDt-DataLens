# 终端弹出窗口（浮窗行为工程化第二期）

状态：**已实施**（2026-11-20，`v3-migration` 分支）

## 目标

v2 时代终端只能活在主窗口的底部面板里。Wails v3 一进程多窗口 + 流事件 owner 定向（`event_owner.go`）落地后，终端会话可以换一个窗口渲染而 ConPTY 不断——这是最能证明迁移价值的特性（共享终端表 + 跨窗口协作）。

## 机制

### 弹出（主窗口 → 独立窗口）

- 终端页签右键菜单「在独立窗口打开」→ `PopOutTerminal(ctx, id)`：Go 校验会话存在且未退出，新建 `windowModeTerminal` 窗口（900×600，无边框，terminal-only 形态），并把调用方窗口记为 `Origin`。
- Go 建窗成功后，主窗口立即卸掉该页签（`removeTermSession`）；ConPTY 会话与 64 KiB 环形缓冲全程不动。

### 装载（独立窗口）

`startTerminalWindowMode`（bridge-ui 启动编排里与调试台并列的 early-return 分支）：

1. `body.terminal-only`：隐藏应用外壳，`#terminal-panel` 铺满窗口，自建头部（标题 + 收回主窗口 + 关闭会话，头部即拖动区）。
2. `attachResumedTermSession(id, shell)` 接入会话：
   - `RegisterEventOwner('term', id)` 把流事件归属切到本窗口；
   - `TermRead(id, 20000)` 取环形缓冲快照（TermRead 上限 20k 字符，够最近几屏 + 少量回滚）；
   - **同一个同步段**里：丢弃暂存缓冲（快照已覆盖这段，防回放与缓冲双写）→ 挂载（跳过 flush）→ 写入快照；
   - 之后到达的 `term-out` 直接写入（term-out 先于挂载到达的仍走暂存兜底）。
3. 主题/字体经 `applySettings()` 套用；行列由 fit + `TermResize` 与 ConPTY 同步。

### 收回（独立窗口 → 主窗口）

- 关闭弹出窗口（头部「收回主窗口」/Alt+F4/系统关闭）：Go 在 `WindowClosing` 广播 `term-popout-closed {id, shell, target}`——`target` 是来源窗口名，来源不在了就给当前主窗口；主窗口收到后把页签接回（同一条 `attachResumedTermSession` 通路）。会话已退出/已被 `TermClose` 时不投递。
- 头部「关闭会话」：`TermClose` 后关窗；Go 查不到会话则不投递，主窗口不会复活一个死页签。
- 退出流程（`quitRequested` / 系统关机）不投递，避免往正在关闭的窗口里塞页签。

### 几何

终端窗口数量不定，几何槽位用 `"terminal"` 级联（与额外主窗口同一策略），全部写入同一槽位（最后一次移动生效）。

## 已知边界

- **AI 的 terminal 工具看的是本窗口页签**（`terminalHostApi`）：弹出期间主窗口的 AI `list/send/focus` 都看不到该会话。AI 需要时把终端收回即可。
- **`aiSessionId` 标记不跟会话走**：AI 建的终端弹出后 shell 退出，不会唤醒发起的 AI 会话。
- **拖拽 tear-off 手势未做**：入口在页签右键菜单；后续加手势时走同一条 `PopOutTerminal` 通路（手势只是另一种触发方式）。
- 回放依赖事件桥的 FIFO（快照前到达的事件进暂存、快照后到达的直接写）；极端乱序下可能重复渲染少量字符，不影响语义。

## 验证

- `terminal-popout-wiring.test.mjs`：页签菜单入口、PopOutTerminal/移除页签、接回路径（owner 切换 + 快照回放 + 暂存清理）、主窗口 target 过滤、terminal-only 启动分支。
- `window-close-semantics.test.mjs` / `event-bridge-guard.test.mjs`：事件分类与关闭语义护栏。
- Go：`PopOutTerminal` 参数校验、`geometryRestoreKey`/`geometryPersistKey` 的 terminal 槽位、全量测试与交叉编译。
- 手工回归项：弹出后输出连续、shell 状态保留（cd/环境变量）、收回后页签回原窗口、关闭会话不复活页签、多终端各自弹出。
