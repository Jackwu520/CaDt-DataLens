# 多实例同步：资源租约 + 变更重读（方案）

> 状态：**已实施收尾**（2026-11-21 P6 完成，移入 finished-plans）。
> P1–P5：2026-11-18 落地（sessionlock / resourcelease / sessionstore / memo / AI 面板 / 资源 watch / 存储清理门闩）。
> P6（2026-11-21，随窗口归属重构批次）：① 会话回合租约进程内重入改按「归属窗口名」分桶——v3 同进程双窗口各自 startSessionTurn 同一会话不再被 refcount 放行成双回合（原收缩范围外的同进程缺口，与 memo 租约同类）；② 群聊 `group:<id>` 讨论租约落地（`internal/aigroups/lease_service.go`：根门闩共享 + 群独占，粒度=整场讨论，跨窗口 busy →「群聊正在另一窗口讨论」，暂停态不长期占锁、恢复重取）；③ 窗口关闭按归属释放回合/群租约（`releaseWindowOwnedState`）。
> v3 同进程多窗口的「单写者」语义由窗口归属重构批次补齐（memo 跨窗口 Busy / 监听按窗口键控，见 `window-ownership-refactor.md`）；「手动开第二个进程」场景的语义不变。
> 决策：锁优先。**单写者 + 多读者 + 文件变更重读**，不做双向合并、不做 CRDT、不做跨进程状态总线。
> 死锁复核结论（先说结果）：**崩溃不会死锁**（内核释放）；**卡死会锁住资源，这是有意选择**（不做 TTL，不做强制抢锁）；真正需要设计规避的是**跨资源 ABBA、manager 全局锁跨 IO、终态写盘未完成就交接、锁文件被清理**四类，方案见 §4.6 与 §9。
> 范围：通用资源租约包 · 快捷便签（全局/工作区）打开即独占 · AI 会话回合锁 · 根门闩与销毁保护 · 资源目录 watch 与前端重读 · 索引标脏
> 非范围：普通文件保存（已有 mtime CAS + 冲突对话框）· `ai-config.json` 等配置文件的并发写 · 跨窗口 `session_send` · 强制抢锁

## 1. 背景与现状（代码事实）

### 1.1 多窗口 = 多进程，没有跨进程事件总线

- 新窗口由 `internal/newwindow` 拉起独立进程（`--new-window`），`uniqueIDForLaunch` 每次生成新的 SingleInstanceLock ID（`internal/launchargs/launchargs.go:211-221`）。窗口间没有共享内存、没有 Wails 事件通道——Wails 的 `EventsEmit` 只在本进程内广播。
- 不带 `--new-window` 的第二次启动才会把参数转发给同 UniqueID 的现有实例（`app_core.go:169` 的 `secondInstance`）；`--new-window` 窗口之间不转发。
- 目前唯一的跨窗口感知手段是文件系统：工作区 watcher 发 `workspace-changed`（`internal/watch/watch.go:29`），便签工作区作用域靠它重读；全局便签只在窗口 focus 时对账（`frontend/src/bridge/bridge-memo-view.js:1382-1387`）。

### 1.2 便签：整份 CAS，冲突即丢本地改动

- `memo.Load` 返回 `{data, mtimeMs}`，`memo.Save` 做 mtime CAS（`internal/memo/memo.go:72-149`）；mtime 比读入时新、或文件被删/被建，都返回 `conflict`。
- 前端收到冲突就删缓存、重读磁盘并广播（`frontend/src/bridge/memo-store.js:103-109`）——**本窗口自上次读盘以来的输入全部丢弃**。
- 两个窗口都打开全局便签时，双方都可编辑；防抖 1s 使“后写者赢、先写者被重载”的窗口很小，但真实存在，且丢的是用户的字。
- 工作区便签有 `workspace-changed` 兜底（`bridge-memo-view.js:1372-1380`）；全局便签没有 watcher，只在 focus 时重读。

### 1.3 AI 会话：只有单次写锁，没有“回合写者”

- `sessionstore.withSessionLock` 在每次 append/rewrite/meta 写入时取跨进程独占锁（`internal/sessionstore/sessionstore.go:126-139`），5s 等待；文件级写入是安全的。
- 但**没有“谁在跑这个会话”的概念**：两个窗口可以同时 `startSessionTurn` 同一会话。后果不是 JSONL 损坏，而是：
  - 两边各自基于打开时的上下文生成，消息交错追加；
  - `writeMetaIfChanged` 的 `messageCount` / `title` / `updatedAt` 最后写者覆盖（`frontend/src/ai/ai-session-disk.js:221-231`）；
  - 派生索引的 `OnBodyChange` / `OnMetaChange` 钩子只在写入进程触发（`sessionstore_app.go:13-16`），另一个进程的 `ai-index.db` 不会标脏。
- 前端已有的忙检查只在进程内：`streamOf(session.id) || compactOf(session.id)`（`ai-panel.js:10541`、`:10585`）。跨窗口不可见。
- 流式消息不落盘：`ai-session-disk.js:317` 明确跳过 `status === 'streaming'` 的消息。因此跨窗口“实时镜像”天然只能看到已完成的消息，不能按 token 同步。
- **写路径不止“当前回合”**：`persistSessions()` 会遍历所有会话逐个 `persistSession`（`ai-panel.js:2244-2257`），`persistSession` 又可能写日志与 meta（`ai-session-disk.js:238-260`）。也就是说，窗口 A 跑会话 S 时，也可能顺手写窗口 B 正在跑的会话 X 的 meta。只给 S 加回合锁不够，**所有会话写路径都要受租约约束**（见 §6.3 的 Go 层兜底）。
- 群聊方案已把“多窗口同群并发”列为 v1 已知限制，并预留了“群级活动锁/单写者”（`docs/finished-plans/ai-group-chat.md:992`）。

### 1.4 已有可复用件

| 能力 | 位置 | 复用方式 |
| --- | --- | --- |
| 跨进程独占锁 | `internal/sessionlock`（Windows `LockFileEx` / 其他平台 `flock`） | 新增 TryLock 与共享锁语义后作为租约底层 |
| 原子替换 | `internal/atomfile` | 写 owner 元数据 |
| 目录变更通知 | `internal/watch`（Windows `ReadDirectoryChangesW`） | 扩成按资源目录 watch |
| 便签 CAS | `internal/memo` | 保留为第二道防线 |
| 文件保存冲突对话框 | `frontend/src/main.js:4029-4055` | 普通文件不改，仅作为口径参考 |
| 会话工作区归属判定 | `frontend/src/ai/ai-session-scope.js` | 不变，继续防 `activeSessionId` 跨工作区串台 |

### 1.5 问题清单

1. 便签双写：后写者覆盖，先写者的输入被冲突重载丢掉。
2. 便签全局作用域没有变更通知，另一窗口只能等 focus。
3. 会话双回合：上下文交错、meta 覆盖、索引不标脏。
4. 会话的非回合写路径（`persistSessions` 扇出、改名、归档、删除）没有跨进程互斥。
5. 锁文件、资源目录可能被存储清理/回收站操作在持锁期间移走。
6. 没有统一的“资源写者”概念；以后群聊、子代理、定时任务还会各自踩一遍。
7. 不能靠“合并”解决：便签是整份 JSON，会话是追加事件流，语义合并代价远高于锁。

## 2. 目标与非目标

### 2.1 目标

1. **每个可写资源同一时刻只有一个写者**；其他窗口可以读，但不能写。
2. 写者崩溃/关窗后，锁由内核自动释放，不留下需要手工清理的死锁。
3. 读者能知道“谁在写”，写者释放后能重新读取并接管，不丢已提交的数据。
4. 多窗口冲突从“静默覆盖/丢改动”变成“明确的只读/忙提示”。
5. 原语可复用：便签、AI 会话、群聊、后续其他共享资源共用一套租约，不各写一套。
6. **任何锁路径都不能把应用挂死**：嵌套获取一律非阻塞；锁等待有上限；manager 不在全局锁内等 IO；卡死的唯一后果是资源被占，用户结束进程即可恢复。

### 2.2 非目标

- 不做 CRDT / OT / 双向合并。
- 不做全局窗口注册中心、命名管道、WM_COPYDATA 广播或中央 hub 进程。
- 不做“强制抢锁”或租约 TTL 自动过期（原因见 §9.1）。
- 不改变普通文件的保存路径（现有 mtime CAS + `openSaveConflictDialog` 足够）。
- 不把 `ai-config.json`、设置、插件配置纳入本次范围（它们仍是原子写 + 最后写者赢）。
- 不解决跨窗口 `session_send`：该工具当前只认本进程内存里的 `sessionById`（`ai-agent-notices.js:430`）。

## 3. 总体模型

### 3.1 三层职责

