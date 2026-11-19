# 多窗口会话复用（跨工作区点击会话不再开新窗口）

> 状态：**已实施，待手工双窗口验收**（2026-11-19 立项；2026-11-20 评审补强协议层并定稿 rename 接管协议，同日完成 P1–P4 编码：Go 全量测试 61 包通过、前端全量 + vite build 通过；P5 文档收口完成）
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
| 工作区路径归一 | 前端 `sessionPathKey`（`shell/session-restore.js:26`，main.js 解构引入）、`ai-session-scope.js` 的 `workspaceKey` | 两侧路径比较必须同口径 |

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
    meta.json                        # {windowId, pid, workspace, startedAt, heartbeat}
                                     #（浮窗/调试控制台在根壳就不注册，无 floating 字段）
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

### 4.1 引擎 API（定稿）

```go
package windowreg

type Entry struct {
    WindowID  string `json:"windowId"`
    PID       int    `json:"pid"`
    Workspace string `json:"workspace"` // 归一化后写入；空 = 不参与匹配
    StartedAt int64  `json:"startedAt"`
    Heartbeat int64  `json:"heartbeat"`
}

// Register 建注册表实例；内部顺序固定为「先 Acquire 租约（锁文件在目录外）
// 后建目录写 meta」——防止 Sweep 在「目录已建、租约未取」的窗口期误删新窗口。
func Register(root string, entry Entry) (*Registry, error)

// Update 改工作区（打开/关闭/切换文件夹时调用），顺带刷新 heartbeat。
func (r *Registry) Update(workspace string) error

// Touch 刷新 heartbeat（后台 goroutine 每 30s 一次；写失败时 log 并 MkdirAll 自愈）。
func (r *Registry) Touch() error

// Deliver 找目标窗口并投递请求；返回被复用的 windowId（空 = 没有可用窗口）。
// 内部按 workspace 匹配 → Probe 过滤存活 → 依序投递候选。
// wait 是跨候选共享的总预算（2.5s；否则 N 个卡死候选 = 1.5s×N 假死）。
// fromWindowID 是投递方自己的 windowId，写进请求的 from 字段（调试/回执归属）。
//
// 撤回采用 claim 独占创建协议（2026-11-20 实施定稿，第三版）：
//   take 与投递方撤回对同一 <reqId>.claim 做 O_EXCL 独占创建，内核保证恰一方
//   成功——claim 到的一方拥有处置权。接管方处理完（Ack 回执）释放 claim；
//   崩溃残留由 cleanupInbox 按超龄清理。
//   演进记录：v1「remove 撤回 + 时效检查」→ v2「rename 撤回」→ v3「claim」。
//   审查竞态用例实测：Win10+ POSIX 语义下 remove+rename 与 rename+rename 都会
//   双双成功（同一文件对象可被多个预打开的句柄先后改名 / 删除挂起的文件仍可
//   被改名），双方 API 各自报成功但无法就「谁赢了」达成一致；O_EXCL 创建没有
//   「先打开再操作」的竞态窗口，跨平台成立。
//   claim 失败（已被接管）→ alive 复判区分「已接管」与「目标已退出」→ 等 ack
//   至剩余预算：ok 返回成功、mismatch 换下一候选、接管方死亡退回未接管。
//   协议保证「最多一边开窗」——宁可漏开（用户重试）也不双开。
func Deliver(root, workspace, sessionID, fromWindowID string, wait time.Duration) (string, error)

// Take 目标窗口侧取走自己 inbox 里的待处理请求（按 ts 升序，每次取一条）。
// 以 rename 原子接管（见 Deliver 注释），天然免锁、并发安全；取到后先做时效检查：
// now - ts > 3s 的请求丢弃并 ack("expired")。每次顺带清理自己 inbox 的 taken-*.json
// 与孤儿 .ack 残留。
func (r *Registry) Take() (*Request, error)

// Ack 目标窗口处理完写回执（status: ok / mismatch / expired）。
func (r *Registry) Ack(reqID, status string) error

// Sweep 清理「目录存在 + 租约无人持有」的残留窗口目录（启动时调一次）。
// 绝不清理孤儿 lease 文件（有 lease 无目录 = 可能正在注册中，误删会让该窗口
// 存活判定永久失效）；仅对 mtime 超过 24h 的孤儿 lease 兜底清理。
func Sweep(root string) (removed int, err error)
```

