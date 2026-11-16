# Git worktree：AI 隔离工作区

> 2026-11-16 起草，2026-11-17 评估并定稿为实施计划。
> 关联：`../finished-plans/git-flow-auto-exemption.md`（git 写操作审批）、`subagent-sandbox.md`（隔离思路）、`../finished-plans/ai-gen-image-edit.md`（同类「哑通道 + 前端编排」参考）。

## 0. 评估结论（对 2026-11-16 草稿的核实与修订）

草稿的五条前提**逐条核实全部成立**（行号按 2026-11-17 实测更新）；三处护栏的定位与改法正确，但核实中发现**还有两处同源污染**，护栏从「三处」扩为「五处」（见 §4）。另有三个草稿未定的设计点，本稿落定：

1. **回灌链路谁搬运 diff 文本**——定为 Go 侧导出（`git diff` 文本只在前端 JS 内存里转手进 `PatchSave`，不经过模型上下文），AI 只调工具不搬运文本。草稿的「`git diff` → patch 文本 → 复用审阅卡」若走 `run_command` 让模型转写，大 diff 会烧上下文、撞 256 KB 上限且转写易错。
2. **AI 交互面**——新增单工具 `worktree_manage`（create / list / export / discard 四 action），按「AI 工具增删改」规则全套登记（def + 目录 + 分组 + 档位 + mock-backend + 测试）。不给 `run_command` 里的 `git worktree add/remove` 开免审的决策不变（`GIT_FLOW_SAFE_SUBCOMMANDS` 保持不含 worktree）。
3. **会话态与恢复**——`session.worktree` 进会话 meta 持久化（草稿只提了 `.cadt/worktree/index.json` 登记表；核实后一期**不建 index.json**，`git worktree list --porcelain` + 会话字段已覆盖全部需求，少一份会失真的缓存）。

原稿其余决策全部确认：patch 回灌不做 merge、显式长路径不做前缀注入、不承诺「能跑测试」、不建在 `.cadt` 之外。

## 1. 背景与目标

让 AI 在**独立的 git worktree** 里改代码，改动不直接落到用户的工作区：AI 试错、重构、跑批量替换都在隔离分支上进行，产物经审阅后回灌主根。目标场景是「有风险的批量改动，先看结果再决定要不要」。

关键设计约束来自一条实测结论：**worktree 建在工作区内（`.cadt/worktree/<slug>`），因此不需要切换工作区。**

非目标（一期）：并行多 worktree、在 worktree 里跑测试、自动 merge、跨会话共享 worktree。

## 2. 为什么建在 `.cadt/worktree/` 下是对的

早期方案想让 worktree 建在仓库根之外（`../xxx`），代价是四件事全要重做：工作区根有两份影子根（`main.js` 的 `workspaceFolder` + `explorer.explicitRoot`）、`openFolderSmart` 会把「换目录」当成「换项目」直接开新窗口、`WatchWorkspace` 是单根、AI 的写路径闸是单根硬边界。

放进 `.cadt/worktree/` 之后，这四条全部消失——因为它们的前提都是「根变了」，而这里根没变。

### 已验证的前提（2026-11-17 逐条核实，行号为当日实测）

| # | 前提 | 依据 | 结论 |
|---|---|---|---|
| 1 | `.cadt/` 已被 git 忽略，不污染主根 `git status` | `.gitignore:18` 的 `.cadt/`；`git status --porcelain --ignored` 对忽略目录折叠为单条 `!! .cadt/`，不会因检出副本章拉长状态列表 | ✅ 现成满足 |
| 2 | AI 写路径闸自动放行 | `ai-panel.js:5474` `aiPathInside` + `:5481` `aiResolveScopePath`，`root/.cadt/worktree/x/...` 就在 root 内；读工具越界授权链（`resolveReadPathWithApproval`）同样不触发 | ✅ 一行不用改 |
| 3 | 命令 cwd 检查能过 | `ai-command-rules.js:396` `dir === root || dir.startsWith(root + '/')`，`.cadt/worktree/x` 满足；git 命令在 worktree cwd 下自动作用于该 worktree 的分支 | ✅ 现成满足 |
| 4 | 文件树不被污染 | `explorer.js:135` `LIST_SKIP_DIRS` 含 `.cadt`，树（`:715`）与扁平列表（`:1134`）都不列 | ✅ 现成满足 |
| 5 | 不会递归嵌套 | `.cadt` 不在 HEAD 里（被忽略），worktree 检出内容不含 `.cadt`，worktree 内部不会再有 `.cadt/worktree` | ✅ 天然成立 |

第 2 条是整个方案能成立的核心：**不需要新增「写根」概念**。这比多根白名单便宜一个数量级，而且不引入新的权限面。

## 3. 总体设计

### 3.1 目录与命名（Go 侧派生，不信任前端传入路径）

