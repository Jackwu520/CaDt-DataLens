# 工作区破坏防护：写前快照 + watcher 检测（方案）

> 状态：**待开工**（2026-11-18 初稿，源自工作区被清空事故的复盘；同日经评审与业界调研修订——检测改「watcher + canary + 指纹」三信号，存储改内容寻址，原 L3/L4 合并）
> 事故依据：`docs/reports/incident-2026-11-18-workspace-wipe.md`
> 决策：
> 1. **检测与恢复分离**。恢复（L1）走写前快照；检测（L2）以工作区 watcher 实时事件为**主信号**，canary 诱饵为**确定性信号**，结构指纹为**周期校准与兜底**。
> 2. **存储内容寻址**：blob 按 sha256 命名 + 追加式行索引，L1 与定期快照共用同一存储（去重与完整性自校验免费）。
> 3. **不做**文件系统级拦截（minifilter / ETW / USN），**不做** shadow git（依赖 git 二进制）。原 L3/L4 合并为「定期状态快照」，按工作区形态三态选择。
> 4. **防线自身防删**：备份目录对同用户子进程 deny-delete（Windows ACL）——威胁模型是「同用户任意子进程」，不是「AI 读类工具」。
> 范围：`internal/wipeguard` 新包 · `executeTool` 写路径与 watcher 事件接线 · canary · 定期状态快照 · 设置项与清理条目 · deny-delete ACL
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

业界对照见 §12。一句话：恢复层取 Claude Code / Gemini CLI / Cursor 的「自有快照」路线（时机学 Gemini、存储学 git 系内容寻址模型）；检测层取反勒索界的 canary + 实时监听、Tripwire 的周期校准；保留策略学 Syncthing。

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
L2 检测（watcher+canary+指纹）  必做   命中：任何来源的大范围消失，秒级
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
| `run_command` 内整仓删除（本次事故） | ❌ | ✅ canary/watcher 秒级 | ✅ 有 git 或项目够小 |
| 工具返回后**存活的子进程**继续删（探针里有 `sleep 999999`） | ❌ | ✅ watcher（工具前后指纹抓不到——这正是改事件驱动的原因） | ✅ |
| 用户自己误删 | ❌ | ✅ 提醒（无 AI 活跃时不停会话） | ✅ |
| 备份目录被 `rm -rf` | — | — | deny-delete ACL 拒绝 unlink |

**L1 是唯一"精确且零成本"的恢复层**，因为它只备份应用自己能看到的写。其余都是兜底。

### 3.3 为什么不是"全量定期备份"

- 大项目不可行（用户可能打开 100 GB 的数据目录，CaDt-DataLens 本身是数据查看器）。
- 无 git 时无法算增量，全量重复写盘会拖垮磁盘。
- L1 的成本是**单文件大小**，与被打开的项目规模完全无关——这是它能无条件启用的原因。

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

- 行带 `ws`（工作区解析根的短哈希）：多个工作区共享同一 wipe-guard 根，`rel` 配上 `ws` 才有归属；`objects/` 全局不分——同一内容跨工作区只存一份。

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
- 判定（纯函数，表驱动测试）：10 秒滚动窗口内（排除子树后的）删除/移走类事件 **≥ 40 条** → 告警候选。
- `overflow` 事件 → 立即触发一次全量指纹重扫（事件丢了靠校准补）。

### 5.2 信号二（确定性）：canary 诱饵

- 工作区顶层各目录撒 `.cadt-canary-<8hex>`（内容 = 随机 token + 一句话说明「本文件是 CaDt-DataLens 防护诱饵，删除它会触发告警」），上限 12 个；跳过 `searchSkipDirs` / `.git` / `.cadt`；Windows 设 hidden 属性。
- 建立：`WipeGuardEnsureCanaries(ws)`（打开工作区时、告警后重建）。
- 检测：watcher 删除事件 basename 前缀匹配 → **立即告警候选**；周期指纹顺带核对存在性。成本≈0，对整仓删除是最早的确定性信号（反勒索界标配）。
- 误报处置：用户手动删也会告警（文案注明诱饵身份）；设置页可关。

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

watch 侧判定纯函数（JS）：`registerDeleteEvents` / `shouldAlarmFromWatch`（滚动窗口 + canary 匹配 + 排除子树），配 `frontend/test/ai/ai-wipeguard.test.mjs`。

### 5.5 告警动作