要点：

- **存活判定一律用租约**（`resourcelease.Probe(leasePath)`），不用 `OpenProcess` / pid 探测——崩溃后内核释放锁，天然无僵尸。`Probe` 三态（无人持有/被占/IO 错）：只有「无人持有」可删，IO 错拿不准不删。
- 多窗口同工作区：任选存活候选即可（heartbeat 只是 30s 粒度的**活性**信号，不代表「用户最近在用」，别让它承担「最近活跃」语义）；该候选回 `mismatch` 就换下一个。
- 等待 ack 用总预算上限；全程不持任何租约，避免与 `multi-instance-sync.md` §4.6/§9 的锁顺序规则冲突（Deliver 落在 L3 之外的零租约状态，已对照核实）。
- **reqId 由 Go 侧生成**（随机 hex），Take/Ack 落盘前校验文件名 token（不含路径分隔符、非 `..`）——请求文件名拼进 inbox 路径，前端可控的 reqId 含分隔符即可写到任意路径（2026-11-20 评审补强）。
- `Sweep` 会被多窗口并发触发（同时启动），删除同一残留目录的 race 用「`os.Remove` 失败忽略」吸收；测试加并发向量。
- 正常退出顺序（`Registry.Close`）：release 租约 → 删目录 → 删配对 lease（Windows 上持锁句柄未释放时删除会失败，必须先 release）。

### 4.2 Wails 绑定（`window_app.go`）

| 绑定 | 方向 | 说明 |
| --- | --- | --- |
| `WindowRegister(workspace string) error` | 前端→Go | 启动后、每次工作区变化时调（浮窗 / 调试控制台窗口在 Go 侧 `ensureWindowReg` 直接不注册，无需 floating 标记位） |
| `WindowReuseForSession(workspace, sessionID string) (string, error)` | 前端→Go | 返回复用的 windowId；空串 = 没找到，调用方开新窗口 |
| `WindowInboxTake() (json string, error)` | 前端→Go | 取一条待处理请求 |
| `WindowInboxAck(reqID, status string) error` | 前端→Go | 回执 |
| `WindowActivate() error` | 前端→Go | `runtime.WindowShow` + 置前（复用成功后目标窗口自调） |

配套：`frontend/wailsjs/` 三件由 `wails dev` / `wails build` 重新生成；`frontend/src/dev/mock-backend.js` 补同名 mock（空实现即可，dev 模式不崩）。

## 5. 生命周期接线

### 5.1 启动 / 退出

- `app_core.go` 的 `startup` 里：`windowreg.Sweep(root)` 清残留 → `windowreg.Register(...)` 取租约并写 meta → 非 Windows 平台先查 `watch.Supported()`（**`watch_other.go` 的 `watchDirectory` 返回 error 后 `Resources.Watch` 绑定仍返回 nil，goroutine 内仅 logf warn，调用方拿不到「监听不可用」信号——需要在 `internal/watch` 暴露 `Supported() bool`，平台对文件各自实现**），支持才 `Resources.Watch("window-inbox", selfWindowID, inboxDir)` → 起 30s heartbeat goroutine。
- 退出：`release()` 释放租约、删自己目录（失败无妨，下次 `Sweep` 兜底）。
- **不能复用 `watch.Resources.OnEvent`**：它已被根壳用于会话索引标脏，是单值钩子。信箱走前端监听 `resource-changed` 的 `kind === 'window-inbox'` 分支（与 memo / ai-session 同一模式）。