- 布局：`<主根>/.cadt/worktree/<slug>/`。
- slug 由 Go 从 `label`（AI/用户给的用途名）+ 会话 id 派生：小写化、`[^a-z0-9-]` 折成 `-`、截断 32、拼会话 id 前 8 位（字母数字），碰撞时 `-2`/`-3` 后缀重试（最多 3 次，仍冲突则报错）。label 缺省时用 `wt`。
- 分支名：`cadt/wt/<slug>`（slug 白名单字符集天然满足 git ref 规则）。
- `WorktreeAdd` 绑定只收 `(root, label)`；路径由 Go 拼接并防御性校验（相对 root 必须落在 `.cadt/worktree/` 下且不含 `..`）。
- 创建时记录 `baseSha` = 主根当时 HEAD 的 sha——回灌 diff 的基准，AI 在 worktree 里 commit 过也能全量导出。
- **会话绑定**：`session.worktree` 是唯一归属凭证；fork / 支线 / 会话投递产生的新会话一律**不继承**该字段（置空），保证「一会话一 worktree」不被复制破坏。
- **孤儿判定由前端算**：Go 的 `WorktreeList` 保持纯净（只解析 git），`orphan` = 位于 `.cadt/worktree/` 下但不在任何会话 meta（含 `_stub` 占位会话）登记里的条目——因此 worktree 字段必须进 meta 级序列化，占位会话也能参与判定。

### 3.2 会话状态机

```
（无 worktree） --create--> 活跃（session.worktree = {name, branch, path, baseSha, createdAt}）
活跃 --export--> 审阅卡 --> 用户应用/放弃（worktree 保留，可继续迭代再 export）
活跃 --discard--> （无 worktree）   [git worktree remove --force + git branch -D + 清会话字段]
崩溃恢复：载入会话时 path 不存在 → 清字段，首轮注入「隔离工作区已失效」提示
```

- **一个会话最多一个**（独占）：`create` 在已有活跃 worktree 时报错，提示先 export/discard。
- worktree 是草稿区：`cadt/wt/*` 分支永不合并、不保留，`discard` 一并删分支。
- 启动 reconcile：ai-panel init 时对主根调一次 `GitWorktreePrune`（清 git admin 残留，不动目录）。孤儿 worktree（有目录但无活跃会话引用）一期不自动删，`list` 输出标 `orphan` 让人可见；自动回收放二期。

### 3.3 回灌链路（patch 回灌，不做 merge）

| 方案 | 判断 |
|---|---|
| **patch 回灌**（采纳） | worktree 内 `git diff` → 走现有 `internal/patch` 引擎 → 用户在变更卡审阅 → 应用到主根 |
| git merge / cherry-pick | 否决：要动用户当前分支，要处理冲突与脏工作区回滚；用户的树经常有在途改动，merge 会直接拒绝 |
| 直接把 worktree 当工作区打开 | 否决：用户还是要自己合并，丢了隔离的意义 |

零件全是现成的：`internal/patch` 有解析、严格匹配、两阶段写入（atomic/partial）、字节快照撤销、只读审阅；前端有 `requestPatchApproval` 审批卡与 `PatchApply`（`ai-panel.js:9071-9120` 的 propose_patch 分支即样板）。

export 的具体序列（Go 侧 `GitWorktreeDiff`）：

1. worktree 内 `git add -A -N .`——intent-to-add 让**未跟踪的新文件**进 diff（`git diff` 默认不含 untracked，这是实现时最容易踩的坑；`-N` 只记 intent，不真正暂存内容）。
2. `git diff --no-renames <baseSha>`——以创建时基准导出全量草稿。`--no-renames` 把 rename 拆成 delete+add，回避 patch 解析器对 rename 段的支持盲区。删除、修改、新增都在这一份 diff 里。
3. 空 diff → 返回「没有改动」明确提示，不出补丁。
4. 文本由前端 JS 转手进现有 `PatchSave(主根, …)`（不经过模型）→ 弹 patch 审批卡 → `PatchApply` → 逐文件 `recordChange`（主根路径）+ `notifyFileChanged`。

语义要点：

- **重复 export 是全量语义**：第二次 export 的 diff 仍相对 `baseSha`，第一轮已应用的 hunk 预检会如实报「不可应用」（patch 严格匹配，这正是想要的失败方式）。工具 description 与审批卡文案都引导「应用成功后 discard 收尾」，不做增量导出（需要快照 sha，一期不值）。
- **patch 卡是人工审阅闸门，全档位必弹**（含 full 档）——这是本功能的价值本身，也是「不做自动 merge 回主根」红线的落地；与 propose_patch 在 full 档「只产出不弹卡」的行为**有意不同**，理由：回灌是跨区写入主根。
- patch 的严格匹配遇到主根已变会如实报错——比 merge 静默产生冲突标记安全；行尾差异由 patch-view 已有的 ignoreWhitespace 重预检兜底。

### 3.4 AI 的路径与工作目录约定（显式长路径，不做前缀注入）