1. **租约（权威）**：操作系统文件锁。决定谁可以写；不看文件内容，不做业务判断。
2. **Owner 提示（展示）**：锁旁边的 `.owner` 文件，写 PID / 窗口标签 / 开始时间，只用于“另一窗口正在编辑”的提示。
3. **变更通知（刷新）**：目录 watch → 前端重读。只解决读者看到新数据的时间，不解决写冲突。

> 只做 1 不做 3：读者会一直停在旧内容。
> 只做 3 不做 1：冲突暴露更频繁，仍然会丢改动。
> 1 + 3 的组合才是“多实例同步”的最小闭环。

### 3.2 资源矩阵

| 资源 | 键 | 写权限粒度 | 锁文件（在被保护目录之外） | 读者刷新 |
| --- | --- | --- | --- | --- |
| 全局便签 | `memo:global` | 面板打开 → 关闭 | `<appdata>/memo.lock` | 目录 watch + focus |
| 工作区便签 | `memo:workspace:<ws>` | 面板打开 → 关闭 | `<ws>/.cadt/memo.lock` | 已有 `workspace-changed` |
| AI 会话 | `session:<id>` | 回合开始 → 终态写盘完成 | `<appdata>/ai-sessions/.locks/<id>.turn.lease` | 会话目录 watch + focus |
| AI 会话根 | `sessions-root` | 销毁/清理期间 | `<appdata>/ai-sessions.gate` | 不需要（只挡写） |
| 群聊（后续） | `group:<id>` | 一次群发言/回合 | `<appdata>/ai-groups/.locks/<id>.turn.lease` | 复用会话 watch 模式 |
| 群聊根（后续） | `groups-root` | 销毁/清理期间 | `<appdata>/ai-groups.gate` | 不需要 |

锁文件放在**被保护目录之外**的稳定位置：目录被改名、移走、回收时锁文件不跟着走，新写者仍用同一把锁，不会出现“旧目录的锁 + 新目录的新锁文件”双持有。

### 3.3 为什么是“锁 + 重读”，不是“同步”

- 便签的写入单位是整份文档，两个窗口的修改没有可定义的合并语义；强行 merge 需要逐块 diff + 冲突 UI，成本与收益倒挂。
- 会话是追加事件流，文件级 append 已经安全；真正的冲突是“两个回合交错”，这是执行权问题，不是数据合并问题。
- 租约把并发问题降级为“排队/只读”，读者只需要在写者提交后重读一次，逻辑简单、可测试、崩溃安全。

### 3.4 状态机

便签：

```
未加载 --打开面板--> tryAcquire
  ├─ 成功 --> 可编辑（持锁）
  │            ├─ 关闭面板/切作用域/关窗 --> flush --> release
  │            └─ 冲突（外部手改） --> 重载磁盘（仍持锁）
  └─ busy --> 只读（显示 owner）
               ├─ focus / watch 变化 --> reloadExternal
               ├─ 定时 probe --> 锁空 --> 重读磁盘 --> 可编辑
               └─ 锁仍被占 --> 保持只读
```

会话回合：

```
空闲 --发送/重试/压缩--> acquire(root shared + session exclusive)
  ├─ 成功 --> 重读陈旧日志（交接协议）--> 运行中
  │            ├─ 终态写盘完成 --> release
  │            ├─ 写盘失败 --> 保持锁并报错（不交接半成品）
  │            └─ 进程崩溃 --> 内核释放
  └─ busy --> 拒绝“另一窗口运行中”
               └─ 读者 watch 到变化 + probe 锁空 --> 重读日志
```

## 4. 资源租约层 `internal/resourcelease`

### 4.1 底层 `sessionlock` 扩展

现有 `LockFile(path, timeout)` 超时返回普通错误，调用方无法区分“锁被占”与“IO 错误”，且只有独占模式。新增：

```go
// internal/sessionlock/lock.go
var ErrLocked = errors.New("资源写锁已被占用")

// TryLockFile 非阻塞抢独占锁：锁被占返回 ErrLocked；其它错误原样返回。
// 内部允许一个很短的 CreateFile 竞态重试（≤100ms），避免瞬时 ACCESS_DENIED
// 被误报成 busy（lock_windows.go:13-21 已记录该竞态）。
func TryLockFile(path string) (*FileLock, error)

// TryLockFileShared 非阻塞抢共享锁：多个进程可同时持有，独占请求会被挡。
func TryLockFileShared(path string) (*FileLock, error)

// LockFileShared 带超时的共享锁，语义与 LockFile 对应。
func LockFileShared(path string, timeout time.Duration) (*FileLock, error)
```

- `LockFile` 保持现状，现有 `sessionstore` / `activity` / `aiworklog` / `aigroups` 调用不动。
- Windows：共享锁 = `LockFileEx` 不带 `LOCKFILE_EXCLUSIVE_LOCK`；独占 = 带；都带 `LOCKFILE_FAIL_IMMEDIATELY`，失败归一成 `ErrLocked`。
- 非 Windows：`flock` 的 `LOCK_SH` / `LOCK_EX`；`EWOULDBLOCK` / `EAGAIN` 归一成 `ErrLocked`。
- 不改锁文件权限、不删锁文件、不动 `FILE_SHARE_DELETE`。
- 句柄不可继承（Windows `CreateFile` 的 `sa=nil`；Unix Go `os.OpenFile` 默认 `O_CLOEXEC`），避免子进程替父进程“继承”锁。

### 4.2 租约 API

```go
// Package resourcelease：跨进程资源写权租约。
// 职责只有三件：互斥、进程内重入、owner 提示。它不认识便签/会话。
package resourcelease

type Owner struct {
    PID       int    `json:"pid"`
    Label     string `json:"label,omitempty"`     // 前端传入的窗口标签，截断到 200 字符
    StartedAt int64  `json:"startedAt"`           // Unix ms
    Version   int    `json:"v"`                   // owner 文件格式版本，当前 1
}

type Mode int

const (
    Exclusive Mode = iota
    Shared
)

type Lease struct {
    path string
    mode Mode
    // 内部由 manager 维护 refs
}

// BusyError 表示锁被另一个进程（或同进程的另一种模式）持有。
type BusyError struct{ Owner Owner }

func (e *BusyError) Error() string // "资源正在另一窗口编辑（PID 1234）"

// Acquire 非阻塞获取独占租约；同一进程重复获取走 refcount，直接成功。
func Acquire(lockPath string, owner Owner) (*Lease, error)

// AcquireNoShare 非阻塞获取独占租约；本进程已有任何 ref 时也返回 busy。
// 只给删除/清理这类破坏性操作用——不能借 refcount 共享把别人正在写的资源删掉。
func AcquireNoShare(lockPath string, owner Owner) (*Lease, error)

// AcquireShared 非阻塞获取共享租约；共享租约不写 owner 文件。
func AcquireShared(lockPath string) (*Lease, error)

// AcquireWait 带超时获取独占租约，只允许后台任务在“不持有其它租约”时使用。
func AcquireWait(lockPath string, owner Owner, timeout time.Duration) (*Lease, error)

// Release 递减 refcount；归零时释放内核锁。重复调用是 no-op。
func (l *Lease) Release()

// Probe 仅用于 UI：临时尝试抢独占锁——
//   成功：说明锁空，立即释放，返回 (Owner{}, false)
//   失败：读 owner 文件，返回 (owner, true)
// 不要用 Probe 的结果做写入决策，真正的决策一律走 Acquire。
func Probe(lockPath string) (Owner, bool)
```

### 4.3 进程内 refcount 与锁的实现纪律

- `internal/sessionlock/lock_windows_test.go:65-81` 已证明：**同一进程的第二个句柄也会被 `LockFileEx` 拒绝**。没有 refcount，面板持锁时同进程的 AI 工具/后台任务会自己把自己锁死。
- manager 采用 **per-key 状态 + 每键一把互斥锁**，不是“一把全局锁罩住所有 IO”：

```go
type keyState struct {
    mu        sync.Mutex // 只保护本 key 的获取/释放，不跨 IO
    shared    int
    exclusive int
    lock      *sessionlock.FileLock
    owner     Owner
}

var (
    mu    sync.Mutex              // 只保护 map，不跨 IO
    held  = map[string]*keyState{} // key = 规范化后的锁路径
)
```

实现纪律：