| 级别 | 条件 | 动作 |
|---|---|---|
| **critical** | 告警候选 **且 AI 活跃**（任一会话最近 60s 内有工具执行或正在流式） | 状态栏红条 + notify + **停本会话生成与子代理**（`agent_stop` 等价）+ 禁用本轮后续写命令（full 档自动放行一并熔断）+ 操作留痕 |
| **critical** | 告警候选，但会话空闲 | 红条 + notify + 留痕，**不停会话**（用户手动批量删除不被误伤） |
| warn | 指纹文件数腰斩等 | 黄条 + 调试日志，不打断 |

- 停止是安全的：它只终止 AI 的生成，不丢用户的任何东西。
- 文案必须点明"疑似大范围文件消失"，并给出备份位置（设置 → 存储与清理 → wipe-guard）与事故报告链接。

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

- L1 覆盖不到 `run_command` 删除；L3 三态都不启用。只剩 L2 秒级发现 + 停会话止血 + 报出消失路径（采样时只给根级差异）。
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

**无 git + 大项目 + `run_command` 内批量删除**：L1 覆盖不到；L3 三态都不启用。此时只剩 L2 的秒级发现 + 停会话止血 + 报出"消失了哪些路径"（指纹降级为采样时只能给根级差异）。
（后续缓解：`run_command` 接 `internal/sandbox` 受限令牌——对齐 Codex CLI 的 Windows WRITE_RESTRICTED 路线，另立项。）

### 7.2 必须在 UI 明说

见 §6.3。判定结果变化时刷新。**宁可显得啰嗦，也不要让人以为有保护。**

## 8. 实施步骤

### P1 · L2 检测（先落地：风险最低、收益最快）

1. `internal/wipeguard/fingerprint.go`：`Take()` + `ShouldWarn()`（纯函数）；`canary.go`：`EnsureCanaries()`（hidden 属性在平台对内处理）；
2. `internal/wipeguard/*_test.go`：表驱动覆盖 §5.4 四条件 + 采样降级 + 空目录 + canary 建立与清单；
3. `wipeguard_app.go`：`WipeGuardFingerprint` / `WipeGuardEnsureCanaries` / `WipeGuardAlarm` 绑定；
4. `frontend/wailsjs/` 三件 + `dev/mock-backend.js` 同名 mock；
5. `frontend/src/ai/ai-wipeguard.js`：订阅 `workspace-changed`（deps 注入）+ 滚动窗口判定 + canary 匹配 + critical 停会话/熔断；`ai-panel.js` 的 `run_command` / `background_command` 分支挂工具前后指纹（保底）；
6. `frontend/test/ai/ai-wipeguard.test.mjs`（窗口判定 / canary 匹配 / AI 活跃上下文 / 去抖纯函数），登记 `npm test`。

### P2 · L1 写前快照

1. `internal/wipeguard/backup.go`：sha256 CAS + `Backup()` / `Store()` + 索引追加（sessionlock）+ 清理（删行 + 孤儿回收 + 索引压缩）；
2. `acl_windows.go` / `acl_other.go`：deny-delete DACL 与临时开放；
3. `internal/wipeguard/backup_test.go` + `acl_windows_test.go`（Windows 集成）：新建 tombstone / 覆盖 / 同内容去重命中 / >4MB 跳过 / 并发追加 1000 条 / 清理后无孤儿 / 索引压缩行数守恒 / 子进程 rm 失败；
4. `internal/patch` 的 `Deps` 加 `OnWriteBackup` 可选钩子，`patch_write.go:178` 与 revert 点接入（引擎包不 import main）；
5. `wipeguard_app.go` 加 `WipeGuardBackup / WipeGuardList / WipeGuardRestore / WipeGuardClear`；
6. `ai-panel.js` 两处接线（§4.6）；
7. `internal/storage/specs.go` 加条目 + 负向断言（wipe-guard ∉ CacheIDs）。

### P3 · 恢复出口 UI

1. 新 `frontend/src/settings/settings-pane-wipeguard.js`（按文件分组时间线 + 还原 + danger 确认 + 路径校验）；
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
| 用户手动批量删除误停会话 | AI 活动上下文区分：无活跃只强提醒，不停会话 |
| canary 误报（用户删诱饵） | 文案注明诱饵身份；告警后自动重建；设置可关 |
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
| 反勒索产品（Vectra / Sophos 等） | canary/诱饵确定性检测 | L2 canary |
| Tripwire / AIDE | 周期完整性校准 + 事件丢失重扫 | L2 指纹兜底 |
| git 对象模型（restic / kopia / Borg 蓝图） | 内容寻址 + manifest，只抄设计不引库 | L1/L3 存储 |
| Codex CLI 沙箱 | Windows 受限令牌路线（预防层） | 后续立项：`run_command` 接 `internal/sandbox` |