- 读写：`.cadt/worktree/<slug>/src/a.js`（相对主根）。路径丑但语义单一，`aiResolveScopePath` 不用动。
- 命令：`run_command` 的 `cwd` 传 `.cadt/worktree/<slug>`，能过 cwd 检查且 git 自动识别该 worktree。
- **不要**引入「会话级工作目录前缀重写」：那会让 `aiResolveScopePath` 失去单一语义，且所有写工具、`run_command` cwd、patch 根目录判定都要跟着改，收益不抵风险。
- 前缀由 `<worktree>` 注入块明确写出（§6.3），否则 AI 会默认在主根改代码。

### 3.5 入口

- AI 面板输入框斜杠 `/worktree`（`AI_COMMANDS` 加一条，`ai-slash.js` 转发到 worktree 域模块）。
- 会话获得活跃 worktree 后，头部出一条状态胶囊（`#ai-chip-worktree`，与计时/定时胶囊同排）：显示隔离区名，点击弹信息与「丢弃隔离区」确认。**实施简化（2026-11-17）**：胶囊不带「导出补丁」快捷钮——export 的 patch 审批卡挂在回合的 toolMessage 上（composer takeover 机制），胶囊没有消息载体；一期 export 统一走 AI 的 `worktree_manage(action=export)`。
- AI 也可经 `worktree_manage` 主动 create（走确认卡），用于「我建议在隔离区里试」的场景。

## 4. 五处必须改的护栏（不改则功能不可用或污染全局）

### 4.1 `isAutoWriteRisky` 会拦掉 AI 在 worktree 里的每一次写 —— 必须豁免

`frontend/src/ai/ai-panel.js:7376`：

```js
if (rel === '.cadt/tmp' || rel.startsWith('.cadt/tmp/')) return false;
if (rel === '.cadt' || rel.startsWith('.cadt/') || rel.includes('/.cadt/')) return true;
```

AI 写 `.cadt/worktree/x/src/a.js` 时 `rel` 以 `.cadt/` 开头 → `risky = true` → auto 档每次写都弹审批卡。**这是最高优先级的改动**，不豁免则功能完全不可用。

豁免的档位边界：只作用于 **auto 档的逐写审批**这一层——edit 档照常逐写显示 diff（契约不改，不因进隔离区而悄悄升级权限）、read/plan 档写工具本就不可用、full 档本就免。且 dirty 文件仍 risky、write-guard 陈旧缓冲防护与项目规则照常生效（§6.5）。自洽性：免审范围 = 隔离区写入 = 炸了不伤主根的区域；免审的安全债全部由回灌 patch 卡（全档必弹，§3.3）偿还——免的是过程，不免结果落地主根。

改法：照 `.cadt/tmp` 的样式在 `.cadt/` 拦截**之前**加一条 `.cadt/worktree/` 精确前缀豁免，且必须**精确到前缀**——`.cadt/permissions.json`、`.cadt/patches/` 仍然不能被 AI 免审自改，这条语义不能放宽。

已知可接受面（写进测试注释）：豁免后 AI 理论上可写 `.cadt/worktree/index` 类 Go 侧元数据与其他会话的 worktree——前者可由 prune/reconcile 重建，后者是单用户单机场景的软隔离，一期接受。

### 4.2 文件监听会收到 worktree 内的海量事件 —— 必须在 Go 侧过滤

`internal/watch/watch.go:12` `WatchWorkspace(root)` 递归监听，`watch_windows.go:40` `watchDirectory` **没有任何目录过滤**。worktree 是全量检出，AI 在里面触发构建/依赖安装时几万个文件事件会冲出 `overflow`（`ERROR_NOTIFY_ENUM_DIR`），而 `overflow` 时前端 `handleExternalDocChanges` 要对所有打开文档 stat 一遍。