1. `Acquire*` 先在全局 `mu` 下取/建 `keyState`，随即释放全局锁；再锁 `keyState.mu` 做真正的 OS 抢锁。**全局锁内不做 `CreateFile`/`LockFileEx`**。
2. `AcquireWait` 持有 `keyState.mu` 等待 OS 锁；这是安全的——若本进程已有同 key 的 ref，直接共享返回，不会进入等待；若 ref 为 0，本进程没有待释放的持有者，因此不会被自己的 `Release` 卡住。不同 key 的获取/释放完全不受影响。
3. 同进程同 key：
   - 已有 `shared>0`：`AcquireShared` 直接 +1；`Acquire`（独占）**失败**（不允许升级）。
   - 已有 `exclusive>0`：`Acquire` 可 +1（同一种写者重入）；`AcquireShared` **失败**（不能借 refcount 绕过根门闩的销毁独占）。
   - 破坏性操作（删除/清空/存储清理）用 `AcquireNoShare`：本进程有任何 ref 都失败，避免“同进程另一个协程正在写”被 refcount 掩盖。
   - 都没有：真正抢 OS 锁。
4. `Release` 在 `keyState.mu` 下递减；两种计数都归零时释放 OS 锁，再从 map 删除。`Lease` 句柄记 `released` 标志，重复 `Release` 是 no-op 并记一条 debug 日志；refcount 不允许为负。
5. key 规范化：`filepath.Clean` + 绝对路径；Windows 再 `strings.ToLower`。避免 `D:\ws` 与 `d:\ws` 被当成两把锁。
6. 不做“同进程二次获取时复用另一个 key 拼写”的兜底：路径解析统一走 `memo.LeasePath` / `sessionstore.LeasePath`，从源头保证一致。

> 为什么不用一把全局 manager 锁：`AcquireWait` 可能等 2s，`CreateFile` 在网络盘上可能等更久；全局锁会把所有资源的获取/释放串在这一个等待上，形成“一个慢盘卡死全应用”的伪死锁。per-key 隔离后，最坏只卡住该资源。

### 4.4 Owner 元数据

- 路径：`<lockPath>.owner`（如 `<appdata>/memo.lock.owner`、`<id>.turn.lease.owner`）。
- 获取成功后用 `atomfile.WriteFileAtomic` 写 JSON；**释放时不删除 owner 文件**，下次获取直接覆盖。
  - 不删的原因：删 owner 与“后来者写入”存在竞态；锁文件可能已被外部删除/目录被移动，按路径删除可能误删新持有者的 owner。留着是安全的——`Probe` 永远先抢锁，锁空时忽略 owner 文件。
- 内容只用于展示，不参与判定；锁是否被占一律以 `TryLockFile` 为准。
- 进程崩溃留下的陈旧 owner 文件无害：锁已由内核释放，`Probe` 会返回“空”；下次获取覆盖。
- 共享租约（根门闩）不写 owner：多个持有者，写一个会误导；独占的销毁操作才写。
- `PID` 会复用，不能当身份；`Label` 由前端传入（如工作区路径 + 窗口类型），Go 侧截断并去掉换行/控制字符。

### 4.5 锁文件生命周期与根门闩

- **锁文件放在被保护目录之外**的稳定位置（同级 `.lock` 或 `.locks/`），不放在会被整体移动/回收的目录里：
  - 目录被改名/移动/删除时，锁文件不跟着走；新写者仍然用同一把锁，不会出现“旧目录的锁 + 新目录的新锁文件”两把锁。
  - 锁文件是 0 字节（byte-range 锁只锁首字节），不占用可感知空间；被删除资源的锁文件可以留着，同 id 复用反而是正确的（避免删除/重建之间出现空窗）。
- **不删除锁文件**。删除会与其它进程的 `CreateFile(OPEN_ALWAYS)` 抢竞态，收益为零。
- 会话目录整体进回收站时，锁文件不受影响；`FILE_SHARE_DELETE` 已保证目录删除不被锁句柄阻塞。
- **销毁/清理操作必须拿根门闩**：
  - `ai-sessions`：门闩 `<appdata>/ai-sessions.gate`（在根目录之外，根被改名/移动也不失效）。
  - 会话回合/所有会话写路径：对同一门闩取**共享**锁。
  - `AISessionDeleteAll` / 存储清理 `ai-sessions`：取**独占**锁（`AcquireNoShare`，本进程有回合/写路径也拒绝）；拿不到就拒绝，不等待。
  - 群聊根同理：`<appdata>/ai-groups.gate`。
- **删除单个会话**：取根共享 + 会话独占（删除动作本身用 `AcquireNoShare`，本进程有回合/写路径时也拒绝）；删除目录时持锁，删完释放。会话锁在 `<root>/.locks/<id>.turn.lease`，不在被删目录里，所以“删完立刻重建同 id”仍会撞同一把锁。
- **销毁根的顺序**（避免“目录被移走后又新建出来”的竞态）：
  1. 取根独占（挡掉所有写者；门闩在根外，不随根移动）；
  2. 把根目录改名成 `<root>.deleting-<timestamp>`（原子移走）；
  3. 释放根独占；
  4. 把改名后的目录送回收站/删除。
  这样新写者只会创建新的根，不会碰旧目录；旧目录在改名后不再有写者。
- 根门闩的获取全部**非阻塞**（`AcquireShared` / `Acquire`），不参与 `AcquireWait`：根目录被改名时，等待者不会拿着旧门闩在旧目录上继续操作。
- `memo` / `ws-memo` 的清理同理：锁文件在目录外；取独占租约 → 把目标目录改名成 `<dir>.deleting-<timestamp>` → 释放 → 回收站；不要边持锁边长时间移动目录。
- 锁文件被外部程序删除时，互斥会失效（新进程会在新文件上拿到锁）——这是所有路径锁的固有边界。应用自身不删锁文件；存储清理与回收站操作走上面的门闩与改名流程。

### 4.6 锁层级与死锁不变量

固定层级，只允许从低到高获取：

```
L0 根门闩（shared：回合/写；exclusive：销毁/清理）
L1 资源租约（memo / session / group，exclusive）
L2 sessionstore .session.lock（单次文件写）
L3 atomfile 临时文件/rename（无锁）
```

不变量：

1. **持有任何租约/文件锁时，不允许阻塞等待另一个租约**。嵌套获取一律 `Acquire`/`AcquireShared`（非阻塞）；`AcquireWait` 只允许在没有其它租约时使用。
   - 唯一例外：根门闩的**共享**锁。持根共享时等待目标会话独占是安全的——根独占（销毁/清理）不会反向等待任何会话租约，且根共享与其它回合兼容；除此之外一律非阻塞。
2. 获取顺序只能 L0 → L1 → L2；禁止反向，禁止 L1 → 另一个 L1 的阻塞等待。
3. 释放顺序与获取相反；终态写盘完成后才释放（§6.4）。
4. manager 的全局 map 锁内不做 IO；等待只在 per-key 锁内。
5. `Release` 幂等，refcount 不为负；不允许“释放别人的租约”。
6. 共享锁不能升级为独占；需要升级时先释放再重新获取（销毁操作直接拒绝即可）。
7. 不做 TTL、不做强制抢锁；进程存活即持锁，进程退出即释放。
8. 破坏性操作一次只持有一个资源门闩；多目标清理串行执行，避免 ABBA。

> 第 1 条是跨资源死锁的唯一根治手段。典型 ABBA：窗口 A 持有会话租约 → AI 调 `add_memo` 想拿便签锁；窗口 B 持有便签锁 → 用户发消息想拿同一会话租约。两边都阻塞就死锁；非阻塞时双方各自得到 busy，用户稍后重试即可。

## 5. 快捷便签：打开即独占

### 5.1 锁路径与生命周期

- `internal/memo` 新增导出：

```go
// LeasePath 返回作用域对应的租约文件路径；scope/workspace 校验与 Load/Save 共用 resolveRoot。
func LeasePath(scope, workspace string) (string, error)
```

- 全局：`<appdata>/memo.lock`；工作区：`<ws>/.cadt/memo.lock`（都在被保护的 memo 目录之外）。
- 锁文件需要父目录存在：`MemoLeaseAcquire` 内部对锁文件父目录做幂等 `MkdirAll`（`<appdata>` 或 `<ws>/.cadt`）；`<appdata>/memo` 本身仍由 `atomfile` 在写盘时创建。
- 清理 `<appdata>/memo` / `<ws>/.cadt/memo` 时，锁文件在目录外，改名/回收不会让新写者绕过。
- 持有者：打开便签面板的窗口。面板 dispose、切作用域、切换/关闭工作区、关窗时释放。
- 释放前必须 `flush` 当前作用域的防抖保存（`memo-store.js` 的 `flush` / `flushAll`）。若保存失败，**保持锁**并提示；用户可选择重试或明确放弃后释放。
- 面板关闭后不继续持有：关掉面板即让出编辑权，别的窗口可以编辑。

### 5.2 前端 store 状态与 Go 层兜底

`frontend/src/bridge/memo-store.js` 的 cache 增加：

```js
{
  doc, mtimeMs, dirty, timer, scope, workspace,
  writer: false,        // 本窗口是否持有租约
  readOnly: false,      // 未持有且已加载
  owner: null,          // {pid,label,startedAt}
}
```

