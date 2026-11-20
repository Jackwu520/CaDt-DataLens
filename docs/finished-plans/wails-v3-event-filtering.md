# Wails v3 多窗口事件过滤方案

> 状态：**已实施**（P1：`core/app-events.js` + `core/event-scope.js`，48 处订阅迁移 + 守卫测试；P2：`app-open-ai-session` 等窗口作用域事件接入）；P3 后补：`event_owner.go` + `RegisterEventOwner` 让 term/cmd/run/browser/reading 流事件按 id 定向发射，前端 `onWindowOrBroadcast` 接收（创建竞态仍走广播兜底）
> 依据：`docs/reports/wails-v3-p0-spike.md`（P0 实测：`window.EmitEvent` 确认广播，#6608 未修；`WailsEvent.sender` 可用）
> 关联：`wails-v3-migration.md` §4.3 / §9（P2 首项）

## 1. 问题

v3.1.0 没有定向事件 API：`window.EmitEvent` 与 `app.Event.Emit` 都会投递到所有窗口，`CustomEvent` 只有 `sender` 字段、没有 target 字段（P0 spike 实证：主窗口发出的事件同时被 main/float 收到，`sender=spike-main`）。

当前应用是单窗口模型，全部事件都是全局广播；迁到一进程多窗口后，两类问题：

1. **正确性**：控制类事件（打开目标/设置/便签、通知激活、关闭确认）被每个窗口各执行一次——比如第二实例转发 `open-targets` 会让所有窗口同时打开同一个文件。
2. **噪音与资源**：高频流式事件（`term-out` 每 4 KiB 一块、`ai-*` 流、`run-*`/`cmd-*` 输出）广播到所有窗口。`term-out` 的消费端 `writeTermOut` 对**未注册 id 会写入 pending 缓冲**（`terminal-sessions.js:24-26`），其它窗口会为不属于自己的终端 id 持续积缓冲（有上限但纯浪费）。

## 2. 事件盘点（2026-11-20 实测 grep）

### Go 发射端（28 处 `EventsEmit` + 包级 Emit 钩子）

Go 侧实际发出的事件名（字面量 + 动态 `event` 参数）：

| 事件 | 载荷关键位 | 来源 |
| --- | --- | --- |
| `ai-chunk` / `ai-think` / `ai-toolcall` / `ai-done` / `ai-error` / `ai-retry` / `ai-param-adjust` / `ai-queue` | `sessionId` 等 | `internal/aichat`（经 `aichat.Emit` 钩子） |
| `term-out` / `term-exit` | `id`（终端会话） | `internal/terminal` |
| `cmd-out` / `cmd-exit` | `id`（命令 id） | `internal/cmdbridge` |
| `run-out` / `run-exit` | `id`（运行 id） | `internal/run` |
| `browser-nav` / `browser-title` / `browser-error` | `id`（浏览器实例） | `internal/browser` |
| `reading-search-progress` | `requestID` | `internal/reading` |
| `sched-fire` / `schedules-changed` | 任务信息 / `{changed}` | `internal/aischedule` |
| `mcp-tools-changed` / `mcp-status-changed` | 快照 | `internal/mcp` |
| `workspace-changed` | `root`/`paths`/`removed`/`present` | `internal/watch` |
| `resource-changed` | `kind`/`key`/`paths` | `internal/watch` |
| `confirm-close` | `dirty`/`aiRunning`/`terms`/`bgJobs` | `app_window.go` |
| `app-open-settings` / `app-open-memo` / `open-targets` / `ai-notify-activate` | pane / locator / targets / payload | `app_core.go`（第二实例、Toast 激活） |
| `ai-timer-fired` / `ai-timer-stopped` | `id` | `timer_app.go` |

### 前端订阅端（48 处，含动态注册）

- `main.js`：29 处（含 `ai-*` 8 个事件名的循环注册）
- `terminal/run-ui.js`：动态注册 `run-out` / `run-exit`
- `bridge/memo-term.js`：`run-out` / `run-exit`
- `reading/reading.js`：`reading-search-progress`
- `dev/mock-backend.js`：mock 发射与假 `EventsOn`（迁移时同步 sender 语义）