### 5.2 前端

| 文件 | 改动 |
| --- | --- |
| `frontend/src/main.js:3846` `openWorkspaceFolder` | 当前窗口已有工作区时，先 `await backend.WindowReuseForSession(dir, sessionId)`；拿到 windowId → 返回 `'reused'`（并把当前窗口的 AI 面板留在此处，不做任何切换）；空 → 走现有 `OpenWorkspaceForConversation` |
| `frontend/src/ai/ai-panel.js` `syncWorkspaceToSession`（`ai-panel.js:6310-6335`） | **不是零改动**：现只识别 `''`/`'window'`，`'reused'` 会落入未定义行为——加 `'reused'` 分支：不闪错、flash 一句「已在另一个窗口打开」、返回 `'window'`（让 `switchSession` 的既有短路逻辑兜住） |
| `frontend/src/main.js` 的 `openFolderWorkspace` / `closeFolder` | 工作区变化后调 `backend.WindowRegister(newWorkspace)`（含关闭时传空串，让本窗口退出可匹配集合）。`WindowRegister` 要在面板会话恢复之前生效——**实施核实：工作区最终状态变化全部收敛到 `openFolderWorkspace`（含 session-restore.js:248 的冷启动恢复路径）与 `closeFolder` 两处，`openFolderSmart` 的三条路径（同目录/另开窗/无工作区）最终都经过这两处，无需单独接线** |
| `frontend/src/main.js:6164` `resource-changed` 监听 | 新增 `payload.kind === 'window-inbox'` 分支：`take → 若请求 workspace 与 `sessionPathKey(workspaceFolder)` 一致 → 打开面板 + `bridgeSwitchSession(sessionId)` + `backend.WindowActivate()` + ack('ok')；不一致 → ack('mismatch')`；处理完立刻再 `take` 一次（一次事件可能对应多条）。**事件丢失兜底（2026-11-20 补强）**：`payload.overflow === true` 时直接 take 一轮；窗口重新获焦 / `WindowRegister` 时顺手 take 一轮（watcher 漏事件时请求不滞留） |
| 会话列表右键菜单 | ~~**强制新开出口**~~（**2026-11-20 作者裁定移除**：复用是唯一行为，右键菜单不再提供「在新窗口打开」） |
| `frontend/src/ai/ai-panel.js` | 复用窗口内切会话复用既有 `switchSession`（`ai-panel.js` 的 `switchSession` / `bridgeSwitchSession`），注意切完后 `adoptWorkspaceSession` 不应把会话切走（会话已属本工作区，走 keep 分支，`ai-session-scope.js:112`，已核实存在） |

前端调用方（`ai-panel.js` 点会话列表项的路径）需要区分返回值：`'same'` / `'current'` / `'reused'` / `'window'`，其中 `'reused'` 时不提示、`'window'` 保留现在的行为。

## 6. 边界与风险