- `load(scope)`：先读盘（只读也允许加载），再尝试 `MemoLeaseAcquire`；成功置 `writer=true`，busy 置 `readOnly=true` 并记录 owner。
- `mutate(scope, fn)`：`readOnly` 时直接返回 `{ok:false, error:'快捷便签 正在另一窗口编辑'}`，不改内存、不排定时器。面板按钮与 AI 的 `add_memo` / `update_memo` / `remove_memo` 共用这一条路径。
- `scheduleSave` / `flushAll`：只处理 `writer=true` 的 cache；只读 cache 不写。
- `reloadExternal`：只读态照常工作；有 `dirty` 时跳过（现有语义保留）。
- 接管成功：先 `load(..., {force:true})` 重读磁盘，更新 `mtimeMs`，再置 `writer=true` / `readOnly=false`，避免拿旧缓存直接写。
- 释放：`flush(scope)` 成功后调 `MemoLeaseRelease(scope, workspace)`；失败则保留 `writer=true` 并把错误 flash 出来。
- **busy 与 conflict 分开处理**：`SaveResult.Busy` 只表示“另一窗口持有写权”，不要走 conflict 的“删缓存并重载”路径（那会丢掉本窗口内容）；保留 cache 与 dirty，提示“另一窗口正在编辑，稍后重试”。只有 mtime CAS 的 `Conflict` 才重载磁盘。
- **Go 层兜底**：`memo.Save` / `memo.SaveImage` 在真正写盘前也取同一把租约（同进程 refcount，面板持锁时零成本）；拿不到返回 `SaveResult{Busy:true}`。这样即使某条前端路径漏了只读判断，也不会绕过锁写盘。

### 5.3 只读视图

- 便签面板顶部显示一条只读横幅：
  `只读：快捷便签正在另一窗口编辑（PID 1234 · D:\work\foo）。关闭那边的面板后可在此编辑。`
- 如果持有者进程已无响应，横幅补一句：`若该窗口已无响应，请结束该进程（PID 1234）`。不做强制抢锁。
- v1 **不提供“接管”按钮**。抢锁需要另一个进程配合，属于第二套通信机制；先不做。
- 只读时隐藏/禁用新增、编辑、删除、拖拽排序、贴图粘贴入口；正文仍可滚动、复制、导出。
- 只读窗口在以下时机重试接管：
  - 窗口 `focus`；
  - 收到该作用域的 `resource-changed`（全局）或 `workspace-changed`（工作区）；
  - 只读横幅可见时每 2–3s 尝试 `MemoLeaseAcquire`（不是`Probe`——它想直接接管）。
- 拿到锁后自动切回可编辑并重读；用 `flash('快捷便签 已可在本窗口编辑')` 提示，不弹窗。

### 5.4 没开面板的 AI 写入

- AI 工具可能在便签面板没打开时写便签。规则：
  1. 本窗口已持有该作用域租约 → 直接写；
  2. 未持有 → `Acquire` 短租约（非阻塞）；拿到后执行变更，**立即 `flush`**，再释放；
  3. 拿不到 → 返回工具错误 `快捷便签正在另一窗口编辑，本次未写入`，不要绕过锁直接写。
- Go 层 `memo.Save` 的兜底会让第 3 条在更底层也成立（即使前端忘了判断）。
- 短租约不跨防抖窗口：AI 写入路径改为“变更 → 立即 flush → 释放”，避免定时器在无锁状态下落盘。

### 5.5 刷新

- 工作区作用域：继续用现有 `workspace-changed`（`memoOnWorkspaceEvent`，`bridge-memo-view.js:1372`），路径含 `.cadt/memo/memo.json` 才重读。
- 全局作用域：新增对 `<appdata>/memo` 的目录 watch，事件到达时 `reloadExternal('global')`；watch 不可用时保留 focus 对账（现有 `memoOnWindowFocus`）。
- 写者自己也会收到文件事件：`writer=true` 时忽略（或 `reloadExternal` 因内容相同静默返回），避免无意义重绘。

### 5.6 CAS 保留

- mtime CAS 不删：外部编辑器手改 `memo.json`、旧版本窗口写入、锁降级等场景仍需要它兜底。
- 单写者生效后，正常的双窗口冲突不应再出现；CAS 冲突变成异常路径，仍按现有逻辑重载并提示。
- 若以后要支持“两个窗口都能编辑”，必须先定义合并语义；不在本方案内。

### 5.7 行为变化

- 从“两个窗口都能编辑，后写者赢”变为“后开面板的窗口只读”。
- 用户可见提示与 CHANGELOG 需要明确写：多窗口下便签是单写者，关闭编辑窗口的面板即可在另一窗口编辑。

## 6. AI 会话：回合锁（不是打开锁）

### 6.1 粒度选择

建议锁**回合**，不锁“打开”：

- 读会话永远允许：JSONL 是追加式，读不会破坏数据；用户经常需要在一个窗口看、另一个窗口干活。
- 定时任务、信箱唤醒、自动压缩可能在没开面板的窗口里跑；打开即独占会把无人值守能力挡死。
- 真正的冲突是“两个回合同时写同一会话”，回合锁正好覆盖。

如果后续产品上要求“第二个窗口完全只读、不能跑回合”，把策略换成 open-lease 即可，底层原语不变；代价是后台任务需要额外通道，不在 v1。

### 6.2 锁路径

- `internal/sessionstore` 新增：

```go
// LeasePath 返回会话回合租约路径；id 走 ValidSessionID 校验。
func (s *Store) LeasePath(id string) (string, error)

// RootGatePath 返回该 Store 根的门闩路径（与根目录同级，如 <appdata>/ai-sessions.gate）。
func (s *Store) RootGatePath() string
```

- 路径：`<appdata>/ai-sessions/.locks/<id>.turn.lease`（与 `.session.lock` 分开：后者是单次写入的文件锁，前者是回合语义锁）。
- 根门闩：`<appdata>/ai-sessions.gate`（在 `ai-sessions/` 之外，根被改名/移动时不失效），回合持有共享，销毁/清理持有独占。
- 会话锁放在 `.locks/` 而不是会话目录里：删除会话目录不会把锁一起删掉，同 id 重建仍会撞同一把锁。`.locks/` 由 `LeasePath` 幂等 `MkdirAll`。

### 6.3 获取点与交接协议

| 操作 | 获取方式 | 失败表现 |
| --- | --- | --- |
| `startSessionTurn`（用户发送/重试/后台唤醒） | 根共享 + 会话独占，在第二次忙检查之后、写 `session.messages` 之前 | 返回 `{ok:false, reason:'other_window'}` |
| `startCompact` / 自动压缩 | 根共享 + 会话独占 | 跳过本次压缩，下一轮再试 |
| 改名 / 归档 / 删除 / 清空 / rewrite | 短租约（根共享 + 会话独占），完成即释放 | 报“会话正在另一窗口运行” |
| 子代理回合 | 子代理自己的会话 id 取租约（`runSubRound` 路径复用 `startSessionTurn`） | 同上 |
| 群聊回合 | `group:<id>` 租约（后续阶段） | 同上 |
| `persistSessions` 的扇出写 | 每条实际要写的会话取短租约（Go 层兜底同样生效） | busy 则跳过本轮，状态保持待重试 |

**交接协议（锁定后、写之前必须做）**：

1. **同进程先等上一轮排空**：`await sessionStore.whenIdle(id)`；上一轮终态写盘未完成时先等，失败则拒绝起轮（`save_failed`），避免把尚未落盘的消息从内存里重读掉。
2. `AISessionLeaseAcquire(id)` 在持锁状态下返回日志的 `{mtimeMs, size}`；同时检查日志/会话目录是否存在。
   - 新建会话（`_logCreated=false`）允许不存在；
   - 已知存在的会话日志/目录缺失 → 说明被删除，释放租约并报 `session-not-found`，**不要通过 Append 的 `MkdirAll` 把它重建出来**。
3. 与前端记录的 `session._logStat` 比较；不一致说明另一个窗口在上一次回合后写过：
   - **必须整份重读会话日志**（`AISessionRead` + replay），重建 `messages` / `_mids` / `_archivedMids` / `_fps`，再更新 `_logStat`。
   - 重读失败 → 释放租约并中止本轮，不能拿旧内存状态直接写。
4. 重读完成后才允许改 `session.messages`、执行 retry/edit 的截断、落用户消息。
5. 之后每次持久化成功更新 `_logStat`；下一回合再次比较。

> 为什么必须重读：`runPersistSession` 用内存里的 `_mids` 算共同前缀并可能追加 `truncate` 事件（`ai-session-disk.js:300-327`）。如果另一个窗口已经追加了消息，而本窗口还拿着旧前缀，retry/edit 的 truncate 会把对方的消息截掉。仅靠“同一时刻一个回合”不够，**新回合必须在最新日志上开始**。

