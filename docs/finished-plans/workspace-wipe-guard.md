# 工作区破坏防护：写前快照 + watcher 检测（方案）

> 状态：**已实施**（2026-11-18 初稿；同日经评审与业界调研修订——存储改内容寻址，原 L3/L4 合并；2026-11-19 落地。落地当日修订三处：检测砍掉 canary 诱饵（作者裁定工作区零足迹，§5.2），watcher 删除计数排除构建产物目录，检测口径改为「净消失」+ 应用自身批量操作静默门——插件更新误报实录见 §5.1）
> 事故依据：`docs/reports/incident-2026-11-18-workspace-wipe.md`
> 决策：
> 1. **检测与恢复分离**。恢复（L1）走写前快照；检测（L2）以工作区 watcher 实时事件为**主信号**，结构指纹为**周期校准与兜底**。（canary 诱饵 2026-11-19 落地当日砍掉——作者裁定工作区零足迹，见 §5.2。）
> 2. **存储内容寻址**：blob 按 sha256 命名 + 追加式行索引，L1 与定期快照共用同一存储（去重与完整性自校验免费）。
> 3. **不做**文件系统级拦截（minifilter / ETW / USN），**不做** shadow git（依赖 git 二进制）。原 L3/L4 合并为「定期状态快照」，按工作区形态三态选择。
> 4. **防线自身防删**：备份目录对同用户子进程 deny-delete（Windows ACL）——威胁模型是「同用户任意子进程」，不是「AI 读类工具」。
> 范围：`internal/wipeguard` 新包 · `executeTool` 写路径与 watcher 事件接线 · 定期状态快照 · 设置项与清理条目 · deny-delete ACL
> 非范围：修订 `analyzeDangerousCommand` 规则（`find -delete` 本来就拦得住）· 拦截脚本内 `execSync`（进程边界外，规则层不可达）· 自动还原（只提供还原出口，不做无人确认的回滚）· `run_command` 沙箱化（接 `internal/sandbox` 受限令牌，对齐 Codex CLI 路线，**另立项**）

## 1. 背景与代码事实

### 1.1 事故为什么不是"规则缺失"

2026-11-18 21:00 的整仓删除（含 `.git`），命令是 `find . -delete`。而当前代码对它是拦得住的：

```text
$ node -e "...analyzeDangerousCommand('find . -delete')..."
"find . -delete"  danger=find-delete  readonly=false
```

- `READONLY_BLOCKED_ARGS.find` 自 `7248a86`（2026-11-13）就含 `-exec / -execdir / -ok / -okdir / -delete / -fprint / -fls / -fprintf`（`ai-command-rules.js:86`）
- 危险门 `find-delete` 自 `34f3977`（2026-11-15）在 `DANGER_LABELS`（`ai-command-rules.js:532` 起）

**真正的逃逸面是进程边界**：

```text
run_command("node .cadt/tmp/redteam-rt8.mjs")    ← 应用只审这一条文本（full 档直接放行）
  └→ node 进程内 execSync('bash -c "find . -delete"')   ← 规则层完全看不到
```