| 风险 | 处置 |
| --- | --- |
| ack 超时（目标窗口卡住/正在生成） | 1.5s 后退化开新窗口；不重试、不弹错。**并按 claim 接管协议撤回**（见 §4.1 Deliver 注释）：take 与撤回对同一 `<reqId>.claim` O_EXCL 独占创建，恰一方得手，保证最多一边开窗——否则目标窗口迟到处理会造成「新开窗口 + 复用窗口」双开同一会话，恰好复刻本方案要消灭的问题（JetBrains 一进程模型里不存在此竞态，文件信箱必须自己补） |
| 目标窗口工作区已变（请求发出到处理之间） | 目标回 `mismatch`，投递方继续下一个候选；全失败则开新窗口（撤回已发出的请求） |
| 多窗口同工作区 | 任选存活候选；其余作为后备（mismatch 轮换） |
| 后端崩溃留下目录 | `Sweep` 按租约判定清掉；**lease 文件放目录外**：`windows/<windowId>.lease` 与目录并列，避免删目录时锁着自己的文件（resourcelease 的「锁在保护目录外」是调用方约定，包内不强制，windowreg 落实它）；多窗口同时启动并发 Sweep 的删除 race 用「失败忽略」吸收 |
| reqId 含路径分隔符写到任意路径 | reqId 一律 Go 侧生成（随机 hex），Take/Ack 落盘前校验文件名 token（2026-11-20 评审补强） |
| 非 Windows 平台 `watchDirectory` 不支持 | `internal/watch` 暴露 `Supported() bool`（平台对文件各自实现）供注册时判定——`Resources.Watch` 在不支持平台返回 nil 拿不到错误信号，不能靠它降级；信箱不可用时 `WindowReuseForSession` 直接返回空 → 退化为开新窗口（与现有 memo watch 的降级口径一致） |
| watcher 漏事件 / overflow | `payload.overflow` 直接 take 一轮；窗口获焦 / `WindowRegister` 时顺手 take 一轮兜底 |
| 隐藏/浮窗误接请求 | 浮窗、调试控制台窗口与 convert 模式在根壳 `ensureWindowReg` 一律不注册（无 floating 字段）；空 workspace 的 meta 不参与匹配 |
| 路径口径不一致导致「明明开着却匹配不上」 | 两侧都用「归一反斜杠 + 去尾斜杠 + 小写」（与前端 `sessionPathKey`，`shell/session-restore.js:26` 同口径；`ai-session-scope.js` 的 `workspaceKey` 是其超集，普通路径下结果一致）：Go 侧入库前归一，加一致性测试向量 |
| 会话 id 失效（已被删除/归档） | 目标窗口切会话失败 → ack `mismatch`，投递方开新窗口（新窗口会按 `--ai-session` 自己兜底） |
| 跨进程无用的双开（用户想要同工作区两个窗口） | ~~保留强制新开出口~~（**2026-11-20 作者裁定移除**：接受此边界——想要同工作区双开时用「新建窗口」`Ctrl+Shift+N` 自行打开） |

安全：请求文件只含 `{reqId, from, workspace, sessionId, ts}`，不接受任何命令或路径操作；`Take` 只允许读自己目录下的 inbox；reqId 由 Go 生成并校验文件名 token。

## 7. 实施分期（每期可独立回滚）

| 期 | 内容 | 验证 |
| --- | --- | --- |
| P1 | `internal/windowreg`：Register / Update / Touch / Close / Sweep + 租约存活判定 + `watch.Supported()`（平台对文件） + `windowreg_test.go`（含跨进程 helper，参考 `internal/resourcelease/resourcelease_test.go` 的 `TestMain` 子进程模式；**跑测试必须后台 + `-timeout`**，子进程递归教训见 AGENTS.md） | `go test ./internal/windowreg/` 单测：meta 原子读写、存活过滤、候选选取、残留清理、路径归一向量、reqId 文件名 token 校验、并发 Sweep、**Register 先 lease 后目录的顺序断言**、**Sweep 不删孤儿 lease / 24h 兜底清理** |
| P2 | Deliver / Take / Ack（**rename 接管协议**：take 原子 rename、时效检查 `expired`、remove/rename 双向互斥、孤儿 taken/ack 清理、总预算跨候选轮换）+ 单测 | 两进程集成：A 投递 → B rename 接管并 ack → A 拿到 windowId；超时 remove 成功（未接管）→ 返回空且请求文件已删；**remove 与 take rename 同时触发只活一个（双向互斥向量）**；B 对过期请求回 `expired`；接管后 A 等到 mismatch → 换候选；A 投递后立刻退出进程，B 在 3s 内接管则正常处理（单边无害）、超过 3s 接管则 `expired` |
| P3 | `window_app.go` 五个绑定、启动/退出钩子、heartbeat goroutine、`Resources.Watch` 登记（`Supported()` 门槛） | 手工双窗口：B 开「正文」，A 点「正文」会话 → 只有两个窗口，B 前置并切到该会话；**投递后 1s 内手动关闭 B → A 退化开新窗口且 B 的 inbox 已撤回**；投递后冻结 B（模拟流式卡顿）>1.5s → A 开新窗口，B 恢复后对过期请求回 `expired` 不切会话 |
| P4 | 前端接线（`main.js` 四处含 `openFolderSmart`）、`syncWorkspaceToSession` 的 `'reused'` 分支、右键「在新窗口打开」、`mock-backend` 同名 mock、`npm test` 登记新测试 | 前端单测锁 `openWorkspaceFolder` 四种返回值分支与 `'reused'` 在 `syncWorkspaceToSession` 的短路；dev 模式（浏览器 mock）不崩 |
| P5 | CHANGELOG / AGENTS.md 补条目；方案移入 `docs/finished-plans/` | 文档与代码一致 |