**Go 层兜底（防御 `persistSessions` 扇出与漏网调用）**：

- `sessionstore.withSessionLock` 的顺序改为：`EnsureRoot`（幂等 mkdir）→ 根共享 → **会话独占** → `ensureSessionDir` → `.session.lock`；固定 L0 → L1 → L2。先拿会话锁再确保目录，避免“删除正在移走目录、写者又把空目录建回来”的复活窗口；根目录不存在时先建根再拿门闩，避免操作已改名的旧根。
- 同一进程的回合已持有租约时，refcount 让这层兜底零等待；别的窗口持有回合租约时，这里的短租约返回 busy（错误前缀 `session-busy:`），调用方按“跳过并重试”处理，不弹用户错误。
- 这样即使 `persistSessions` 遍历到别的窗口正在跑的会话，也不会写进去；即使某条前端路径忘了取租约，底层也不会双写。
- `AISessionSaveImage` / `AISessionSaveVideo` 同样取根共享 + 会话独占。

### 6.4 释放点与终态写盘

**释放必须晚于终态写盘**，不能只挂在“逻辑回合结束”上：

- 流正常结束：`finishStream` 触发 `detachStream`（`ai-panel.js:11104-11137`），但 `persistSessions()` 是 fire-and-forget（`ai-panel.js:2244-2257`）。释放要改成异步任务：
  1. `await sessionStore.flush()`（或新增 `whenIdle(id)` 只等该会话的队列尾）；
  2. 成功 → 释放租约；
  3. 失败 → **保持租约**并提示“会话保存失败，已阻止其他窗口写入；请重试或关闭该窗口”。
- 流错误：`finishStreamError` → `finishStream`，同上。
- 用户停止/抢占/重试截断：最终都走 `detachStream`，同上。
- 压缩结束：`finishCompact`（`:13836`）先等 `archiveSession`（返回 `enqueue` promise）与这次 persist 完成，再释放；压缩取消：`cancelOneShot` 没有写盘则直接释放，有排队写盘则等 flush。
- 启动失败/早退：`try/finally` 释放；如果还没写任何东西，直接释放。
- 进程崩溃：内核释放（无需清理代码）。

实现建议：把 `Lease` 挂到 stream / oneShot 对象上，统一走 `releaseTurnLease(id)`；该函数内部先等队列尾再 `Release`。不要在每个分支散落 `Release`。

**注意现有错误会被吞掉**：`ai-session-disk.js` 的 `enqueue` 用 `.catch(onError)` 把失败吞成了 resolved promise（`ai-session-disk.js:43-53`），所以 `flush()` 正常返回**不代表写盘成功**。交接用的 `whenIdle(id)` 必须返回 `{ok, error}`：在 `enqueue` 的 catch 里记录该会话最后一次错误，或让 `persistSession` 返回结果对象；`releaseTurnLease` 只有 `ok=true` 才释放，否则保持租约并提示。

**为什么写盘失败要持锁**：失败后 `ai-session-disk.js` 会恢复日志记账，等待下一次重试（`restoreLogState`）。如果此时交接，另一个窗口追加了新消息，本窗口的重试可能基于旧前缀追加 truncate，截掉对方的消息。宁可让资源暂时不可写，也不交接半成品。

### 6.5 Busy 语义与队列

- 新增 reason：`other_window`，与同进程的 `busy` 区分。
- 用户发送遇到 `other_window`：
  - 不静默排队（对方可能跑几分钟），把文本留在输入框，显示 `该会话正在另一窗口运行，请稍后再试`。
  - 现有 `ai-message-queue.js` 对 `busy` 的“重新入队”只用于同进程竞态；`other_window` 不进入自动重试，避免无限循环。
- 后台唤醒/定时任务遇到 `other_window`：
  - 当前前端后台唤醒用非阻塞获取（`startSessionTurn` 的 lease timeout=0）：拿不到就把通知退回信箱/队列，由下一次唤醒/用户消息再试，不阻塞 UI 线程；`AcquireWait` 保留给 Go 侧独立定时任务或未来入口。
  - 记录一条 debug 日志（谁持有、哪个会话），便于排查“定时任务没跑”的原因。
- 压缩遇到 `other_window`：跳过本次，自动压缩下一轮再试；手动压缩提示用户。
- `persistSessions` 扇出遇到 `session-busy`：跳过该会话，保留待持久化状态；不要 repeated toast。
- 持久化失败：保持租约并提示；用户可重试/关闭窗口。不要让失败路径静默释放。

### 6.6 只读窗口的刷新

- 会话成为当前会话时 `AISessionWatch(id)`，监听 `<id>/session.v1.jsonl` 与 `meta.json`；切走/关面板 `AISessionUnwatch(id)`。
- 收到变化时：
  1. 本窗口正在该会话跑流/压缩 → 忽略（自己的写入）。
  2. 先看 owner 文件：不存在 → 大概率锁空；存在 → `Probe` 确认。
  3. busy → 显示“另一窗口运行中”，1s 后重试；
  4. free → 比较日志 `{mtime,size}` 与 `_logStat`；变了才防抖 250ms 后重读。
- **不要中途整份重载**：流式消息不落盘（`ai-session-disk.js:317`），中途重载只会看到半截轮次。等租约释放后再重读一次，语义最干净。
- `Probe` 会短暂持有锁：两个读者同时 probe 时可能互相看到 busy。处理：probe 只在 owner 文件存在时做，每 2–3s 至多一次，busy 且 owner 为空/过旧时 50ms 后重试一次；它只影响提示，不影响真正的写决策。
- 大会话（接近 64 MB 上限）重读成本高：v1 先整份重读；若实测卡顿，再评估按字节偏移增量解析（需要 `AISessionReadFrom(id, offset)` 绑定）。不要为了增量先改存储格式。
- 会话列表的跨窗口刷新：v1 只在窗口 focus 时重读 `AISessionList`；不为整个 `ai-sessions/` 根目录挂递归 watch（事件量大、收益低）。

### 6.7 索引标脏

- 写者进程的 `AISessionAppend` 会触发 `OnBodyChange` → `sessionindex.MarkDirty`（`sessionstore_app.go:13`）。
- 读者进程收到外部日志变化时，需要在**本进程**也标脏，否则搜索索引一直是旧的：
  - 由根壳在 `AISessionWatch` 的 Go 回调里调 `sessionindex.MarkDirty(id)`；
  - 或在绑定层暴露 `AISessionMarkDirty(id)` 由前端调用。
- 建议前者，但 **watch 回调必须快**：`MarkDirty` 走 SQLite，不能阻塞 watcher 线程；丢进一个有界 goroutine/队列异步执行，失败只记日志。

### 6.8 后台任务与群聊

- 定时任务、信箱唤醒、自动压缩都走 `startSessionTurn` / `startCompact`，自然复用回合锁。
- 群聊的共享 JSONL 目前只有单次 append 锁；多窗口同群并发是已知限制（`ai-group-chat.md:992`）。后续用 `group:<id>` 租约覆盖整个群发言/主持人讨论，避免两个窗口同时主持。
- 子代理会话 id 独立，主会话租约不覆盖子代理；`runSubRound` 必须对自己的会话取租约。
- 后台任务获取租约时**不持有任何其它租约**；如果它在某个回合内部被调用（例如 AI 工具触发 `session_send`），对目标会话只做非阻塞获取，busy 就投递失败/入队，不等待。

### 6.9 备选：open-lease

若坚持“第二个窗口打开同一会话即只读”：

- 会话面板激活/打开时 `Acquire`，关闭时释放；
- 第二个窗口只读，不能发送、不能压缩、不能改名；
- 后台任务在无窗口持有租约时才能跑；窗口开着会话时定时任务会被挡住。

实现成本比回合锁低，但会牺牲无人值守场景。本方案默认回合锁，open-lease 作为配置项/后续决策，不在 v1 实现。

## 7. 变更通知层

### 7.1 `internal/watch` 扩展

现有 `Watcher` 只维护一个工作区根（`watch.go:6-12`）。新增一个独立的资源监听器，避免影响工作区语义：

```go
// ResourceWatcher 按资源 key 监听一个目录；与工作区 Watcher 相互独立。
type ResourceWatcher struct { /* map[key]*watchState */ }

func (w *ResourceWatcher) Watch(key, dir string, recursive bool) error
func (w *ResourceWatcher) Unwatch(key string)
func (w *ResourceWatcher) StopAll()
```

- 复用 `watchDirectory`（Windows `ReadDirectoryChangesW`；非 Windows 返回“不支持”）。
- 回调里发 `resource-changed`：

```json
{
  "kind": "memo" | "ai-session",
  "key": "global" | "workspace:<ws>" | "<sessionId>",
  "paths": ["memo.json"],
  "overflow": false
}
```