改法：在 `watch.go` 的 emit 回调处（平台无关、可测）加纯函数过滤器：路径归一 `\`→`/` 后命中 `.cadt/worktree` 前缀（含等于）的事件丢弃。**不是跳过整个 `.cadt`**——`.cadt/logs`、`.cadt/patches` 的事件量小且有意义。worktree 内的变更是给 AI 自己看的，UI 不需要刷新；patch 回灌到主根后走正常通知路径。`overflow` 事件本身照发（内核已丢事件，无法过滤；过滤器的作用是**不主动制造** overflow）。

### 4.3 检索污染 —— 两条路径都要跳，不只 `searchSkipDirs`

`.cadt` 不在 `internal/search/search.go:32` 的 `searchSkipDirs` 里，且检索有**两条实现路径**，草稿只覆盖了其一：

- **rg 路径（默认路径）**：`DATALENS_NO_RG` 未设时先走 `searchWithRipgrep`（`search_rg.go`），排除表是硬编码 `--glob`（`search_rg.go:41-45`，镜像 searchSkipDirs），同样不含 `.cadt`。**实施实测（2026-11-17）**：Windows 上 rg 的路径型 `--glob !.cadt/worktree` 不可靠（组件名匹配才是硬保证，见该文件既有注释），所以排除 glob 保留为尽力剪枝之外，`runRgPass` 里加了 `skipRgHit` 按 `SkipPath` 对命中路径二次过滤保底（按 path 缓存）。
- **WalkDir 兜底路径**：`search.go:387`（searchWorkspace）与 `glob.go:112`（FindFiles）按目录名 `searchSkipDirs` 剪枝，按名匹配表达不了 `.cadt/worktree` 这种路径前缀。

不改的后果：`search_workspace` / `find_files` / 全局搜索会同时命中主根和 worktree 里的**同一份代码**——搜一个函数名返回两份，AI 与用户都困惑。

改法：新增按相对路径判断的 `SkipPath(rel string) bool`（rel 为相对检索根的正斜杠路径）：

- `search.go`：WalkDir 目录剪枝处，`filepath.ToSlash` 后取相对路径调 `SkipPath`；
- `glob.go:112`：同上；
- `search_rg.go`：args 追加 `--glob "!.cadt/worktree"` 与 `--glob "!.cadt/worktree/**"`（尽力剪枝），**另加 `skipRgHit` 按 `SkipPath` 对命中路径二次过滤保底**（Windows 上路径型 glob 实测不可靠，见 §4.3 首条）；
- **保留 `.cadt/tmp` 可搜**（AI 的中间产物要能被自己找到），只跳 `worktree/` 子前缀；
- 检索根本身就是 `.cadt/worktree/x` 时必须照常工作（AI 在自己 worktree 里搜代码）：rel 相对检索根计算，根自身永不命中——这是用「相对路径」而非「绝对路径前缀」判断的原因。

### 4.4 AI 的 `list_dir`（`fsops.ReadDirTree`）会展开整个 worktree 副本 —— 草稿遗漏

`internal/fsops/fsops.go:158` `ReadDirTree` 用 `search.SkipDir(name)` 按名剪枝，`.cadt` 不在表里。AI 对主根 `list_dir` 会把整个 worktree 检出副本展开进结果（几千行）。

改法：ReadDirTree 内加相对调用根的 `search.SkipPath` 判断。**调用根例外**：`list_dir('.cadt/worktree/x')` 的调用根就是 worktree，其内部相对路径不以 `.cadt/worktree` 开头，照常列——AI 依然能显式进入自己的 worktree（配合 `<worktree>` 块里的路径提示）。

### 4.5 目录结构树导出（`structuredir`）会渲染整个 worktree 副本 —— 草稿遗漏

`internal/structuredir/structuredir.go:13` `structureDirIgnored` 只有 `.git`/`__pycache__`（`.cadt` 本身就是既有行为里会出现的）。worktree 建好后「导出目录结构树」会把几千行的检出副本渲染进产物。

改法：`structureChildren` 递归时携带相对根路径，命中 `.cadt/worktree` 前缀的整棵跳过（`.cadt/worktree` 目录名本身也不出现）。包内私有函数加参数，低风险。

## 5. 改动清单（按文件）

### Go 侧

| 文件 | 改动 |
|---|---|
| `internal/gitinfo/worktree.go`（新） | `WorktreeList`（`git worktree list --porcelain` 解析：path/branch/head/bare/detached，标 `underCadt` 与 `orphan`）、`WorktreeAdd`（slug 派生 + 防御校验 + `git worktree add -b cadt/wt/<slug> <path>` + 返回 baseSha）、`WorktreeRemove`（`remove --force` + 可选 `branch -D`）、`WorktreePrune`、`WorktreeDiff`（§3.4 序列）。全部走 `gitRun`（`gitinfo.go:40` 唯一执行入口，已有 HideWindow / GIT_TERMINAL_PROMPT=0 / 超时） |
| `internal/gitinfo/worktree_test.go`（新） | 见 §7 |
| `gitinfo_app.go` | 五个转发绑定：`GitWorktreeList(dir)` / `GitWorktreeAdd(dir, label)` / `GitWorktreeRemove(dir, name, deleteBranch)` / `GitWorktreePrune(dir)` / `GitWorktreeDiff(dir, name)`。gitinfo 不 import patch——diff 只出文本，`PatchSave` 编排仍在现有壳/前端 |
| `internal/search/search.go` | `SkipPath` 导出 + WalkDir 剪枝处接入 |
| `internal/search/glob.go` | FindFiles 剪枝处接入 `SkipPath` |
| `internal/search/search_rg.go` | args 追加两条 `--glob` 排除 + `skipRgHit` 命中路径兜底过滤（Windows 实测 glob 不可靠） |
| `internal/search/*_test.go` | `SkipPath` 用例 + rg 路径 fixture（无 rg 则 `t.Skip`，对齐现有测试对环境的态度） |
| `internal/watch/watch.go` | `skipWorktreePath` 纯函数 + emit 回调接入 |
| `internal/watch/watch_test.go`（新） | 过滤用例（平台无关） |
| `internal/fsops/fsops.go` | `ReadDirTree` 接入 `SkipPath`（调用根例外） |
| `internal/structuredir/structuredir.go` | `structureChildren` 携带 rel，跳 `.cadt/worktree` 子树 |
| `frontend/wailsjs/` | `wails dev` / `wails build` 重新生成三件，不手改 |

### 前端侧

| 文件 | 改动 |
|---|---|
| `frontend/src/ai/ai-worktree.js`（新） | worktree 域模块（`createAIWorktree(ctx)` 工厂 + ctx 注入，域模块不互相 import 的约定照旧）：create/export/discard 的确认卡与审批卡流程、`session.worktree` 读写、状态胶囊渲染。**ai-panel.js 已 1.1 万行超线、「只减不增」**——新域必须独立成模块，executeTool 里只留 case 一行转发 |
| `frontend/src/ai/ai-panel.js` | ① `isAutoWriteRisky` 加 `.cadt/worktree/` 豁免（§4.1，两行）；② `executeTool` 加 `worktree_manage` case（转发）；③ init 接线 `createAIWorktree` + 启动 `GitWorktreePrune`；④ 会话恢复时校验 `session.worktree.path` 存在性 |
| `frontend/src/ai/ai-tool-defs.js` | `worktree_manage` def（§6.2 文案）+ `AI_TOOL_CATALOG` 条目 + `AI_TOOL_GROUPS` 分组 + `toolsForScope`（write 档清单）；一致性测试 `ai-tool-defs.test.mjs` 自动卡 |
| `frontend/src/ai/ai-command-rules.js` | `gitFlowSafeCommand` 加 cwd 前缀判断：cwd 在 `.cadt/worktree/` 下时令牌豁免失效（§6.5） |
| `frontend/src/ai/ai-system-context.js` | `worktreeBlock(session)`（§6.3 文案），注入位置紧跟 base 与支线定性块之后（属稳定区），仅 `session.worktree` 存在时注入 |
| `frontend/src/ai/ai-session-store.js` | `session.worktree` 进 meta 序列化/反序列化（对齐 `planMode`/`readRoots` 的写法，`:288`/`:311` 附近） |
| `frontend/src/ai/ai-constants.js` | `AI_COMMANDS` 加 `{name: '/worktree', desc: '…'}`；`ai-slash.js` 加 case 转发 |
| `frontend/src/dev/mock-backend.js` | 补 `GitWorktreeList/Add/Remove/Prune/Diff` 五个 mock（漏了 dev 模式调用即崩） |
| `frontend/test/…` | 见 §7，并**手工登记进 `frontend/package.json` 的 npm test 清单**（硬编码列表） |

## 6. 详细规格

### 6.1 Go API

```go
// internal/gitinfo/worktree.go（签名草案）
type GitWorktreeInfo struct {
    Path      string `json:"path"`           // 绝对路径
    RelPath   string `json:"relPath"`        // 相对仓库根，斜杠分隔
    Branch    string `json:"branch,omitempty"`
    Head      string `json:"head,omitempty"`
    Detached  bool   `json:"detached,omitempty"`
    UnderCadt bool   `json:"underCadt,omitempty"` // 在 .cadt/worktree/ 下
    Orphan    bool   `json:"orphan,omitempty"`    // 一期由调用方补充（不在任何活跃会话）
}

type GitWorktreeListResult struct {
    Available bool              `json:"available"`
    Reason    string            `json:"reason,omitempty"`
    Root      string            `json:"root,omitempty"`
    Items     []GitWorktreeInfo `json:"items"`
}

type GitWorktreeAddResult struct { // = GitWorktreeInfo + baseSha
    Name    string `json:"name"`    // slug
    Branch  string `json:"branch"`
    Path    string `json:"path"`
    BaseSha string `json:"baseSha"`
}

WorktreeList(dir string) (*GitWorktreeListResult, error)
WorktreeAdd(dir, label string) (*GitWorktreeAddResult, error)   // dir = 主根；失败报明确原因（非 git 仓库 / 同名目录 / 分支冲突 / 会话已持有→前端拦）
WorktreeRemove(dir, name string, deleteBranch bool) error
WorktreePrune(dir string) error
WorktreeDiff(dir, name string) (string, error)                  // 空 diff 返回哨兵错误，前端转「没有改动」提示
```

校验顺序（WorktreeAdd）：git 可用 → `rev-parse` 确认 dir 在仓库内 → slug 派生与碰撞重试 → 目标路径不存在 → 分支名不存在 → `worktree add` → 回读 `rev-parse HEAD` 得 baseSha。

工具层约定：`worktree_manage` 的 export/discard **不带 name 参数**，隐式作用于本会话 `session.worktree`——工具面天然消除「跨会话删除他人 worktree」的可能；Go 绑定虽收 `name`，但一律校验其落在 `.cadt/worktree/` 下且目录存在（防路径注入）。

### 6.2 `worktree_manage` 工具定义（文案草案，description 是模型唯一的行为依据）

```js
worktree_manage: {
    name: 'worktree_manage',
    description: [
        '管理本会话的隔离 git worktree（草稿工作区）：改动落在 .cadt/worktree/<slug>/，不直接碰主根，适合有风险的批量改动、大规模重构、不确定能成的试错。',
        'action=create：创建（一个会话同时只能有一个）。创建后 <worktree> 块会给出前缀，之后所有文件改动都写到该前缀下、run_command 的 cwd 传该目录；不要写主根同名文件。',
        'action=list：列出仓库现有 worktree（只读）。',
        'action=export：把 worktree 里相对创建基准的全部改动（含新文件与删除）导出为补丁，交用户在审批卡里审阅后回灌主根。导出是全量语义：上一轮已回灌过的改动再次导出会预检报「不可应用」，属预期——应用成功后应 discard 收尾。worktree 里不要 commit。',
        'action=discard：删除 worktree 与其隔离分支（不可恢复；未 export 的改动会丢）。回灌成功、或用户明确不要这轮试验时用它收尾。',
        '何时不用：常规小改动直接 edit_file/write_file，不要为每次修改开 worktree；依赖安装/跑测试在 worktree 里可能因缺依赖目录（node_modules 等）失败，不要在 worktree 里反复装依赖。',
    ].join('\n'),
    parameters: { action: 'create|list|export|discard', label: 'create 时可选，用途短名（英文/数字/连字符），用于派生目录与分支名' },
}
```

目录条目：`group: 'write'`，blurb：`在隔离 git worktree 里试错改动，导出补丁审阅后回灌主根`。
档位：`toolsForScope` 的 write 档清单（edit/auto/full）追加；计划模式不提供（零副作用契约）；read 档不可见。

### 6.3 `<worktree>` 注入块（文案草案）

```
<worktree>
本会话正在隔离工作区中改代码：所有文件改动写到 .cadt/worktree/<slug>/…（相对范围根），不要改主根同名文件。
- run_command 的 cwd 传 .cadt/worktree/<slug>；git 命令会自动作用于该 worktree 的分支 <branch>。
- 依赖目录（node_modules、venv、Go build cache）不跟 worktree：npm test / go test 可能因缺依赖失败，不要因此反复安装依赖，也不要承诺「能在隔离区跑测试」。
- 完成后调 worktree_manage(action=export) 生成补丁交用户审阅回灌主根；应用成功后建议 discard 收尾。
- 不要 commit 到隔离分支：worktree 是草稿区，分支不保留。
</worktree>
```

### 6.4 审批矩阵

| action | read | edit | auto | full | plan |
|---|---|---|---|---|---|
| create | 工具不可见 | 确认卡 | 确认卡 | 免（档位契约内；写的是 `.cadt/worktree` 已豁免区） | 工具不可见 |
| list | 工具不可见 | 免 | 免 | 免 | 工具不可见 |
| export | 工具不可见 | **patch 卡** | **patch 卡** | **patch 卡**（人工审阅闸门，全档必弹，§3.3） | 工具不可见 |
| discard | 工具不可见 | 确认卡 | 确认卡 | 确认卡（销毁性动作，对齐 `git-worktree-force` 危险语义） | 工具不可见 |

`run_command` 路径的约束不变：`git worktree add/remove` 不进 `GIT_FLOW_SAFE_SUBCOMMANDS`（等于任意目录写盘 + 分支创建，比 add/commit 危险得多），auto 档照常逐条审批；只读白名单里已有的 `worktree list`（`ai-command-rules.js:331`）保持。

### 6.5 权限模型（分层，全部走既有机制，不新造权限面）

| 层 | 机制 | worktree 下的行为 |
|---|---|---|
| 路径硬闸 | `aiResolveScopePath` / `aiPathInside` | 不变：worktree 在根内天然放行；full 档的应用数据目录硬拒仍先于放行 |
| 全局只读锁 | `core/readonly.js`（`settings.readOnlyMode`） | **实施修正（2026-11-17）**：核实后确认 AI 工具面没有 settings.readOnlyMode 闸（那是编辑器文档锁，write_file 也不查它）——`worktree_manage` 与 write_file 同走 AI 档位体系（write 档可见、非计划模式），不单独接文档锁，保持权限面一致 |
| auto 档风险判定 | `isAutoWriteRisky` | `.cadt/worktree/` 精确前缀豁免（§4.1）；脏文件仍 risky，`ai-write-guard.js` 陈旧缓冲防护照常生效 |
| 项目规则 | `.cadt/permissions.json` 的 decidePermission | worktree 路径照常参与（subject = `.cadt/worktree/<slug>/…`）——加一条对 `.cadt/worktree` 的 deny 规则即可整域硬禁该功能，无需新开关 |
| 命令通道 | `approveCommandForRun` 链 | cwd 检查天然通过；**git-flow 令牌豁免在 cwd 位于 `.cadt/worktree/` 下时失效**（`gitFlowSafeCommand` 加前缀判断，回退逐条审批）——防止「Git 快捷操作」令牌被拿去在 worktree cwd 里静默 commit 草稿分支；`worktree add/remove` 不进安全集的约束不变 |
| 回灌闸 | export → patch 审批卡 | 全档必弹（§3.3）；补丁卡即审批，应用不再逐文件过 decidePermission（与 propose_patch 现状一致） |
| 确认卡 | create（edit/auto）/ discard（全档） | 结果进 `logPermission('worktree', slug, …)`，审批记录页可见。实施落点：Promise 化居中弹窗（MutationObserver 监听 dialog hidden，Esc/× 按放弃收敛），在 ai-worktree.js 的 confirmDialog |
| 留痕 | activity-log | create / export / discard 三个动作点记操作摘要（subject `worktree/<slug>`，不记正文与文件清单） |
| 子代理 | 一期只读子代理 | 无写入面，无需处理；二期并行 worktree 时随子代理方案单独设计绑定与权限 |

## 7. 测试计划

Go（表驱动，跟随现有风格；`go test` 一律后台执行、显式 `-timeout`）：

- `internal/gitinfo/worktree_test.go`：临时仓库（对齐现有 gitinfo_test 的环境假设，无 git 则 skip）→ add（label 派生 slug、碰撞后缀、非法 label 折叠）→ list porcelain 解析（underCadt 标记）→ **隔离性**：主根与 worktree 各改同名文件互不影响 → diff 含未跟踪新文件（-N 验证）与删除文件 → `--no-renames` 输出可被 `internal/patch` 解析 → remove（含删分支）→ prune。
- `internal/search/search_test.go`：`SkipPath` 用例——`.cadt/worktree/x/a.js` 跳、`.cadt/tmp/a.md` 不跳、`.cadtworktree/` 不误伤、rel 为空（检索根自身）不跳；有 rg 时 fixture 跑一遍 `searchWithRipgrep` 验证两条 `--glob` 生效（无 rg skip）。
- `internal/watch/watch_test.go`：`skipWorktreePath` 纯函数——正斜杠/反斜杠、等于前缀、`.cadt/worktree-x/` 不误伤。
- `internal/fsops` / `internal/structuredir`：ReadDirTree 与结构树对 `.cadt/worktree` 子树的跳过 + 调用根例外。

前端（`frontend/test/ai/`，镜像 `src/ai/`，登记 npm test 清单）：

- `ai-worktree.test.mjs`（新）：slug/文案纯函数、export 空改动的哨兵处理、只读锁（`settings.readOnlyMode`）下四个 action 全拒。
- `ai-command-rules.test.mjs`：`gitFlowSafeCommand` 对 `.cadt/worktree` cwd 的豁免失效用例（与放行用例同组，防日后误删收紧）。
- `ai-session-store.test.mjs`：`session.worktree` 序列化/反序列化往返。
- `ai-system-context.test.mjs`：有/无 worktree 时 `<worktree>` 块注入。
- **护栏配对用例**（放同一测试组防放宽）：`.cadt/worktree/x/a.js` 免审 **与** `.cadt/permissions.json`、`.cadt/patches/p.patch` 仍 risky 同组断言。
- `ai-tool-defs.test.mjs`：def↔目录↔分组一致性（现有测试自动覆盖新增条目）。

收尾：用户可见变更进 `CHANGELOG.md` 与 `README.md` 对应小节；`wails build` 重新生成 `frontend/wailsjs/`。

## 8. 分期

**一期（已实施，2026-11-17）**
1. Go：gitinfo 五个 worktree 引擎函数 + 绑定转发（含 diff 导出）。
2. 五处护栏（§4.1–§4.5）。
3. `worktree_manage` 工具 + `<worktree>` 注入块 + `session.worktree` 持久化与恢复校验。
4. `/worktree` 斜杠命令 + 状态胶囊。
5. 明确**不承诺「能在 worktree 里跑测试」**（依赖目录不跟 worktree，见 §9）。

**二期（已实施，2026-11-17）**

1. **依赖目录 junction**：`WorktreeAdd` 自动把主根的 `node_modules` / `.venv` / `venv`（白名单，只共享通常 gitignore 的目录，git 跟踪的 vendor 不碰）以 `mklink /J` junction 进 worktree（免管理员权限），结果带 `deps` / `depErrors`；`WorktreeRemove` 先摘 reparse 点再交 git（绝不伤主根依赖，测试断言）。**实施实测**：Go 1.27 Windows 下 `os.Lstat` 对 junction 不报 ModeSymlink/dir（`ReadDir`/`WalkDir` 把 junction 当非目录条目、不下钻——遍历天然安全；`os.Stat`/读写正常跟随），`isReparsePoint` 必须查 `FILE_ATTRIBUTE_REPARSE_POINT`。`<worktree>` 块与工具文案改为「依赖已共享，npm/pip 可直接用」。
2. **改动统计（对比 lite）**：`WorktreeStat`（baseSha 有效对比基准，否则对比 HEAD）+ `worktree_manage` 新增 `stat` action + `list` 每个隔离区附一行未提交改动统计 + 胶囊弹层显示统计。完整并排对比视图仍未做，看使用反馈。
3. **孤儿回收**：存储清理页新条目 `ws-worktrees`（KindDanger，走回收站）——children 过滤 = 会话登记之外才算孤儿；宿主注入 `KeepWorktreeNames`（从 sessionstore metas 收 `worktree.path`），**未注入钩子时一律不清（fail-safe）**。git 侧管理记录由启动 prune 收敛，分支残留写进条目 note。
4. **子代理并行 worktree**：`spawn_agent` 新增 `isolation: 'worktree'`——spawn 时建独立隔离区（失败让派单报错，不静默降级），`subToolsForScope(depth, mode, hasWorktree)` 挂 `write_file` / `edit_file`；写闸在 `applyWorkspaceWrite`：子代理会话（parentSessionId 有值 + worktree 登记）前缀内确定性放行（`agent-worktree` 来源）、前缀外确定性拒绝（`agentWorktreeWriteVerdict` 纯函数），**永不弹卡（隔离区即审批边界）**；`run_command` 仍不给（命令通道归 subagent-sandbox 方案）；`worktree_manage` 的 export / stat / discard 支持可选 `name`，只认「本会话自己的或本会话派生子代理的」隔离区（`resolveWorktreeTarget` 纯函数，归属外拒绝）。子代理提示词带隔离区段（前缀用法 + 不 commit + 结论列改动清单）。

## 9. 明确不做与已知限制

**明确不做**

- **不做自动 merge 回主根**。永远保留人工审阅闸门（export 全档弹 patch 卡，含 full 档）。
- **不给 `run_command` 的 `git worktree add/remove` 开 auto 档免审**。`GIT_FLOW_SAFE_SUBCOMMANDS` 不含它是对的。
- **不把 worktree 建在 `.cadt` 之外**。一旦出 `.cadt`，`aiPathInside` 就不成立，「不用切工作区」的收益立刻归零。
- **不建 `.cadt/worktree/index.json` 登记表**。`git worktree list --porcelain` + `session.worktree` 已覆盖登记与恢复；少一份会失真的缓存。
- **不做会话级路径前缀重写**（§3.4）。
- **不做增量 export**（§3.3：全量语义 + 引导 discard 收尾）。

**已知限制**

- **依赖目录不跟 worktree**：`node_modules`、Go build cache、Python venv 都在主根，worktree 是干净检出。AI 在 worktree 里执行 `npm test` / `go test` 会因缺依赖失败。一期不解决、不承诺——只承诺「能改代码 + diff 审阅」。真要跑测试需二期 junction。
- **跨会话软隔离**：AI 理论上可写其他会话的 `.cadt/worktree/<other>/…`（前缀豁免是整棵）。单用户单机场景接受，二期随子代理并行再收紧。
- **二进制文件改动静默不可回灌**：`git diff` 对二进制只有「Binary files differ」占位，patch 预检会如实标「不可应用」——需要二进制回灌时用户用 git 操作兜底。
- **重复 export 的全量语义**（§3.3）：第二轮预检报「不可应用」是预期行为，文案已引导。
- **`.cadt` 占用会显著增大**：每个 worktree 是一份全量检出；存储清理页的占用统计会如实反映（`internal/storage` 无需改动）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| rg 对 `--glob !.cadt/worktree` 是否真剪枝目录遍历 | 测试 fixture 实测两条 glob；不放心时再补 `--glob !.cadt/worktree/**` 已含双保险（§4.3） |
| `git add -A -N` 在大仓库的耗时 | 只在 export 时执行一次，走 `gitRun` 超时保护；worktree 本身就是新增检出，量级与 add 相当 |
| patch 解析器对 git diff 产物的边角（mode 行、引号路径） | 解析器已支持 git 引号路径；mode 变更等边角由预检如实报错兜底，用户可改用补丁视图手动处理 |
| AI 忘记在 worktree 里改、仍写主根 | `<worktree>` 块每轮注入 + 状态胶囊常驻；主根写入照常走原审批链，不会静默 |
| watch 过滤误伤正常 `.cadt` 事件 | 过滤只命中 `.cadt/worktree` 前缀，`.cadt/logs`、`.cadt/patches` 等照常；护栏测试覆盖 `.cadt/worktree-x` 不误伤 |
| ai-panel.js 超线文件继续膨胀 | 域逻辑独立 `ai-worktree.js`，executeTool 只留一行转发（§5） |
| 「Git 快捷操作」令牌 + worktree cwd 被组合利用，静默 commit 草稿分支 | 令牌豁免在 `.cadt/worktree` cwd 下失效（§6.5），回退逐条审批 |

## 11. 实施顺序

1. Go 引擎：`internal/gitinfo/worktree.go` + 测试（先跑最小用例确认环境假设，再全量）。
2. Go 护栏：`search`（SkipPath 两路径 + rg glob）、`watch`、`fsops`、`structuredir` + 各自测试。
3. 绑定壳：`gitinfo_app.go` 五转发 → `wails dev` 生成 `frontend/wailsjs/` → mock-backend 五 mock。
4. 前端域模块：`ai-worktree.js`（create/export/discard 流程 + 胶囊）→ 工具登记四件套 → executeTool case → `isAutoWriteRisky` 豁免。
5. 会话态：`ai-session-store.js` 字段 → 恢复校验 → `ai-system-context.js` 注入块。
6. 入口：`AI_COMMANDS` + `ai-slash.js`。
7. 测试登记（npm test 清单）→ 全量 `go test ./...`（后台）+ `npm test` → `tools/rebuild-exe.ps1`。
8. CHANGELOG / README。