预计规模：Go 约 500–600 行（含测试），前端约 80–120 行。无新依赖，无体积影响。

## 8. 备选方案与架构对照（留档）

- **A. 按工作区派生稳定 SingleInstanceLock ID**：覆盖不了「启动后在窗口里打开工作区」，见 §1.1。
- **C. 当前窗口直接硬切换工作区**（放弃一工作区一窗口）：改动最小、不会多开，但当前窗口的标签/分屏会被换掉，且失去「两个工作区并排」的能力。`ai-session-scope.js` 的整套会话归属模型就是为「一工作区一窗口」建的，硬切换是倒退，不采纳；若复用实现成本失控可作为最后退路（切换前给确认弹窗）。
- **D. 一进程多窗口（JetBrains 模型）**：JetBrains 系所有项目窗口共享一个 JVM，复用窗口是进程内调用，不存在跨进程竞态与迟到双开——本方案的文件信箱协议（撤回/时效/ack）正是「一窗口一进程」架构下对这类竞态的必要补偿。Wails v2 单窗口 API 做不到；v3.0.0（2026-10 stable）已支持，实测迁移面与分期见 `docs/unfinished-plans/wails-v3-migration.md`。决策：**先按本方案交付（~600 行、每期可回滚），v3 迁移单独立项**；迁移到 v3 多窗口后 windowreg 可整体删除，是可抛弃的脚手架。
- **交互先例（JetBrains）**：Open Recent 点已打开项目默认**聚焦已有窗口**不重复打开（与 §2 目标行为 1 一致，方向已被业界先例验证）；同时保留显式出口 "Open in New Window"——对应本方案的会话列表右键「在新窗口打开」。JetBrains 的 Ask/记忆三选（New Window / This Window / Attach）不照搬：CaDt 只有复用/新开两态，且 §2 行为 3 已有失败退化，按「体积是第一约束」不加设置项，上线后视反馈再议。另注意 JetBrains 裸 `.lock` 文件存在性判活留下著名的 stale lock 故障（崩溃后 "already running"），本方案的租约 Probe 判活从机制上避开了它，可视为实现亮点。

## 9. 评审决议（2026-11-20）

1. **提示**：给，且放在**投递方**窗口——`flash('已在另一个窗口打开')`；目标窗口的切换本身有视觉变化，不提示。
2. **ack 等待 1.5s 保留**，叠加撤回与过期丢弃（见 §6 第一行）；「busy 预判跳过陈旧 heartbeat 候选」为可选优化，本期不做。
3. **反向焦点**（复用窗口把焦点还给源窗口）：本期不做。
4. **强制新开出口**：~~采纳~~（**2026-11-20 作者裁定移除**——当时采纳并实施为会话列表右键「在新窗口打开」绕过复用直走 `OpenWorkspaceForConversation`，落地同日裁定砍掉，复用是唯一行为）。
5. **不加 Ask/复用/新开设置项**：两态行为 + 失败退化已够，遵循体积第一约束；上线后视反馈再议。