- 监听失败（非 Windows / 权限 / 网络盘）不阻塞业务：绑定返回错误或空操作，前端退回 focus/轮询。
- 回调线程只做“过滤 + emit”；索引标脏、重读等放到异步任务。

### 7.2 前端订阅

- `main.js` 启动时注册一次 `resource-changed` 监听，按 `kind` 分发：
  - `memo` → `memoStore.reloadExternal(scope)`；
  - `ai-session` → 会话刷新逻辑（见 §6.6）。
- 只处理当前打开的 memo 作用域 / 当前会话；其他 key 直接忽略。
- 事件本身不做业务判断，所有“是否重读/是否忙”的判定留在域模块。

### 7.3 非 Windows 回退

- `watch_other.go` 的 `watchDirectory` 返回不支持；`ResourceWatcher.Watch` 返回错误但不断言失败。
- 前端保留：
  - 窗口 focus 重读（全局便签已有，会话新增）；
  - 只读/“另一窗口运行中”状态下 2–3s `Probe` + 重读。

## 8. 绑定与接线

### 8.1 Go 绑定（根壳薄包装）

| 绑定 | 作用 |
| --- | --- |
| `MemoLeaseAcquire(scope, workspace, label string) (resourcelease.LeaseStatus, error)` | 非阻塞取便签租约；busy 返回 owner |
| `MemoLeaseRelease(scope, workspace) error` | 释放（同进程 refcount 递减） |
| `MemoLeaseStatus(scope, workspace) (resourcelease.LeaseStatus, error)` | 可选，只读横幅/定时 probe 用 |
| `AISessionLeaseAcquire(id, purpose, label string, timeoutMs int) (resourcelease.LeaseStatus, error)` | 回合/短操作取根共享 + 会话独占；`timeoutMs=0` 非阻塞 |
| `AISessionLeaseRelease(id) error` | 释放 |
| `AISessionLeaseStatus(id) (resourcelease.LeaseStatus, error)` | Probe，用于“另一窗口运行中”提示 |
| `AISessionStat(id) (sessionstore.LogStat, error)` | 交接协议比较 `{mtimeMs,size}` |
| `MemoWatch(scope, workspace) error` / `MemoUnwatch(scope, workspace) error` | 全局便签目录 watch |
| `AISessionWatch(id) error` / `AISessionUnwatch(id) error` | 会话目录 watch，并异步标脏索引 |

- `LeaseStatus` 结构建议：

```go
type LeaseStatus struct {
    Acquired bool                `json:"acquired"`
    Owner    resourcelease.Owner `json:"owner,omitempty"`
    Stat     LogStat             `json:"stat,omitempty"` // 持锁时读取的日志状态，交接协议用
}

type LogStat struct {
    MtimeMs int64 `json:"mtimeMs"`
    Size    int64 `json:"size"`
}
```

- **路径只由 Go 侧解析**：绑定接收 `scope/workspace/id`，不接收任意路径；`memo.LeasePath` / `sessionstore.LeasePath` 内部做越界与 id 校验。
- owner `label` 由前端传（工作区路径 + 窗口类型），Go 侧截断到 200 字符、去掉控制字符；它只用于展示。
- 根门闩不单独暴露绑定：`AISessionLeaseAcquire` 内部取共享，`DeleteAll`/存储清理内部取独占。

### 8.2 存储清理的保护钩子

- `internal/storage` 不 import `sessionstore`/`memo`；通过注入钩子拿门闩：

```go
// internal/storage
type Service struct {
    // BeforeClear 在真正删除某个条目之前调用；返回 release 必须 defer 执行。
    // 实现方（根壳）按 spec id 解析到 memo/session 租约；busy 时返回错误，条目记为“正在使用”。
    BeforeClear func(entryID, workspaceRoot string) (release func(), err error)
}
```

- 根壳注入：
  - `memo` → 全局 memo 独占租约（`memo.LockForClear`，内部 `AcquireNoShare`）；
  - `ws-memo` → 工作区 memo 独占租约（同上）；
  - `ai-sessions` → `ai-sessions` 根门闩独占（`sessionstore.LockRootForClear`，`AcquireNoShare`）；
  - `ai-groups`（后续）→ 群聊根门闩独占。
- 清理多条目时**串行**：取一个门闩 → 把目标目录改名 → 释放 → 送回收站 → 下一个。不并行持有多个资源锁，避免 ABBA；也不在持锁期间做长时间移动。
- `StorageClear` 的结果里把“正在使用，未清理”作为该条目的错误/状态返回，前端原样展示。
- `AISessionDeleteAll`（设置页/AI 面板）走同一根门闩，不能绕过存储清理钩子。

### 8.3 前端改动

| 文件 | 改动 |
| --- | --- |
| `frontend/src/bridge/memo-store.js` | cache 增加 writer/readOnly/owner；`mutate` 只读拒绝；`flush` 后释放；接管前强制重读；AI 写入短租约 + 立即 flush |
| `frontend/src/bridge/bridge-memo-view.js` | 面板 open/dispose/切作用域时 acquire/release；只读横幅与控件禁用；watch 事件接线 |
| `frontend/src/bridge/bridge-memo-view.js`（`memoOnWindowFocus`） | 只读态重试 acquire；拿到后重读 |
| `frontend/src/ai/ai-panel.js` | `startSessionTurn` 取回合租约 + 交接重读；`other_window` 文案；`detachStream` / `finishCompact` / `cancelOneShot` 等终态写盘后释放；会话 watch 与刷新 |
| `frontend/src/ai/ai-session-disk.js` | 写路径短租约（或依赖 Go 兜底）；持久化 busy 跳过；失败保持待重试；日志 `_logStat` 维护 |
| `frontend/src/main.js` | 注册 `resource-changed` 监听并分发 |
| `frontend/src/dev/mock-backend.js` | 补 `MemoLease*` / `AISessionLease*` / `AISessionStat` / `*Watch` 同名 mock |
| `frontend/wailsjs/` | 由 `wails dev` / `wails build` 重新生成（含 App.js / App.d.ts / models.ts） |

### 8.4 测试登记

- Go 测试与前端测试按仓库规则登记；前端测试放 `frontend/test/<域>/` 并加入 `npm test` 清单。
- 新增纯逻辑（如 busy reason 映射、只读状态机、交接 stat 比较）优先抽纯函数，避免在 `ai-panel.js` 里堆不可测代码。

## 9. 死锁、卡死与异常

### 9.1 为什么不用 TTL 自动过期

- 自动释放租约会让一个“暂停后恢复”的写者变成第二个写者：
  - 便签有 mtime CAS，尚可用“冲突 → 重读”兜底；
  - 会话是追加流，没有 fencing token；一个暂停的回合恢复后继续 append，必然与接管者交错。要给会话加 TTL，必须在每条 append/meta 里带租约代次并由 Go 侧校验，成本远高于本方案。
- 因此锁的生命周期就是**进程生命周期**：进程活着 = 锁有效；进程退出/被杀 = 锁释放。卡死的进程由用户结束，而不是自动抢锁。
- 代价：卡死窗口会暂时占住资源。缓解：owner 文件显示 PID/工作区；日志记录持锁时长；提示用户结束无响应进程。

### 9.2 场景矩阵

| 场景 | 是否死锁 | 结果与处理 |
| --- | --- | --- |
| 进程崩溃 / 被杀 / 掉电 | 否 | 内核关闭句柄，锁释放；陈旧 owner 被忽略/覆盖 |
| 进程卡死但仍存活 | 否（但资源被占） | 锁不释放（有意）；横幅显示 PID；用户结束进程后恢复 |
| WebView 崩溃但 Go 进程存活 | 否（但资源被占） | `pagehide` / `OnBeforeClose` 尽力释放；最终进程退出释放；不做 TTL |
| 同进程重入（面板 + AI 工具 + 后台） | 否 | refcount；共享租约只加计数 |
| 跨资源 ABBA（会话锁内写便签 / 便签窗口发消息） | 若阻塞则会 | **禁止持有租约时阻塞获取另一租约**；嵌套一律非阻塞，busy 返回业务错误 |
| manager 全局锁跨 OS 等待 | 若实现不当会 | per-key 锁；全局 map 锁内不做 IO |
| `.turn.lease` 与 `.session.lock` 反序 | 若实现不当会 | 固定 L0→L1→L2；禁止先 `.session.lock` 再取租约 |
| 两个读者同时 Probe | 短暂假忙 | Probe 低频 + 50ms 重试一次；只影响提示，不影响写决策 |
| 网络盘 CreateFile 挂起 | 进程卡在 IO | per-key 隔离，不拖累其它资源；前端异步/超时提示；必要时结束进程 |
| 锁文件被外部删除 | 互斥可能失效 | 应用不删锁文件；文档警告；资源目录删除走门闩 + 改名流程 |
| 存储清理 / 回收站与持有者并发 | 数据可能丢/目录重建 | 清理前取根门闩或资源租约；busy 拒绝；根目录先改名再删 |
| 磁盘满 / 权限错 / 只读盘 | 否 | 取锁失败 → 只读/拒绝写；owner 写失败不阻塞；保存失败保持锁并提示 |
| 终态写盘未完成就交接 | 不是死锁，但会截断对方消息 | 释放前 `await whenIdle(id)` 并检查 `ok`；失败保持锁 |
| 回合中等待用户回答/长工具 | 资源长时间被占 | 语义正确；另一窗口显示 owner；可在持有窗口停止；watchdog 最终收尾 |
| 混合版本窗口 | 旧窗口绕过租约 | 升级说明注明；CAS/append 锁兜底；不承诺跨版本互斥 |

