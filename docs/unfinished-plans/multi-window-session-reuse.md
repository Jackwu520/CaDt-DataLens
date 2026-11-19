# 多窗口会话复用（跨工作区点击会话不再开新窗口）

> 状态：**待开工**（2026-11-19 立项，方案评审中，尚未写码）
> 范围：把「点别的 AI 会话 → 另开一个窗口」改成「该工作区已有窗口就复用，没有才新开」
> 非范围：跨进程状态总线、实时双向同步、窗口内工作区硬切换（见 §8 备选方案）

## 1. 问题

用户在窗口 A（工作区 `CaDt-DataLens`）的 AI 会话列表里点「正文」工作区的某条会话时，应用会再开一个新窗口。若「正文」已经开在另一个窗口里，就变成第三个窗口。

现状代码路径（`frontend/src/main.js:3846` 的 `openWorkspaceFolder`）：

```js
if (workspaceFolder && sessionPathKey(workspaceFolder) === targetKey) return 'same';
if (!workspaceFolder) { openFolderWorkspace(dir); return 'current'; }
// 当前窗口已有工作区：不硬切换，另开窗口打开目标工作区（软切换）。
saveSessionNow();
if (backend.OpenWorkspaceForConversation) { ...backend.OpenWorkspaceForConversation(dir, sessionId)...; return 'window'; }
```

`backend.OpenWorkspaceForConversation` → `app_window.go:64` → `newwindow.OpenWorkspaceConversation`（`internal/newwindow/newwindow.go:64`）执行 `--new-window <dir> --ai-session=<id>` 拉起独立进程。**这条链上没有任何「该工作区是否已开在某个窗口」的判断，物理上也没有可用的跨进程通道。**

### 1.1 为什么「按工作区派生稳定 SingleInstanceLock ID」不够

`internal/launchargs/launchargs.go:211` 的 `UniqueIDForArgs` 在 `--new-window` 时返回 `randomLaunchID()`。若改成「有工作区路径 → 按路径哈希出稳定 ID」，Wails 会把第二进程的参数转发给同 ID 的已开窗口（`app_core.go:187` 的 `secondInstance`），确实能复用。

**但单实例锁 ID 只在进程启动那一刻注册**，之后在窗口里「文件 → 打开文件夹」改不了它。实测场景（本问题来源）：先开空白/工作区窗口 A，A 里打开「正文」——A 的 ID 仍是启动时的随机值，永远不会与「正文」的稳定 ID 相撞。该方案只能覆盖「启动时命令行就带工作区路径」的那一半，**故弃用**。

### 1.2 已有基础设施（本方案直接复用，不引入新依赖）

| 能力 | 位置 | 用法 |
| --- | --- | --- |
| 跨进程目录监听 | `internal/watch/resource.go:41` `Resources.Watch(kind, key, dir)` | 变化时 emit `resource-changed`（`:71`），前端在 `frontend/src/main.js:6164` 已统一监听 |
| 跨进程独占租约 | `internal/resourcelease`（`Acquire` / `Probe` / `Owner{PID,Label}`） | 判断「窗口进程是否还活着」——进程死掉内核自动释放，不依赖 pid 探测（pid 会复用） |
| 原子写 | `internal/atomfile` | meta.json / 请求文件落盘 |
| 应用数据根 | `internal/appdata/appdata.go:27` `Root()` | 注册表与信箱根目录 |
| 窗口激活 | `runtime.WindowShow` 等（`app_core.go` 的 `secondInstanceShow` / `showWindowWhenReady`） | 复用后把目标窗口提到前面 |
| 前端切会话 | `frontend/src/ai/ai-panel.js` 的 `bridgeSwitchSession`（消费点见 `frontend/src/bridge/bridge-ui.js:254`） | 复用窗口内打开指定会话 |
| 工作区路径归一 | 前端 `sessionPathKey`（`main.js`）、`ai-session-scope.js` 的 `workspaceKey` | 两侧路径比较必须同口径 |

约束：`docs/unfinished-plans/multi-instance-sync.md` 已定「单写者 + 多读者 + 文件变更重读，不做跨进程状态总线」。本方案沿用——注册表是文件，投递也是文件，事件仍走 `resource-changed`，**没有新增 IPC 层**。

## 2. 目标行为

1. 点别的工作区会话 → 该工作区**已有存活窗口** → 那个窗口打开该会话、前置到前台，**不新开窗口**。
2. 该工作区没有任何窗口 → 走现有 `OpenWorkspaceConversation` 新开（行为不变）。
3. 复用失败（目标窗口无响应 / 工作区已变 / 已退出）→ 退化为新开窗口，**不能卡住用户**。
4. 单窗口场景完全不变。

## 3. 磁盘布局

```
<应用数据>/windows/
  <windowId>/                        # windowId = pid + 随机后缀，一窗口一目录
    lease                            # resourcelease 独占锁文件，进程活着就持有
    meta.json                        # {windowId, pid, workspace, startedAt, heartbeat, floating}
    inbox/                           # 信箱：别的窗口写请求进来
      <reqId>.json                   # {reqId, from, workspace, sessionId, ts}
      <reqId>.ack                    # 目标窗口处理后写回：{reqId, status, windowId, ts}
```