**死订阅**：`main.js:6272` 的 `open-files` 在 Go 侧没有任何发射点（全仓 grep 无 `Emit("open-files")`），P1 删除。

## 3. 分类（单一来源表）

| 范围 | 事件 | 过滤规则 |
| --- | --- | --- |
| **APP 全局** | `schedules-changed`、`mcp-tools-changed`、`mcp-status-changed`、`sched-fire` | 不过滤。`sched-fire` 的执行去重已由面板裁决（现有注释明确「多窗口都会收到」） |
| **工作区** | `workspace-changed` | `payload.root` 与本窗口工作区相同才接收；同工作区的多个窗口都接收 |
| **资源键** | `resource-changed` | `kind`/`key` 在本窗口已注册的资源监听集合内才接收（memo 工作区/全局、ai-sessions） |
| **会话/流式** | `ai-*`（8 个） | 按 `sessionId` 交本窗口 AI 面板判定：前台渲染只认自己 active 的会话；后台会话的通知/队列仍由面板按 session 处理（谓词由面板提供，勿在桥里硬编码） |
| **ID 归属** | `term-out`/`term-exit`、`cmd-out`/`cmd-exit`、`run-out`/`run-exit`、`browser-*`、`reading-search-progress`、`ai-timer-*` | 谓词查本窗口注册表（`sessions` / `cmdOutHandlers` / run / browser tab / requestID / timer id）；未命中直接丢弃，**不进 pending 缓冲** |
| **窗口本地** | `confirm-close`、`open-targets`、`app-open-settings`、`app-open-memo`、`ai-notify-activate` | 只接收 `sender === 本窗口名`；无 sender 的同类事件记调试日志并丢弃 |

窗口本地类必须由 Go 侧用**窗口对象**发射（`window.EmitEvent`，自带 sender）；APP 全局类继续走 `app.Event.Emit`（sender 为空）。

## 4. 设计

### 4.1 前端桥接层（新模块 `frontend/src/core/app-events.js`）

所有窗口事件订阅收口到一个桥，`rt.EventsOn` 只允许出现在桥里（+ mock-backend）。

```js
const bridge = createAppEventBridge({
  rt,                       // Wails runtime（Events.On/Off）
  getWindowName,            // () => Promise<string>，内部用 /wails/runtime.js 的 Window.Name()
  logf,                     // 调试日志（丢弃原因）
});

bridge.onApp(name, handler);              // 不过滤
bridge.onWorkspace(name, getWs, handler); // payload.root === getWs()
bridge.onOwned(name, owns, handler);      // owns(payload) === true 才分发
bridge.onWindow(name, handler);           // sender === 本窗口名
```

- **窗口名解析**：`import { Window } from '/wails/runtime.js'; await Window.Name()`（空 name = 当前 JS context 对应的窗口，v3 runtime 原生支持）。解析完成前到达的事件进入有上限的 pending 队列（≤256 条，超限丢最旧并记一条日志），解析后按注册的过滤器回放；解析失败则窗口本地类事件全部丢弃并记 error。
- **多路复用**：同一事件名只注册一次 `rt.EventsOn`，桥内部维护 handler 列表，按各自过滤器分发；`onClose`/窗口销毁时统一 `EventsOff`（v3 的 `Events.Off` 语义在 P1 接）。
- **纯函数分离**：分类表与判定放 `core/event-scope.js`（`EVENT_SCOPES` 表 + `acceptEvent(...)` 纯函数），配 `test/core/event-scope.test.mjs`；桥本身只做注册/缓冲/派发。
- **守卫测试** `test/core/event-bridge-guard.test.mjs`：
  - 扫描 `frontend/src/**`，`EventsOn(` / `rt.EventsOn(` 只允许出现在 `core/app-events.js` 与 `dev/mock-backend.js`（新事件必须经桥注册，类似 overlay Esc 守卫的口径）；
  - 每个被订阅的事件名必须存在于 `EVENT_SCOPES`（漏分类直接红）。

### 4.2 Go 侧约定