`analyzeDangerousCommand` / `analyzeReadOnlyCommand` 的输入永远是 `run_command` 的**入参字符串**。AI 自己写的 `.mjs` / `.py` / `.sh` 一旦在进程内起 shell，任何规则都够不着。这与 `commandTokens()` 对 `` ` `` / `$()` / `${` 返回 null 是同类问题，只是这次连文本都拿不到。

**结论：加规则不解决问题。** 需要的是"破坏发生时能立刻知道"（L2）与"破坏前已有可恢复副本"（L1）。

### 1.2 实测成本（本机，2026-11-18）

| 操作 | 耗时 | 规模 |
|---|---|---|
| 根目录 `ReadDir`（不递归） | **0.07 ms** | 98 条目 |
| 两层目录名枚举 | **1.23 ms** | 121 条目 |
| 递归全树 stat（跳过 `node_modules`/`.git`/`dist`） | **10.76 ms** | 1611 文件 |
| `git stash create -u` | **0.19 s** | 9 改动 + 1 未跟踪 → 20 个 loose 对象 / 约 550 KB |
| `workspace-changed` 事件消费（watcher 已推，零新增扫描） | **0** | — |

线性外推：10 万文件全树 stat 约 0.7 s（需放后台 + 预算）。**检测层成本可忽略**。

### 1.3 已有的可复用件

| 能力 | 位置 | 用法 |
|---|---|---|
| 应用数据目录 | `internal/appdata` | 快照落盘根（在工作区之外；AI 读类工具对应用数据目录硬拒） |
| 工作区 watcher | `internal/watch/watch.go:29` `WatchWorkspace` | **L2 主信号源**：已递归监听并推 `workspace-changed`（带 paths / overflow）。`ReadDirectoryChangesW` 内核级，**AI 工具、run_command 子进程、后台残留进程、用户的删除全部可见** |
| 目录忽略表 | `internal/search/search.go:35` `searchSkipDirs` | 指纹遍历与 watcher 计数排除 `node_modules` / `.git` / `dist` 等 |
| 存储清理条目表 | `internal/storage/specs.go:82` `appDirTarget` | 登记 `wipe-guard` 勾选清理条目（**不进一键清缓存**，见 §4.3） |
| 写工具原内容 | `ai-panel.js` `readOptionalText`（定义 :6647；write_file 分支 :9986、edit_file 分支 :10026 两处调用） | **原文本已在内存**，pre-image 只需多一次落盘 |
| 补丁字节快照点 | `internal/patch/patch_write.go:178` | 两阶段写入前的字节快照已存在，L1 在此点顺手持久化（`PatchRevert` 同点） |
| 跨进程写锁 | `internal/sessionlock`（`TryLockFile` / `TryLockFileShared`） | `index.jsonl` 追加互斥 |
| 原子替换 | `internal/atomfile` | blob 落盘与恢复写回 |

### 1.4 设计依据

业界对照见 §12。一句话：恢复层取 Claude Code / Gemini CLI / Cursor 的「自有快照」路线（时机学 Gemini、存储学 git 系内容寻址模型）；检测层取实时监听（反勒索界 canary 评估后未采纳，§5.2）、Tripwire 的周期校准；保留策略学 Syncthing。

## 2. 目标与非目标

### 2.1 目标

1. AI 的写操作（`write_file` / `edit_file` / 补丁应用）在**落盘前**留下可恢复的原文件副本（L1）。
2. **任何来源**（AI 工具、`run_command` 子进程、工具返回后存活的后台进程、用户）造成的大范围消失在**秒级**被检测，AI 活跃时可停止会话（L2）。
3. 快照与恢复**不依赖**项目是否为 git 仓库、也不随项目规模线性膨胀（L1 只备份被写的文件）。
4. 有 git 的工作区可定期出**自足归档快照**；无 git 的小工作区可增量 CAS 快照；超阈值不保护并在 UI 明说（L3，三态）。
5. **防线自身可防删**：备份目录对同用户子进程 deny-delete（ACL）——被顺手清掉的备份不算保护。

### 2.2 非目标

- 不做实时文件系统拦截（minifilter / ETW / USN），不试图阻止删除——只在事后立刻发现。
- 不做无人确认的自动回滚（恢复必须用户点）。
- 不覆盖 `run_command` 内部造成的任意破坏的**恢复**（见 §7 盲区；L2 能检测、L3 能兜底，但 L1 抓不到）。
- 不替代 VCS；L3 只是把"未提交内容"多存一份。
- 不追求秒级一致性（快照间隔内的改动允许丢失）。
- `run_command` 沙箱化（预防层）不进本方案，另立项。

## 3. 总体模型

### 3.1 三层与职责

```text
L1 写前快照（pre-image）       必做   命中：write_file / edit_file / 补丁应用
L2 检测（watcher+指纹）  必做   命中：任何来源的大范围消失，秒级
L3 定期状态快照                 可选   git archive（有 git）/ 增量 CAS（无 git 且小）/ 不保护（超阈值）
```

L3 三态判定在打开工作区时做一次，写进 `config.json` 的 `wipeGuard` 段（便于排障时回答"为什么没快照"）。

### 3.2 覆盖矩阵

| 破坏方式 | L1 | L2 | L3 |
|---|---|---|---|
| AI `write_file` 覆盖整个文件 | ✅ 完整恢复 | ✅ | ✅ |
| AI `edit_file` 改坏一处 | ✅ 完整恢复 | ⚠️ 只知变了 | ✅ |
| 补丁应用出错 | ✅ | ✅ | ✅ |
| `run_command` 内 `rm`/`find -delete` 局部 | ❌ | ✅ watcher 秒级 | ✅ |
| `run_command` 内整仓删除（本次事故） | ❌ | ✅ watcher 秒级 | ✅ 有 git 或项目够小 |
| 工具返回后**存活的子进程**继续删（探针里有 `sleep 999999`） | ❌ | ✅ watcher（工具前后指纹抓不到——这正是改事件驱动的原因） | ✅ |
| 用户自己误删 | ❌ | ✅ 提醒（不停会话，投递消息给正在跑的会话由它自查） | ✅ |
| 备份目录被 `rm -rf` | — | — | deny-delete ACL 拒绝 unlink |

**L1 是唯一"精确且零成本"的恢复层**，因为它只备份应用自己能看到的写。其余都是兜底。

### 3.3 为什么不是"全量定期备份"

- 大项目不可行（用户可能打开 100 GB 的数据目录，CaDt-DataLens 本身是数据查看器）。
- 无 git 时无法算增量，全量重复写盘会拖垮磁盘。
- L1 的成本是**单文件大小**，与被打开的项目规模完全无关——这是它能无条件启用的原因。

### 3.4 设置项与默认值

只做 **3 个开关 + 1 个路径**，全部默认开（本方案源自事故复盘，默认关 = 重演"以为有保护"）。存放进 `config.json` 的 `wipeGuard` 段，UI 放设置 → 存储与清理的 wipe-guard 条目区（与 §4.5 查看备份、§6.3 风险提示同处），表单控件走 `core/form-controls.js`：

```jsonc
{
  "enabled": true,      // 总开关：false 时 L1/L2/L3 全停（不备份、不检测）；已有备份保留，可查看/还原/清理
  "snapshots": true,    // L3 定期状态快照；false 只留 L1+L2
  "backupRoot": ""      // 空 = 默认 <appdata>/wipe-guard；非空 = 自定义根（校验见 §4.1）
}
```

| 项 | 默认 | 为什么可关 | 为什么默认开 |
|---|---|---|---|
| `enabled` 总开关 | 开 | 用户明确不想要任何防护/写盘 | 主价值所在 |
| `snapshots` 定期快照 | 开 | 定期写盘（git archive / CAS 扫描），备份洁癖者可关 | 有 git 时 0.19 s/次、增量 KB 级 |
| `backupRoot` 路径 | 空（appdata） | — | 大项目用户把备份指到其他盘（§4.1 校验） |

**刻意不做成设置项的**（全是工程参数，不是用户决策；改 `config.json` 可调，不进 UI）：删除计数阈值（40 条/10s）、保留期（7 天 / 200 MB / staggered 桶）、AI 活跃窗口（60s）、指纹节奏（10 分钟）、critical 处置方式（2026-11-19 起固定为「插队投递应用消息、不打断」，不再有停会话/熔断这种会被误关的开关）。L3 的 git/CAS/不保护三态是**派生结果**，不是设置——用户只管开不开 `snapshots`，选哪态由工作区形态自动判定。

## 4. L1：写前快照 `internal/wipeguard`

### 4.1 数据布局（内容寻址）

```text
<应用数据>/wipe-guard/                  # 位置论证见下
├── index.jsonl                         # 追加式索引：每次备份一行 = 唯一 manifest（行带 ws 字段）
├── objects/<sha256 前 2 位>/<sha256>   # 内容寻址 blob，全局共享（原样字节，temp+rename 幂等落盘）
├── snapshots/<ws 哈希>/                # L3 归档（tar）与增量 manifest，按工作区分命名空间（§6）
└── tmp/                                # 临时 index / 落盘中转
```

- **位置选应用数据根**（`%APPDATA%\CandySweet\CaDt-DataLens\wipe-guard`）：唯一同时满足「活过整仓删除」「应用自有目录」「清理 / 锁 / 读硬拒基建现成」的位置——业界同位（Claude Code 在 `~/.claude`、Gemini CLI 在 `~/.gemini/tmp/<hash>/checkpoints`、JetBrains 在 IDE system 目录，没有一家放项目里）。**不放工作区内**：`.cadt` 会随整仓一起被删（Syncthing 把版本目录放同步文件夹内，是因为它防的是同步误操作、不是整仓清空——抄保留策略，不抄位置）；也**不放工作区旁兄弟目录**（污染用户目录树、多工作区散落、父目录可能只读）。appdata 默认在系统盘：上限已封死（L1 200 MB + L3 300 MB）；P4 可加「备份根指到其他盘」设置——校验**不得指进工作区内部**（放进去 = 白放），指到工作区祖先目录要警告（祖先被删连带）。
- blob 写入前先算 sha256：已存在即复用（**去重**——`edit_file` 反复改同一文件只存一份），不存在经 temp + rename 落盘。恢复前可对 blob 复核哈希（**完整性自校验**）。
- 相比初稿的「每备份一目录 + meta.json」：目录层级砍掉，索引行就是元数据。索引行：

```json
{"id":"b-0007-a1b2","ws":"d3b0738f","session":"session-mwm5...","tool":"edit_file","rel":"frontend/src/ai/ai-panel.js","blob":"9f86d08...","bytes":900191,"at":1795008261466,"skipped":""}
```

- 行带 `ws`（工作区解析根的短哈希）：多个工作区共享同一 wipe-guard 根，`rel` 配上 `ws` 才有归属；`objects/` 全局不分——同一内容跨工作区只存一份。哈希口径与 `session-workspace-buckets.md` 的会话分桶同一约定。

- 超上限（默认 > 4 MB）跳过，索引记 `skipped:"too-large"`，UI 可见。（AI 写工具本身限 256KB；4 MB 阈值主要服务补丁路径；>10 MB 只读上限之上的文件本就打不开。）

### 4.2 API（Go 侧，薄绑定）

```go
// internal/wipeguard/api.go
type Deps struct {
    Root    func() string          // 应用数据目录
    Logf    func(level, format string, args ...any)
}

// Backup 前端写路径入口：原文本已在内存，Content 直传。文件不存在（新建）时记
// tombstone 行（blob 空），不做拷贝。返回 error 时调用方**应当继续写入**——
// 备份是尽力而为，不能因为备份失败挡住正常保存。
func (s *Service) Backup(call BackupCall) (BackupResult, error)

type BackupCall struct {
    SessionID string `json:"sessionId"`
    Tool      string `json:"tool"`      // write_file / edit_file / manual
    RelPath   string `json:"relPath"`   // 工作区相对路径
    AbsPath   string `json:"absPath"`   // 绝对路径（应用内写路径已解析过）
    Content   string `json:"content"`   // 原文本；Existed=false 表示新建
    Existed   bool   `json:"existed"`
}

// Store Go 内部钩子：补丁写入点经 Deps 注入，字节已在快照里
func (s *Service) Store(absPath string, content []byte) error
```

- **绑定只在根壳**：`wipeguard_app.go`（`WipeGuardBackup / WipeGuardList / WipeGuardRestore / WipeGuardClear`），`Logf` / `appdata.Root` 注入包内（对齐现有 `*_app.go` 模式）。
- **不进 AI 工具体系**：wipeguard 全部由应用自身调用，不登记 `AI_TOOL_DEFS` / 不暴露给模型——避免模型感知、试探或滥用告警与备份通道。
- 补丁引擎不 import main：`internal/patch` 的 `Deps` 加可选钩子 `OnWriteBackup func(abs string, content []byte)`，在 `patch_write.go:178` 备份点调用（撤销快照 → 顺手持久化），`PatchRevert` 同点；根壳注入 wipeguard 实现。不在外层再读一遍原文件。

### 4.3 索引与清理

- 追加式 + 跨进程锁（复用 `internal/sessionlock`），避免多窗口互相截断。
- 清理双阈值：**总量环形（默认 200 MB）+ 时间（默认 7 天，trashcan 语义）**，超阈值按时间删最旧的索引行。
- 清理动作 = 删行 + **孤儿 blob 回收**（从存活行重建 blob 引用集，删除未被引用的 blob）+ **索引压缩重写**（否则 `index.jsonl` 只涨不缩）。
- 触发：备份时顺手做（超阈值才扫，避免常驻扫描）；设置页另有手动入口。
- **存储清理登记**：`internal/storage/specs.go` 条目表加 `appDirTarget("wipe-guard")` 进勾选清理与占用统计；**不进** `TestCacheIDs` 的一键清缓存范围——`TestCacheIDs` 的注释原话是「新增缓存项要有意识地登记进来」，这里就是**有意识地不登记**：用户例行清缓存不应顺手拆掉保险。加一条负向断言（wipe-guard ∉ CacheIDs）防将来误登记。

### 4.4 deny-delete ACL（防线自防）

- 威胁模型是**同用户任意子进程**：`hardReadDenyReason` 只约束读类工具（`ai-read-roots.js:106`），`run_command` 起的进程可以 `rm -rf <appdata>/wipe-guard`——事故证明规则层看不见子进程，所以备份目录必须让 unlink 直接失败，而不是指望 AI 不碰它。
- Windows 实现：目录创建后 `SetNamedSecurityInfo` 加拒绝 ACE（Everyone → DELETE / DELETE_CHILD，继承到子对象），Owner 保留 WRITE_DAC。
- 清理 / 还原 / 删整目录前临时移除 DENY ACE，操作完重新加上（服务以 owner 身份改自己的 DACL）。
- 平台对：`internal/wipeguard/acl_windows.go` + `acl_other.go`（no-op 桩，必须通过 linux/darwin 交叉编译，AGENTS 平台约定）。
- 集成测试：起子进程 `rm -rf` 备份目录，断言失败。

### 4.5 恢复出口（用户手动，不做自动回滚）

- 设置 → 存储与清理 的 wipe-guard 条目给「查看备份」入口：**按文件分组的时间线**（JetBrains Local History 形态），每行显示最新一份原内容 + 时间 + 被谁改的 + 「还原」按钮。
- 还原前弹现有 `openConfirmDialog(..., 'danger')`，并提示"会覆盖当前内容"。
- **安全校验**：索引行与还原目标都过同一条路径校验（解析后不得逃出工作区，防索引被篡改后路径穿越）；写回走 `internal/atomfile`；尊重全局只读锁（`settings.readOnlyMode`）。
- **不做批量自动回滚**：一次事故可能涉及上千文件，自动回滚会覆盖用户在事故后新写的东西。

### 4.6 前端接线

三处写路径，原文本都已在内存（`readOptionalText` 的结果），新增成本只是一次绑定调用。调用失败只记调试日志，**不得阻断写入**（备份是尽力而为）：

| 位置 | 现有变量 | 插入点 |
|---|---|---|
| `ai-panel.js` `write_file` 分支（~9983） | `existing.exists` / `oldText` | `applyWorkspaceWrite` **之前** |
| `ai-panel.js` `edit_file` 分支（~10026） | `existing` / `text` | 同上 |
| 补丁应用（Go 侧） | `patch_write.go:178` 快照点 | 钩子直存（§4.2） |

## 5. L2：检测（三信号）

### 5.1 信号一（主）：watcher 滚动删除计数

- `internal/watch` 的 `workspace-changed` 已递归监听并带 paths / overflow——`ReadDirectoryChangesW` 是内核级，**AI 工具、`run_command` 子进程、工具返回后存活的进程、用户的删除全部可见**，且对检测零新增扫描。这是把检测从「工具调用前后取指纹」（初稿）改成事件驱动的原因：事故探针里有 `sleep 999999`，工具返回后存活的子进程只有 watcher 抓得住。
- 控制器：`frontend/src/ai/ai-wipeguard.js` 经 deps 订阅同一事件（main.js 已把 `workspace-changed` 路由给 explorer，不新增监听器）。
- **排除子树**：`searchSkipDirs` + `.git` + `.cadt`——`git gc` 清 loose objects、npm 重装 `node_modules` 是合法 churn；`.git` 目录是否整体消失交给指纹 markers 判定（§5.3）。
- **排除临时/机械文件**（2026-11-19 补丁应用误报实录）：原子写 temp（atomfile `<name>.<pid>.<nanos>.tmp` 与 `<name>.tmp.<pid>.<hash>` 两种命名）、补丁写入 temp（`.cadt-patch-*.tmp`）、锁文件（`.lock` / `.gate`）——它们的「消失」是写入流程的正常半程（temp→rename），不是文件被删；一次 7 文件的补丁应用能堆出 40+ 条删除事件直接爆阈值。按 basename 形态排除。
- **窗口内同路径去重**（同日实录）：ReadDirectoryChangesW 对一次 rename 推多条 action（temp 消失 + 目标出现 + 父目录变更），41 条事件去重后只有 ~10 个真实文件——重复计数把量级抬高 3-5 倍。
- **只计「消失」类事件**（2026-11-19 二次误报后定的治本口径）：Go 侧 `parseNotifyBuffer` 解析 `FILE_NOTIFY_INFORMATION` 的 action，`FILE_ACTION_REMOVED` 与**孤立**的 `FILE_ACTION_RENAMED_OLD_NAME`（被删 / 移出工作区）单独成组随 `workspace-changed` 的 `removed` 字段下发；前端删除计数只消费 `removed`。此前「paths 全量计数」把补丁回灌 / worktree 回灌的 added/modified 也算进去——70 文件的隔离树回灌照样爆 40 阈值，而它一个文件都没删。
- **rename 成对不算消失**（2026-11-19 举一反三）：内核把工作区内的一次改名/移动报成相邻的 `RENAMED_OLD_NAME` + `RENAMED_NEW_NAME`；批量重命名 50 个文件、`git mv` 一个目录、拖拽归位都属于这类，文件没离开工作区。移出工作区的移动只收到 `OLD_NAME`（目标在监听根之外），仍按消失计。
- **净消失（删除后又重建 = 替换）**（2026-11-19 插件更新误报实录）：Go 侧把非「消失」类事件另成一组随 `present` 下发（同批去重）；前端窗口里每条记录带单调递增 `seq`，判定时只把「没有在之后重新出现」的删除计入。插件更新是 `os.RemoveAll` 整目录 + 复制新目录，watcher 看到的是「70 个文件消失」，实际一个都没少。`present` 不进删除计数，只做抵消。
- **超阈值确认延迟**：删除与随后的重建常常不在同一批内核通知里（第一批只有删除）。首次达到阈值不立即告警，延迟 1.2 s 用同一窗口复核净消失——事故形态（`find . -delete`）只是晚 1.2 s 报，误报则在这一步被消掉。
- **任意层级的元数据与依赖/缓存目录**：`.git` / `.svn` / `.hg` / `.bzr` / `.cadt` / `.idea` / `.vscode` / `node_modules` / `vendor` / `__pycache__` / `.venv` / `venv` / `site-packages` / `.pytest_cache` / `.mypy_cache` / `.gradle` / `.cache` / `target` / `obj` / `.next` / `.nuxt` / `.turbo` 命中任意一段即排除；`dist` / `build` / `out` / `bin` / `coverage` 仍只按前两段（这三个名字埋在源码深处时往往是真源码目录）。此前只有两段口径，`plugins/<id>/.git/**`、monorepo 的 `packages/*/node_modules`、Python `.venv` 全都落在第三段之后被计数。`internal/search` 的忽略表同步补了 `.venv` / `venv` / `site-packages`（检索与指纹遍历同样跳过）。
- **应用自身批量操作静默门**（2026-11-19 插件更新误报实录）：插件安装 / 更新 / 卸载由应用主动发起，整目录删除再复制在 watcher 看来与大范围消失无异。`plugins.OnBulkMutate` 包级钩子（根壳注入 `watch.BeginQuiet` / `EndQuiet`）在操作期间清空 `removed` / `present` 两个判定分组（`paths` 照常推送，UI 照常刷新），结束后保留 2 s 宽限吸收缓冲区里的残留通知。启发式挡不住「新版本文件数骤减」的替换，这一层由发起方显式声明。
- **git 写工作树命令的静默门**（同日举一反三）：切分支 / 检出 / 丢弃改动 / 清理 / 合并 / 变基 / 拉取会成批删除当前分支独有的文件，几秒内几十上百条删除。`gitinfo.OnMutateWorktree` 钩子按**子命令白名单**（checkout / switch / restore / reset / stash / merge / rebase / cherry-pick / revert / pull / clean / read-tree / rm / mv / submodule / apply）在 `gitRun` 里开静默门，只读命令（status / log / diff / show / rev-parse …）不受影响。
- 判定（纯函数，表驱动测试）：10 秒滚动窗口内（removed 口径 + 排除子树 + 排除临时文件 + 同路径去重 + 重建抵消后的）**净消失 ≥ 40 条** → 告警候选。
- `overflow` 事件 → 立即触发一次全量指纹重扫（事件丢了靠校准补）。

### 5.2 信号二：canary 诱饵（**已砍**——工作区零足迹）

> **2026-11-19 裁定**：诱饵机制整个砍掉，工作区保持零足迹（作者有工作区文件洁癖，任何应用自建文件都不可接受）。初版落地当天暴露的问题也佐证了这个决定：幂等检查用「随机 token 文名 + Stat」——token 每次重生成、Stat 永远 miss，每调用一次新增一整排诱饵（本仓库一天积到 297 个）；且布点含 `build/` 等构建目录，被构建链清掉就弹「大范围文件消失」。修复过程中补的两条经验仍然有效：
> 1. **watcher 删除计数排除构建产物目录**（保留）：vite/wails 清 `dist`/`build` 是合法 churn，两级路径口径排除出 40 阈值计数。
> 2. **确定性信号的职责由指纹标记承担**（原有）：`.git` / `go.mod` / `package.json` 消失 → critical；顶层条目清空 / 文件数腰斩 → 指纹兜底。对 2026-11-18 事故形态（`find . -delete`）watcher 数量阈值秒级命中，canary 的边际价值≈0。
>
> 曾实现并保留过的缓解设计（记录备查）：诱饵 hidden 属性 + 登记 `.git/info/exclude`、布点跳过易失目录、单诱饵消失静默重建、幂等按布点清点。全部随机制一并移除，代码不保留（`canary*.go` / `WipeGuardEnsureCanaries` 绑定 / 前端 canary 通道 / 设置开关）。

### 5.3 信号三（兜底）：结构指纹

```go
// internal/wipeguard/fingerprint.go
type Fingerprint struct {
    RootEntries int      `json:"rootEntries"`  // 顶层条目数（含目录）
    Depth1Dirs  int      `json:"depth1Dirs"`   // 一级子目录数
    Markers     Markers  `json:"markers"`      // {".git":true,"go.mod":true,"package.json":true}
    FileCount   int      `json:"fileCount"`    // 全树文件数（超预算时为 -1，表示未测）
    Sampled     bool     `json:"sampled"`      // 是否因预算降级
}
```

- **顶层与一级永远测**：0.07 / 1.23 ms。
- **全树文件数按预算**：墙钟 200 ms + 条目上限 5 万（复用 `internal/search` 的预算思路）；超预算置 `Sampled=true`——**`FileCount` 条件自动失效，`RootEntries` / `Markers` 照判**（§5.4 表第四行在任一侧未测时跳过）。
- 遍历跳过 `searchSkipDirs` + `.git` + `.cadt`。
- 节奏：打开工作区时、每 10 分钟一次、overflow 后、告警候选后立即。
- **工具前后保底**：`ai-panel.js` 的 `run_command` / `background_command` 分支前后各取一次（3 秒去抖）——watch 监听失败或事件缺失时这是最后防线；write/edit 分支不取（watcher 已覆盖，避免每次写全树 stat）。
- 指纹绑定当前工作区根：会话切工作区（`ai-session-scope`）时重置 before 状态。

### 5.4 判定规则（纯函数，可表驱动测试）

```go
// ShouldWarn 返回是否告警与原因。only 明显的"消失"才告警，避免噪音。
func ShouldWarn(before, after Fingerprint) (bool, string)
```

| 条件 | 判定 |
|---|---|
| `after.RootEntries <= 1` 且 `before.RootEntries >= 5` | **critical**（整仓清空，本次事故形态） |
| `before.Markers.X && !after.Markers.X` | **critical**（关键标记消失，如 `.git/HEAD` 没了） |
| `after.RootEntries < before.RootEntries * 0.6` | **warn**（顶层少了四成以上） |
| `after.FileCount >= 0 && before.FileCount >= 0 && after.FileCount < before.FileCount * 0.5` | **warn**（文件数腰斩；任一侧未测即跳过） |

只判"减少"，不看"新增"——新增是正常开发。

watch 侧判定纯函数（JS）：`registerDeleteEvents` / `shouldAlarmFromWatch`（滚动窗口 + 排除子树与产物目录），配 `frontend/test/ai/ai-wipeguard.test.mjs`。

### 5.5 告警动作（2026-11-19 重定：**不自动停会话**）

| 级别 | 条件 | 动作 |
|---|---|---|
| **critical** | 告警候选 **且被告警工作区上有 AI 活跃**（该工作区最近 60s 内有工具执行或正在流式） | 状态栏红条 + notify + **向该工作区正在运行的会话插队投递「应用消息」**（`ai-panel.js` 的 `wipeguardNotifyForWorkspace` → `deliverAgentNotice`，`urgent=true` 插队首，轮边界注入）+ 操作留痕 |
| **critical** | 告警候选，但被告警工作区无 AI 活跃 | 红条 + notify + 留痕，不唤醒空闲会话（白烧 token，用户看红条与消息中心） |
| warn | 指纹文件数腰斩等 | 黄条 + 调试日志，不打断 |

- **为什么不再停会话**：合法批量删除（插件更新、切分支、装依赖、构建清理）与真破坏在 watcher 眼里同形，误判一次就把正在干活的会话打断——而模型比自己更清楚刚才在做什么。所以改成把事实**告诉它**：消息里点明「可能与你无关……没有删就忽略，确实在删就停下说明」，同时把中止的决定权留给用户。熔断写命令一并取消（`isWriteBlocked` 恒 false，导出保留只为不破坏调用点）。
- 投递只给**正在运行**的会话：不唤醒空闲会话。目标会话忙 → 排队等下一个轮边界；空闲 → 投递即唤醒（`deliverAgentNotice` 既有语义，本处只从运行中的 `streams` 里挑，因此不会触发唤醒）。
- 文案固定前缀 `［工作区防护］`（`ai-app-message.js` 的 `detectAppMessage` 按前缀归类，历史回放也认），卡片 kind = `wipeguard`。
- **消息长度预算**（这条消息会进会话上下文，不能把全量路径塞进去）：`buildGuardNotice` 只拼一句统计 + 三行判断依据 + **最多 8 条截断样例**（每条 76 字以内，头 32 + … + 尾 40）+ 一行恢复提示，实测 300~500 字。300 条路径的告警和不带路径的告警，进上下文后体积几乎一样。
- **恢复提示（快照/备份）**：`wipeguard.recoveryHint(root)` 读 `WipeGuardSnapshotList`，输出一行「可回滚：最近一份快照 5 分钟前（共 6 份，入口 设置 → 存储与清理 → 工作区防护）」；快照开关关闭或清单为空时说清「只能靠写前备份」。**只报一行摘要，不贴快照清单**——模型要知道的是「能不能救、去哪儿救」，不是文件名列表。
- **投递与红条共用 2 分钟冷却**（`WIPEGUARD_NOTIFY_COOLDOWN_MS`）：真事故里删除会持续十几秒，`fireAlarm` 的 3 秒去抖仍会连续上报；不节流会把几十条告警堆进会话上下文、把消息中心刷满。每次告警的运行日志由 Go 侧 `WipeGuardAlarm` 逐条写，留痕不受节流影响。
- 文案要点明"疑似大范围文件消失"，并给出备份位置（设置 → 存储与清理 → wipe-guard）。

## 6. L3：定期状态快照（原 L3 / L4 合并）

### 6.1 有 git：临时 index + `git archive` 自足包

```bash
GIT_INDEX_FILE=<appdata>/wipe-guard/tmp/index.<ts> \
git -C <ws> add -A                # 尊重 .gitignore；不含 ignored（有意，避免抓 dist/node_modules）
tree=$(git -C <ws> write-tree)
git -C <ws> archive --format=tar "$tree" -o <appdata>/wipe-guard/snapshots/<ws哈希>/<ts>.tar
rm <appdata>/wipe-guard/tmp/index.<ts>
```

- **为什么不用 `pack-objects`**：裸 sha 进 `git pack-objects` 只打该对象本身，树与 blob 全缺，恢复必败；`rev-list --objects` 又会把全部历史可达对象打进包。`git archive` 产物自足，**还原直接解包覆盖工作区，不需要 `.git` 存在**——契合事故形态。
- **为什么不用 `git stash create -u`**：主 commit 树不含 untracked 文件（在第三个 parent 的 untracked commit 里），archive 主 sha 会丢新文件；临时 index 一次拿全 tracked + untracked。
- `write-tree` 会在 `.git/objects` 留下无引用对象，`git gc` 自然回收，无害。
- 触发：写工具调用后 + 最小间隔 10 分钟（可配）。
- 恢复：解 tar 覆盖工作区（用户手动 + danger 确认）。

### 6.2 无 git 且小：增量 CAS 快照

- 判定：无 `.git` 且全树 `size_on_disk < 200 MB` 且文件数 < 5000。超预算测不完 → 视为超阈值，不启用（自然兜底）。
- 执行：每 10 分钟与上一份 manifest diff（rel + size + mtime 快速路径），仅新增/变更文件算 sha256 入**同一 CAS**（§4.1 的 `objects/`），manifest 记 `{ts, entries:[{rel, blob, size}]}` 存 `snapshots/<ws 哈希>/`。
- 硬链接镜像方案已否决（NTFS 硬链接共享数据流，原地写穿透镜像）；增量 CAS 去重后典型源码仓每轮只有 KB 级新 blob，且与 L1 共用存储。
- 恢复：按 manifest 从 CAS 重组文件（用户手动）。

### 6.3 无 git 且大：不保护 + UI 明说

- L1 覆盖不到 `run_command` 删除；L3 三态都不启用。只剩 L2 秒级发现 + 告警与投递提醒 + 报出消失路径（采样时只给根级差异）。
- 设置页「存储与清理」的 wipe-guard 条目下固定显示：

> 当前项目：无版本控制，且体积超过保护阈值（200 MB / 5000 文件）。
> AI 命令造成的批量删除**无法自动恢复**。建议 `git init` 或指定备份目录。

判定结果变化时（打开不同工作区）刷新。**宁可显得啰嗦，也不要让人以为有保护。**

### 6.4 三态判定与保留

```go
type Mode string
const (
    ModePreImageOnly Mode = "preimage"  // 默认：L1 + L2
    ModeGitSnapshots Mode = "git"       // L1 + L2 + git archive
    ModeCasSnapshots Mode = "cas"       // L1 + L2 + 增量 CAS
)
```

- 打开工作区时判定一次，结果与理由写进 `config.json` 的 `wipeGuard` 段；切换工作区重判。
- **staggered 保留**（Syncthing 语义）：最近 1 小时内 ≥5 分钟间隔全留 → 每天留 1 份、保 7 天 → 每周留 1 份、保 4 周；总量上限（默认 300 MB）先删最旧桶。

## 7. 盲区与用户可见的风险提示

### 7.1 无法覆盖的组合

**无 git + 大项目 + `run_command` 内批量删除**：L1 覆盖不到；L3 三态都不启用。此时只剩 L2 的秒级发现 + 告警与投递提醒 + 报出"消失了哪些路径"（指纹降级为采样时只能给根级差异）。
（后续缓解：`run_command` 接 `internal/sandbox` 受限令牌——对齐 Codex CLI 的 Windows WRITE_RESTRICTED 路线，另立项。）

### 7.2 必须在 UI 明说

见 §6.3。判定结果变化时刷新。**宁可显得啰嗦，也不要让人以为有保护。**

## 8. 实施步骤

### P1 · L2 检测（先落地：风险最低、收益最快）

1. `internal/wipeguard/fingerprint.go`：`Take()` + `ShouldWarn()`（纯函数）；
2. `internal/wipeguard/*_test.go`：表驱动覆盖 §5.4 四条件 + 采样降级 + 空目录；
3. `wipeguard_app.go`：`WipeGuardFingerprint` / `WipeGuardEnsureCanaries` / `WipeGuardAlarm` 绑定；
4. `frontend/wailsjs/` 三件 + `dev/mock-backend.js` 同名 mock；
5. `frontend/src/ai/ai-wipeguard.js`：订阅 `workspace-changed`（deps 注入）+ 滚动窗口净消失判定 + critical 向运行中会话插队投递应用消息（不停会话、不熔断）；`ai-panel.js` 的 `run_command` / `background_command` 分支挂工具前后指纹（保底）；
6. `frontend/test/ai/ai-wipeguard.test.mjs`（窗口判定 / AI 活跃上下文 / 去抖纯函数），登记 `npm test`。

### P2 · L1 写前快照

1. `internal/wipeguard/backup.go`：sha256 CAS + `Backup()` / `Store()` + 索引追加（sessionlock）+ 清理（删行 + 孤儿回收 + 索引压缩）；
2. `acl_windows.go` / `acl_other.go`：deny-delete DACL 与临时开放；
3. `internal/wipeguard/backup_test.go` + `acl_windows_test.go`（Windows 集成）：新建 tombstone / 覆盖 / 同内容去重命中 / >4MB 跳过 / 并发追加 1000 条 / 清理后无孤儿 / 索引压缩行数守恒 / 子进程 rm 失败；
4. `internal/patch` 的 `Deps` 加 `OnWriteBackup` 可选钩子，`patch_write.go:178` 与 revert 点接入（引擎包不 import main）；
5. `wipeguard_app.go` 加 `WipeGuardBackup / WipeGuardList / WipeGuardRestore / WipeGuardClear`；
6. `ai-panel.js` 两处接线（§4.6）；
7. `internal/storage/specs.go` 加条目 + 负向断言（wipe-guard ∉ CacheIDs）。

### P3 · 恢复出口 UI

1. 新 `frontend/src/settings/settings-pane-wipeguard.js`（§3.4 开关组与备份根选择 + 按文件分组时间线 + 还原 + danger 确认 + 路径校验；表单控件走 `core/form-controls.js`）；
2. 纯函数（分组、排序、截断、路径校验）配 `*.test.mjs` 并登记。

### P4 · L3 定期快照（可选，缓做）

先 git archive 路线（有 git 收益最高），后增量 CAS；三态判定与 §6.3 风险提示必须同批；「备份根指到其他盘」的可选设置也在此批（校验规则见 §4.1）。

### P5 · 文档

- `AGENTS.md`：`internal/wipeguard/` 进「Go 后端」清单；「AI 工具增删改」的已知盲区条目补一句"已由 wipeguard 兜底检测"；
- 事故报告 §5 末尾的方案指向核对表述与新架构一致；
- `CHANGELOG.md` 记为"新功能"。

## 9. 验证方式

| 层 | 验证 |
|---|---|
| L2 纯函数 | Go：`go test ./internal/wipeguard/ -run Fingerprint -timeout 60s`（后台执行、显式 -timeout）；JS：`ai-wipeguard.test.mjs`（窗口/去抖/上下文） |
| L2 端到端 | `.cadt/tmp/sandbox-*` 造小工作区跑 `find . -delete`，确认 3 秒内 critical（watcher 路径）；再跑「工具返回后 sleep 后删」变体——工具前后指纹抓不到、watcher 抓到 |
| L1 存储 | 单测：新建 tombstone · 覆盖逐字节相等 · 同内容二次备份去重命中 · >4MB 跳过 · 并发追加 1000 条 · 清理后无孤儿 blob · 索引压缩后行数守恒 |
| L1 ACL（Windows） | 子进程 `rm -rf <wipe-guard>` 被拒；清理流程临时开放后能删 |
| L1 恢复 | 写坏文件 → 还原 → `git diff` 空；篡改索引行 rel 为 `../x` → 还原拒绝 |
| L3 git | 有未提交改动的仓跑一次，tar 在**全新空目录**解包出完整内容（含 untracked） |
| L3 CAS | 200 文件小目录两轮快照间只 1 文件变更 → 第二轮仅 1 个新 blob |
| 性能 | 指纹 1611 文件 ≤ 20 ms（实测 10.76 ms）；大项目降级 `Sampled=true`；watcher 消费零新增扫描 |

Go 测试一律后台执行、显式带 `-timeout`（AGENTS.md 约定）。

## 10. 风险与取舍

| 风险 | 处置 |
|---|---|
| 备份把磁盘写满 | 总量 200 MB + 7 天双阈值 + staggered；超大文件跳过；孤儿 blob 回收 |
| 备份拖慢写入 | 单文件 hash + temp rename；失败不阻断写入 |
| watcher churn 误报（git gc / npm 重装） | 计数排除 `searchSkipDirs` + `.git` + `.cadt` 子树；阈值 40/10s |
| 用户手动批量删除被当成破坏 | 2026-11-19 起不再自动停会话/熔断：只出红条 + 向运行中的会话投递一条应用消息，由模型自查、由用户决定是否中止 |
| watch 事件丢失 / 监听失败 | overflow → 指纹重扫；工具前后指纹保底 |
| ACL 妨碍清理与还原 | 服务以 owner 临时开放，操作完恢复；集成测试覆盖 |
| 索引膨胀 | 清理时压缩重写 |
| 恢复覆盖新内容 | 不做自动回滚，必须人工确认 |
| 备份目录被子进程删除 | deny-delete ACL（unlink 直接失败）+ 应用数据目录读硬拒（工具层）+ 不在工作区内 |
| 备份根被用户指错位置 | 设置校验：拒绝指进工作区内部（放进去 = 白放）；指到工作区祖先目录时警告（祖先被删连带） |
| 指纹对大项目变慢 | 预算 + 采样降级；`Sampled=true` 时 RootEntries/Markers 照判、FileCount 跳过 |
| 新增包与测试的维护成本 | 按项目红线：文件 ≤ 1500 行、函数 < 200 行、纯函数配表驱动测试 |

## 11. 明确否决的方案

| 方案 | 否决理由 |
|---|---|
| 给 `find` 再加规则 | `find -delete` 本来就拦得住，问题在进程边界外 |
| 静态扫 AI 写的脚本找 `execSync` | `eval` / 字符串拼接 / base64 全能绕开，误报高 |
| Windows minifilter 拦截删除 | 驱动级、需签名、与"单 exe 零依赖"目标冲突 |
| 依赖 VSS 卷影副本 | 默认关闭、需管理员、不可编程保证 |
| NTFS USN / ETW 监听 | 读 USN 需管理员（事故报告实测 `Error 5: Access is denied`） |
| shadow git 仓库（Cline 路线） | 依赖 git 二进制，违背「无 git 可用」；嵌套仓/多仓踩坑多（cline#4388） |
| `git stash create` + `pack-objects` | 裸 sha 打不出自足包（树/blob 全缺，恢复必败）；stash 主树不含 untracked；改临时 index + `git archive` |
| 硬链接镜像（初稿 L4） | NTFS 硬链接共享数据流，原地写穿透镜像；改增量 CAS |
| 引入 restic / kopia 库 | 体积红线（zstd 等依赖链）；只抄内容寻址模型 |
| 每工具全量 commit（Cline 密度） | 大项目成本高；pre-image 只需变更文件，无需全量 |
| 每次工具调用全量快照 | 大项目直接不可行 |
| 自动回滚所有备份 | 会覆盖用户事故后新写的内容，比不恢复更危险 |

## 12. 附：业界机制对照

| 来源 | 采纳 | 落点 |
|---|---|---|
| Claude Code checkpoints | 写前自动快照定位；保留量级（100 份/30 天）；其官方承认的 Bash 盲区反证检测层必须独立 | L1 定位 + 保留期 |
| Gemini CLI checkpointing | 「改文件类工具执行前」快照时机；快照外置工作区 | L1 接线时机 + appdata |
| Cursor checkpoints | 自有存储独立于 git 的可行性 | L1 路线 |
| Cline / Roo Code | 存储与项目 `.git` 完全隔离；其踩坑（cline#4388）劝退 shadow git | L1 隔离原则 |
| JetBrains Local History | 按文件时间线 + 还原的恢复出口形态；保留期区间（5 个工作日） | P3 UI + 清理 |
| Syncthing versioning | trashcan / staggered 保留策略 | L1 trashcan+7 天；L3 staggered |
| 反勒索产品（Vectra / Sophos 等） | canary/诱饵确定性检测 | 未采纳——工作区零足迹（作者裁定），watcher + 指纹已覆盖 |
| Tripwire / AIDE | 周期完整性校准 + 事件丢失重扫 | L2 指纹兜底 |
| git 对象模型（restic / kopia / Borg 蓝图） | 内容寻址 + manifest，只抄设计不引库 | L1/L3 存储 |
| Codex CLI 沙箱 | Windows 受限令牌路线（预防层） | 后续立项：`run_command` 接 `internal/sandbox` |