- `windowId` 不用裸 pid（会复用），用 `pid-<随机 8 位>`。
- `meta.json` 用 `internal/atomfile` 原子替换。
- **不进「存储与清理」条目**：这是瞬时状态，启动时自清（见 §5.1）。
- `floating: true`（`--ai-float` 浮窗、调试控制台）与无工作区窗口**不参与匹配**。

## 4. Go 侧设计

新增 `internal/windowreg`（纯引擎，位置与外部动作经钩子注入，符合 `docs/finished-plans/go-layout.md` 的口径），根壳加 `window_app.go` 做 Wails 薄绑定。

### 4.1 引擎 API（草案）

```go
package windowreg

type Entry struct {
    WindowID  string `json:"windowId"`
    PID       int    `json:"pid"`
    Workspace string `json:"workspace"` // 归一化后写入；空 = 不参与匹配
    StartedAt int64  `json:"startedAt"`
    Heartbeat int64  `json:"heartbeat"`
    Floating  bool   `json:"floating"`
}

// Register 建目录、取租约、写 meta；返回 release（进程退出时调）。
func Register(root string, entry Entry) (release func(), err error)

// Update 改工作区（打开/关闭/切换文件夹时调用），顺带刷新 heartbeat。
func (r *Registry) Update(workspace string) error

// Touch 刷新 heartbeat（后台 goroutine 每 30s 一次）。
func (r *Registry) Touch() error

// Deliver 找目标窗口并投递请求；返回被复用的 windowId（空 = 没有可用窗口）。
// 内部按 workspace 匹配 → Probe 过滤存活 → heartbeat 取最近活跃 → 写 inbox → 等 ack。
func Deliver(root, workspace, sessionID string, wait time.Duration) (string, error)

// Take 目标窗口侧取走自己 inbox 里的待处理请求（按 ts 升序，每次取一条）。
func (r *Registry) Take() (*Request, error)

// Ack 目标窗口处理完写回执（status: ok / mismatch / busy）。
func (r *Registry) Ack(reqID, status string) error

// Sweep 清理「租约无人持有」的残留目录（启动时调一次）。
func Sweep(root string) (removed int, err error)
```

要点：

- **存活判定一律用租约**（`resourcelease.Probe(leasePath)`），不用 `OpenProcess` / pid 探测——崩溃后内核释放锁，天然无僵尸。
- 多窗口同工作区：按 `heartbeat` 取最近活跃那个；它回 `mismatch` 就试下一个候选。
- 等待 ack 用 1.5s 上限；超时返回空 windowId（调用方退化开新窗口）。全程不持任何租约，避免与 `multi-instance-sync.md` §9 的锁顺序规则冲突。

### 4.2 Wails 绑定（`window_app.go`）

| 绑定 | 方向 | 说明 |
| --- | --- | --- |
| `WindowRegister(workspace string) error` | 前端→Go | 启动后、每次工作区变化时调（`floating` 由 Go 侧按 `--ai-float` 自己判） |
| `WindowReuseForSession(workspace, sessionID string) (string, error)` | 前端→Go | 返回复用的 windowId；空串 = 没找到，调用方开新窗口 |
| `WindowInboxTake() (json string, error)` | 前端→Go | 取一条待处理请求 |
| `WindowInboxAck(reqID, status string) error` | 前端→Go | 回执 |
| `WindowActivate() error` | 前端→Go | `runtime.WindowShow` + 置前（复用成功后目标窗口自调） |

配套：`frontend/wailsjs/` 三件由 `wails dev` / `wails build` 重新生成；`frontend/src/dev/mock-backend.js` 补同名 mock（空实现即可，dev 模式不崩）。

## 5. 生命周期接线

### 5.1 启动 / 退出

- `app_core.go` 的 `startup` 里：`windowreg.Sweep(root)` 清残留 → `windowreg.Register(...)` 取租约并写 meta → `watch.Resources.Watch("window-inbox", selfWindowID, inboxDir)` → 起 30s heartbeat goroutine。
- 退出：`release()` 释放租约、删自己目录（失败无妨，下次 `Sweep` 兜底）。
- **不能复用 `watch.Resources.OnEvent`**：它已被根壳用于会话索引标脏，是单值钩子。信箱走前端监听 `resource-changed` 的 `kind === 'window-inbox'` 分支（与 memo / ai-session 同一模式）。

### 5.2 前端