### 9.3 崩溃、挂起与 WebView 崩溃

- 崩溃：`LockFileEx`/`flock` 随进程退出释放；owner 文件残留无害；读者下次 `Probe` 看到锁空。
- 挂起：锁继续被持有，**这是安全属性**，不是 bug。不提供应用内“强制释放”（会制造双写）；用户可结束进程（任务管理器）。owner 横幅显示 PID，便于定位。
- WebView 崩溃：前端没机会调 `Release`，但 Go 进程还在，锁仍被持有。处理：
  - 页面 `pagehide` / `beforeunload` 尽力释放 UI 持有的租约（不释放后台任务的）；
  - 窗口关闭流程 `OnBeforeClose` 先 flush 后释放；
  - 最终兜底是进程退出。不要用 TTL 解决这个边缘场景。
- 日志：`resourcelease` 注入 `Logf`，记录 acquire/release/busy/wait 超时；长持有（>30 分钟）打一条 warn，便于事后排查“为什么一直被占”。

### 9.4 跨资源 ABBA 与嵌套获取

- 典型链路：
  - 窗口 A：回合租约 S → AI 工具 `add_memo` → 便签租约 M；
  - 窗口 B：便签租约 M → 用户发送到会话 S → 回合租约 S。
- 如果两边都 `AcquireWait`，就是 ABBA 死锁。规则：
  - 持有任何租约时，嵌套获取一律非阻塞；busy 直接返回业务错误（AI 工具报“便签忙”，发送报“会话在另一窗口运行”）。
  - `AcquireWait` 只允许在“没有持有其它租约”的后台入口使用（定时任务、信箱唤醒的最外层）。
  - 唯一例外是“根共享 → 会话独占”的两级获取：根共享是兼容锁，根独占（清理）不会反向等待会话租约，因此 `AISessionLeaseAcquire` 可以在根共享下短等目标会话；等待超时仍返回 busy。
  - 需要两个资源同时可写的能力（例如批量操作两个便签作用域）拆成串行两步，不嵌套。
- Go 层的写兜底（`Append` 内部取短租约）也遵守同一规则：外层已有租约时走 refcount；跨进程 busy 立即返回；它本身只带 ≤100ms 的 CreateFile 竞态重试，不做长时间等待。

### 9.5 锁文件被删除、目录被移动

- 应用自身不删锁文件；`FILE_SHARE_DELETE` 只用于允许“资源目录整体删除/回收”时不被句柄卡住。
- 删除单个会话：根共享 + 会话独占，删完释放。删除根：根独占 → 改名 → 释放 → 回收站（§4.5）。
- 锁文件在被保护目录之外（`memo.lock` / `.locks/<id>.turn.lease` / `*.gate`），所以“目录改名/回收 → 新目录新锁文件”这条双持有路径不存在；外部程序直接删锁文件仍会让互斥失效——这是路径锁的固有边界，无法在不引入内核对象/命名管道的情况下根治。应用内所有删除路径必须走门闩；文档与测试覆盖“存储清理不绕过门闩”。
- owner 文件不删除，避免“删到后来者 owner”的竞态；锁空时 `Probe` 忽略它。

### 9.6 IO 异常与网络盘

- 锁文件创建/打开失败（权限、只读盘、磁盘满）：返回 IO 错误，fail-closed；便签进入只读，会话拒绝写，不回退成双写。
- 网络盘 `CreateFile` 可能阻塞较久：per-key 锁保证只影响该资源；前端绑定调用异步化，UI 不冻结；必要时提示“工作区不可用”。
- 锁服务端不支持 byte-range 锁：`TryLock` 返回错误 → fail-closed。
- 写盘失败（磁盘满/文件被占用）：便签保持锁并提示；会话保持锁并提示，等待重试/关闭窗口。不要静默释放后让另一个窗口写入。
- 锁文件是 0 字节，不参与内容校验；损坏的 owner JSON 只影响提示，不影响锁。

### 9.7 持久化失败与交接

- 会话回合结束但 `persistSessions` 失败：保持租约，状态栏/`showNote` 提示；下一次重试成功后再释放。用户强行关窗时进程退出，内核释放（未写盘内容按现有行为丢失）。
- 便签 flush 失败：保持租约；关闭面板时弹确认，明确“放弃修改并释放”才释放。
- 交接前必须等终态写盘：`sessionStore.flush()`（或 `whenIdle(id)`）；`persistSession` 在已有 pending 时返回 `Promise.resolve()`（`ai-session-disk.js:255`），不能用它判断“写完”，要用队列尾/`flush`。
- 现有 `enqueue` 会 `catch` 并吞掉写盘错误（`ai-session-disk.js:43-53`），`flush()` 感知不到失败。必须让 `whenIdle(id)` 带回最后一次错误（`{ok,error}`），否则“失败保持锁”这条规则无法实现。
- `queueLogSave` 的 Markdown 派生日志不参与正确性判断；它有自己的 400ms 防抖和队列，允许最后写者赢；不要为了它阻塞租约交接。

### 9.8 同进程重入与业务互斥

- 租约只解决跨进程；同进程的会话并发仍由 `streamOf/compactOf` 与 `ai-session-disk` 的 `enqueue` 串行。
- 同进程的销毁操作（`DeleteAll`、改名、删除）必须先检查 `streamOf/compactOf`，不能因为 refcount 拿到租约就直接删。
- 会话写入的获取顺序是“先会话锁、后建目录”：`ensureSessionDir` 必须在会话独占之后，否则删除方移走目录后，写方的 `MkdirAll` 会把空目录“复活”。已有会话的日志/目录缺失时按删除处理，不重建（§6.3）。
- `AcquireShared` 用于根门闩：多个回合共享；同进程的独占销毁请求在 `shared>0` 时必须失败，不能“升级”。

### 9.9 混合版本

- 旧版本窗口不认识租约：仍会直接写便签/会话。本方案只保护升级后的窗口；升级说明里注明多窗口场景需要所有窗口同版本。
- 现有 `.session.lock` 与便签 CAS 保留，旧窗口至少不会把文件写坏。
- 存储清理的门闩只保护新版本窗口；旧版本窗口仍可能在清理时写入。无法在旧版本侧补，文档注明。

### 9.10 与现有锁的关系

- `.session.lock`：单次 append/rewrite/meta 的文件级互斥，保留。
- `.turn.lease`：回合级语义互斥，新增。
- `.root.gate`（实现名 `<root>.gate`，例如 `<appdata>/ai-sessions.gate`，在根目录之外）：根级读写门闩（共享/独占），新增。
- 便签 mtime CAS：异常路径兜底，保留。
- 文件保存 `SaveFileChecked`：不动。
- activity / aiworklog / aigroups 的私有锁：短持有、不会反向获取会话租约；不纳入层级，但调用方不得在持有它们时等待租约。

## 10. 测试计划

### 10.1 Go

- `sessionlock.TryLockFile` / `TryLockFileShared`：
  - 独占/共享的互斥矩阵（同进程两个句柄、两个子进程）；
  - `ErrLocked` 归一化；
  - 释放后可再次获取；
  - 并发抢锁不误报（复用 `lock_windows_test.go` 的模型）。
- `resourcelease`：
  - 同进程 acquire/release/refcount：两次 acquire 后第一次 release 仍持锁，第二次 release 才释放；
  - 共享 + 独占矩阵：shared 多持有、exclusive 被挡、shared→exclusive 升级失败；
  - `AcquireNoShare`：本进程已有 ref 时也 busy，释放后可拿。
  - `AcquireWait` 超时；per-key 隔离（一个 key 等待不阻塞另一个 key 的 release）；
  - owner 文件写入/覆盖/陈旧忽略；`Probe` 锁空时不返回陈旧 owner；
  - 重复 `Release` 幂等、refcount 不为负；
  - 子进程退出自动释放（`TestMain` 子进程模式；`go test` 放后台并带 `-timeout 300s`，避免前台阻塞）。