1. **窗口本地类改用窗口对象发射**（P1 需要 App 持有 v3 窗口引用）：
   - `confirm-close`：在 `beforeClose` 的窗口上下文里 `win.EmitEvent(...)`；
   - `open-targets` / `app-open-settings` / `app-open-memo` / `ai-notify-activate`：第二实例/Toast 激活先决定**唯一目标窗口**（主窗口优先；有工作区归属时按窗口注册表选），再对该窗口 `EmitEvent`；
   - 明确禁止对控制命令用 `app.Event.Emit`（会把命令广播成多份执行）。
2. **引擎事件保持 app 级发射 + 载荷 id**（`internal/` 域包不感知窗口）：前端按归属谓词过滤。这是 P1 的默认形态，零域包改动。
3. **P2 可选优化**：`term-out` 这类高频事件在创建时记录 owner 窗口名，Go 侧改用 owner window 的 `EmitEvent`（sender 仍是广播，但前端过滤退化为 sender 比较，且为未来框架修好定向留位）；是否做由双窗口实测的 CPU/内存曲线决定，不预先优化。

### 4.3 订阅端迁移（P1 一次做完）

| 文件 | 处数 | 迁移方式 |
| --- | --- | --- |
| `main.js` | 29 | 按 §3 表逐个换成 `onApp/onWorkspace/onOwned/onWindow`；`ai-*` 循环注册传 AI 面板的 session 谓词；删除 `open-files` |
| `terminal/run-ui.js` | 2（动态） | `onOwned('run-out'/'run-exit', p => runRegistry.has(p.id), cb)` |
| `bridge/memo-term.js` | 2 | 同上（run id 归属该便签面板） |
| `reading/reading.js` | 1 | `onOwned('reading-search-progress', p => p.requestID === 本窗口请求 id, cb)` |
| `dev/mock-backend.js` | 假 runtime | 发射补 `sender`（mock 窗口名），`EventsOn` 走桥 |

## 5. 验收（双窗口场景）

1. **控制命令不重复**：第二实例带文件参数 → 只有目标窗口打开文件；`--open-settings` → 只有一个窗口打开设置页；Toast 激活 → 只主窗口跳转。
2. **关闭确认**：关窗口 A 时只有 A 收到 `confirm-close`；B 无反应。
3. **终端/运行隔离**：A 的 `term-out` 只在 A 渲染；B 的 `pendingTermOut` 不出现 A 的 id（可在调试面板断言）。
4. **工作区隔离**：A 开 ws1、B 开 ws2；ws1 的文件变化只刷新 A（B 不闪 explorer）；同工作区双窗口都刷新。
5. **资源键隔离**：A 的 memo 面板不因 B 的 memo 保存而重载（除非同 scope）。
6. **AI 流**：A 会话的 `ai-chunk` 不在 B 渲染；B 的后台会话通知/队列行为不变。
7. **全局事件不误杀**：定时任务 `sched-fire` 仍被所有窗口收到、由面板去重；MCP 状态两个窗口都更新。

## 6. 风险与边界

- **过度过滤**：`sched-fire`、`mcp-*` 刻意全局；分类表是唯一裁决点，改分类必须同步表与测试。
- **窗口名解析失败**：极端情况下 `Window.Name()` 不可用 → 窗口本地类事件丢弃并记 error，不静默放行（fail-closed）。
- **同会话双窗口**：AI 面板的 `owns` 谓词必须只控制「前台渲染」，不能拦掉后台会话的通知/队列消费；实现时以面板现有 `handleEvent` 的 session 判定为准，桥只做一次预过滤。
- **窗口晚开**：新窗口初始加载不依赖历史事件（文件/工作区都走绑定拉取）；`workspace-changed` 在它注册 watcher 之前不会到达，无回放需求。
- **mock 模式**：`hasWails=false` 时桥退化为直通（不过滤），保证 `npm run dev` 行为不变。

## 7. 工作量

- 桥 + 纯函数 + 两个守卫测试：0.5 天
- `main.js` 等 48 处订阅迁移：0.5 天
- Go 侧 5 个控制事件的窗口对象发射（依赖 P1 已持有窗口引用）：0.5 天
- 双窗口手工验收与修正：0.5 天

合计约 **2 天**，计入 P1 前端块（原 1–2 天 → 2–3 天）；P2 不再单列事件改造，只保留可选的 `term-out` owner 优化。