| 文件 | 改动 |
| --- | --- |
| `frontend/src/main.js:3846` `openWorkspaceFolder` | 当前窗口已有工作区时，先 `await backend.WindowReuseForSession(dir, sessionId)`；拿到 windowId → 返回 `'reused'`（并把当前窗口的 AI 面板留在此处，不做任何切换）；空 → 走现有 `OpenWorkspaceForConversation` |
| `frontend/src/main.js` 的 `openFolderWorkspace` / `closeFolder` | 工作区变化后调 `backend.WindowRegister(newWorkspace)`（含关闭时传空串，让本窗口退出可匹配集合） |
| `frontend/src/main.js:6164` `resource-changed` 监听 | 新增 `payload.kind === 'window-inbox'` 分支：`take → 若请求 workspace 与 `sessionPathKey(workspaceFolder)` 一致 → 打开面板 + `bridgeSwitchSession(sessionId)` + `backend.WindowActivate()` + ack('ok')；不一致 → ack('mismatch')`；处理完立刻再 `take` 一次（一次事件可能对应多条） |
| `frontend/src/ai/ai-panel.js` | 复用窗口内切会话复用既有 `switchSession`（`ai-panel.js` 的 `switchSession` / `bridgeSwitchSession`），不需要新逻辑；注意切完后 `adoptWorkspaceSession` 不应把会话切走（会话已属本工作区，走 keep 分支） |

前端调用方（`ai-panel.js` 点会话列表项的路径）需要区分返回值：`'same'` / `'current'` / `'reused'` / `'window'`，其中 `'reused'` 时不提示、`'window'` 保留现在的行为。

## 6. 边界与风险

| 风险 | 处置 |
| --- | --- |
| ack 超时（目标窗口卡住/正在生成） | 1.5s 后退化开新窗口；不重试、不弹错 |
| 目标窗口工作区已变（请求发出到处理之间） | 目标回 `mismatch`，投递方继续下一个候选；全失败则开新窗口 |
| 多窗口同工作区 | 按 heartbeat 取最近活跃；其余作为后备候选 |
| 后端崩溃留下目录 | `Sweep` 按租约判定清掉；租约文件在目录外还是内需在实现时定（建议 `windows/<windowId>.lease` 与目录并列，避免删目录时锁着自己的文件） |
| 非 Windows 平台 `watchDirectory` 不支持 | 信箱不可用时 `WindowReuseForSession` 直接返回空 → 退化为开新窗口（与现有 memo watch 的降级口径一致） |
| 隐藏/浮窗误接请求 | `floating` 与空 workspace 一律不登记 |
| 路径口径不一致导致「明明开着却匹配不上」 | 两侧都用「归一反斜杠 + 去尾斜杠 + 小写」：Go 侧入库前归一，前端 `sessionPathKey` 同口径；加跨端一致性测试 |
| 会话 id 失效（已被删除/归档） | 目标窗口切会话失败 → ack `mismatch`，投递方开新窗口（新窗口会按 `--ai-session` 自己兜底） |

安全：请求文件只含 `{reqId, from, workspace, sessionId, ts}`，不接受任何命令或路径操作；`Take` 只允许读自己目录下的 inbox。

## 7. 实施分期（每期可独立回滚）

| 期 | 内容 | 验证 |
| --- | --- | --- |
| P1 | `internal/windowreg`：Register / Update / Touch / Sweep + 租约存活判定 + `windowreg_test.go`（含跨进程 helper，参考 `internal/resourcelease/resourcelease_test.go` 的 `TestMain` 子进程模式；**跑测试必须后台 + `-timeout`**，子进程递归教训见 AGENTS.md） | `go test ./internal/windowreg/` 单测：meta 原子读写、存活过滤、最近活跃选取、残留清理、路径归一向量 |
| P2 | Deliver / Take / Ack（含超时与 mismatch 轮换）+ 单测 | 两进程集成：A 投递 → B 取到并 ack → A 拿到 windowId；超时返回空 |
| P3 | `window_app.go` 五个绑定、启动/退出钩子、heartbeat goroutine、`Resources.Watch` 登记 | 手工双窗口：B 开「正文」，A 点「正文」会话 → 只有两个窗口，B 前置并切到该会话 |
| P4 | 前端接线（`main.js` 三处）、`mock-backend` 同名 mock、`npm test` 登记新测试 | 前端单测锁 `openWorkspaceFolder` 四种返回值分支；dev 模式（浏览器 mock）不崩 |
| P5 | CHANGELOG / AGENTS.md 补条目；方案移入 `docs/finished-plans/` | 文档与代码一致 |

预计规模：Go 约 500–600 行（含测试），前端约 80–120 行。无新依赖，无体积影响。

## 8. 备选方案（未采纳，留档）

- **A. 按工作区派生稳定 SingleInstanceLock ID**：覆盖不了「启动后在窗口里打开工作区」，见 §1.1。
- **C. 当前窗口直接硬切换工作区**（放弃一工作区一窗口）：改动最小、不会多开，但当前窗口的标签/分屏会被换掉，且失去「两个工作区并排」的能力。若评审认为复用成本偏高，可退回到这一档，并在切换前给确认弹窗。

## 9. 待评审确认

1. 复用成功时给不给提示（建议：只在状态栏 flash 一句「已在另一个窗口打开」，不弹窗，参照 `flash` 的既有用法）。
2. ack 等待上限取 1.5s 是否合适（目标窗口正在流式生成时可能更慢；可考虑 `busy` 状态直接返回失败而不等）。
3. 是否需要**反向能力**：在复用窗口里把源窗口的焦点还回去（建议本期不做）。