- `sessionstore`：
  - `Append`/`WriteMeta` 在另一个进程持有回合租约时返回 `session-busy`；
  - 同进程回合持有租约时 `Append` 走 refcount，不阻塞；
  - 删除/改名会话目录后，同 id 的另一进程仍然撞同一把 `.locks/<id>.turn.lease`（锁不随目录消失）；
  - `DeleteAll` 在有共享根门闩时失败；释放后成功；
  - 根目录销毁的“改名再删”顺序（删除后不再重建旧根）。
- `memo`：
  - `LeasePath` 作用域/工作区校验；
  - `Save` 在另一个进程持锁时返回 busy，不写盘；
  - CAS 与租约同时存在时的冲突路径。
- `ResourceWatcher`：Windows 下创建/修改文件能收到事件；非 Windows 返回不支持且不 panic。
- 回归：现有 `sessionstore` / `activity` / `aiworklog` 锁测试全绿。

### 10.2 前端

- `memo-store`：只读时 `mutate` 拒绝；接管前强制重读；`flush` 成功后才 release；flush 失败保持 writer；AI 短租约路径。
- 会话：
  - `other_window` 不进入自动重试；
  - 交接协议：`AISessionLeaseAcquire` 返回的 stat 与本地不一致 → 必须先 reload 再发送；
  - 终态写盘：mock 一个 pending 的 `persistSession`，确认 release 等 `flush` 完成；
  - `whenIdle` 等写队列排空后才返回、写盘失败时返回 `{ok:false}`（`ai-session-disk` 测试）；
  - `whenIdle` 在写盘失败时返回 `{ok:false}`，release 被扣住而不是静默交接；
  - 持久化 busy 跳过、失败保持待重试。
- `resource-changed` 过滤：只处理当前 memo 作用域/当前会话；自己的写入不触发重读；Probe 低频。
- mock-backend 新绑定可调用，dev 模式不崩。
- 测试文件按域放入 `frontend/test/bridge/`、`frontend/test/ai/`，并登记 `npm test`。

### 10.3 手动验收

1. 两个窗口都打开全局便签：A 可编辑，B 只读并显示 owner；A 输入后 B 在 1s 防抖 + watch 后看到内容；关闭 A 的面板后 B 在 focus 时自动变为可编辑。
2. 两个窗口打开同一会话：A 发送后 B 立即发送 → B 提示“另一窗口运行中”，A 的回合不受影响；A 结束后 B 收到刷新并可发送。
3. 交接：A 跑完一个长回合后立刻在 B 发送；确认 B 强制重读日志，A 的消息没有被截断/覆盖。
4. 强杀持锁窗口：另一窗口 focus 后能接管，无残留死锁。
5. 挂起持锁窗口（调试器暂停）：另一窗口保持只读/忙，横幅显示 PID；结束进程后恢复。
6. 运行中删除会话 / 存储清理：被拒绝并提示；停止后可删除/清理。
7. 非 Windows 交叉编译通过；无 watcher 时 focus 重读仍工作。
8. 单窗口日常使用无行为变化（除多窗口提示外）。

## 11. 实施顺序

1. **P1 锁底层**：`sessionlock.ErrLocked` + `TryLockFile` / `TryLockFileShared` / `LockFileShared` + 测试。
2. **P2 租约包**：`internal/resourcelease`（per-key、refcount、shared/exclusive、owner、Probe、AcquireWait、日志）+ 测试。
3. **P2.5 会话写兜底**：`sessionstore` 接入根门闩 + 回合租约（`withSessionLock` 顺序改造），`DeleteAll` 取根独占，测试 `session-busy`。
4. **P3 便签**：`memo.LeasePath` + `memo.Save` 兜底 + 绑定；`memo-store` 只读态；面板横幅/禁用；关闭释放；手动验收。
5. **P4 会话回合锁**：`startSessionTurn` acquire + 交接重读；终态写盘后释放；`other_window` 文案；先用手动刷新验证（watch 尚未接）。
6. **P5 通知与清理保护**：`ResourceWatcher` + `resource-changed`；全局便签 watch；会话 watch + 异步 `sessionindex.MarkDirty`；`storage.BeforeClear` 门闩。
7. **P6 收尾**：群聊 `group:<id>` 复用（可选）；`mock-backend`；CHANGELOG；方案移入 `docs/finished-plans/`。

每一期独立可回滚；P3/P4 是行为变化，提交信息要写清。

## 12. 验收标准

- [ ] 同一便签作用域同时只有一个窗口可写；另一个窗口明确只读，且能看到写者的后续保存。
- [ ] 同一会话同时只有一个回合在跑；第二个窗口发送被明确拒绝，不产生交错消息。
- [ ] 新回合在锁定后强制重读日志；retry/edit 的 truncate 不会截掉另一窗口已提交的消息。
- [ ] 终态写盘完成后才释放租约；写盘失败时保持租约并提示。
- [ ] 持锁窗口崩溃后，另一窗口无需手工清理即可接管；挂起时资源保持被占并有 PID 提示。
- [ ] 存储清理/删除会取门闩，busy 时拒绝；不会在持锁期间把目录移走。
- [ ] 现有单窗口流程、普通文件保存、群聊/子代理/定时任务不被破坏。
- [ ] 无新增第三方依赖；Go 二进制体积变化可忽略；无 SQLite/Node/Chromium 引入。
- [ ] 新增测试登记进 `npm test` / `go test`，构建与交叉编译通过。

## 13. 风险与回退

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 某条释放路径漏了 | 会话/便签被锁到进程退出 | lease 挂在 stream/oneShot 生命周期统一释放；`releaseTurnLease` 等 flush；日志记录持锁时长 |
| 持久化失败持锁不放 | 会话在窗口存活期间不可被其他窗口写 | 明确提示“保存失败/已阻止其他窗口写入”；用户可重试或关窗；宁可不交接也不截断数据 |
| 只读 UX 让用户困惑 | “为什么不能编辑” | 横幅写清 owner 与出口（关闭另一窗口面板）；focus 自动重读 |
| 后台任务被锁挡住 | 定时任务延迟/跳过 | `AcquireWait` 短超时 + 下一轮重试 + debug 日志；不阻塞 UI |
| 网络盘锁失败/IO 挂起 | 便签只读、会话不能写 | fail-closed；per-key 隔离；错误提示；不双写 |
| 混合版本窗口 | 旧窗口绕过租约 | 升级说明注明；CAS/append 锁兜底 |
| 大会话重读卡顿 | 读者切换会话变慢 | 只在租约释放后重读 + stat 比较 + 防抖；实测后再考虑增量读 |
| 根门闩遗漏某条写路径 | 清理时目录被重建/写丢 | `sessionstore` 统一兜底 + 存储清理钩子 + 测试覆盖所有写入口 |
| 群聊未覆盖 | 多窗口同群仍可能交错 | 明确列为后续阶段；先沿用现有 append 锁 |

回退方式：P3/P4 的租约获取/释放是局部改动，可单独 revert；保留 `sessionlock` 与 `memo` CAS，回退后行为回到当前版本。

## 14. 开放问题

1. 便签是否需要在只读横幅上提供“请求接管”（合作式：写文件请求，写者轮询到后释放）？v1 不做，先观察真实抱怨。
2. 会话最终采用回合锁还是 open-lease？本方案默认回合锁；若用户更在意“打开即独占”的确定性，再切换策略。
3. 会话列表的跨窗口刷新是否值得为 `ai-sessions/` 根加递归 watch？先只在 focus 刷新，按实际体验再定。
4. 单会话删除后，另一个窗口的陈旧内存状态是否可能“复活”该会话（重新 `ensureSessionDir`）？v1 靠会话租约 + 列表刷新缓解；是否需要 tombstone 文件后续评估。
5. 群聊 `group:<id>` 的持有粒度（一次发言 vs 整场讨论）需要按群聊运行时补方案。
6. `ai-config.json` 的 `activeSessionId` 等全局配置是否也要短租约？本方案不动，避免范围膨胀。
7. 是否为 `resourcelease` 提供 `ResourceLeaseDump` 调试绑定（列出本进程持有的锁）？用于支持排查，非必需。
8. `.locks/<id>.lease` / `memo.lock` 的回收策略：删除资源后是否清理锁文件？建议保留以避免“删除/重建”之间的空窗；若加 GC，必须只在确认无持有者时做。
9. 会话 meta（标题 / 置顶 / 未读 / 待办）跨窗口仍是最后写者赢：回合交接目前只重读日志，`writeMetaIfChanged` 可能用旧内存标题覆盖另一个窗口的改名。后续可让 `LeaseStatus` 带回 `meta.json`，在回合开始前合并（或把 meta 也纳入交接 stat）。
