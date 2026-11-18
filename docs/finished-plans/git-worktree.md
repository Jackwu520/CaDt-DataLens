# Git worktree：AI 隔离工作区

> 状态：**已实施**（一期 / 二期均已落地，见 §8 各阶段标注与实施实测；2026-11-18 移入 finished-plans 存档）。
> 2026-11-16 起草，2026-11-17 评估并定稿为实施计划。
> 关联：`git-flow-auto-exemption.md`（git 写操作审批）、`subagent-sandbox.md`（隔离思路）、`ai-gen-image-edit.md`（同类「哑通道 + 前端编排」参考）。

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
- **用户表态必须绑定到工具调用（2026-11-17 实测补）**：此前模型会把用户说的「基于 worktree」理解成「参考 worktree 方案文档」，全程在主根规划/开发；计划模式下它连 `worktree_manage` 都不可见，更不会建。现在三处守则显式绑定：`<workspace_rules>` 写档守则「用户以『基于 worktree / 用隔离区 / 在 worktree 里开发』措辞要求时，实施第一步先 `worktree_manage(action=create)`，并声明这不是读方案文档」；计划模式守则与 `<plan_mode>` 块要求「计划 steps 第一项写创建隔离区，批准后才执行」；`worktree_manage` 的 create 描述同步。提示词是行为依据不是硬约束——确定性入口仍是 `/worktree`（见 §3.5）。

### 3.5 入口

- **输入区常驻开关「隔离」**（对齐 ZCode 的 worktree 勾选，2026-11-17 补）：`#ai-worktree` pill 在 composer 底部栏（与「计划」同排、同 `.active`/`aria-pressed` 样式）——勾上=立即创建（确认卡按档位、full 免），取消=确认丢弃（含改动统计）；轮次运行中不许切换；只读档点击给「先切权限档」提示。会话切换/启动/创建/丢弃后由 `syncChip` 同时刷新胶囊与开关。**窄宽度降级（2026-11-17）**：容器查询分两级——内容宽 ≤400px 模型 chip 收成单图标（名字/等级/上限/箭头隐藏，模型名进 tooltip）；≤330px「计划」「隔离」两个 pill 收起、入口移进**权限模式弹窗**的「会话模式」两行（计划模式 / 隔离工作区，带勾选、任何宽度都保留），计划已开用权限胶囊上的强调色圆点提示。
- AI 面板输入框斜杠 `/worktree`（`AI_COMMANDS` 加一条，`ai-slash.js` 转发到 worktree 域模块）。**实施修正（2026-11-17）**：不再是「填提示词」，而是面板直连创建（`createForSession`：确认卡按档位出、full 免 → `GitWorktreeAdd` → 会话登记 + 胶囊），不依赖模型回合，是确定性入口。菜单行「隔离工作区」在已开启时进入**信息卡**（查看路径/分支/改动统计，底部【关闭】【丢弃隔离区】），未开启时创建；输入区 pill 仍是勾选语义（取消=确认丢弃）——两条入口共用 `createForSession` / `discardForSession`，运行中守卫一致。
- 会话获得活跃 worktree 后，头部出一条状态胶囊（`#ai-chip-worktree`，与计时/定时胶囊同排）：注入 folder 图标（compact 档隐藏文字时不做空白圆）、tooltip 带隔离区名；**点击=信息卡**（路径、分支、改动统计、回灌指引，底部【关闭】【丢弃隔离区】两个显式按钮），点胶囊本身不再直接进入丢弃流程。**实施简化（2026-11-17）**：胶囊不带「导出补丁」快捷钮——export 的 patch 审批卡挂在回合的 toolMessage 上（composer takeover 机制），胶囊没有消息载体；一期 export 统一走 AI 的 `worktree_manage(action=export)`。
- 确认弹窗（创建 / 丢弃 / 信息卡）统一走 `confirmDialog`：**按钮回调先 `closeDialog()` 再落定**（2026-11-17 真机修复——此前漏了关窗，表现为「slug 已创建但弹层不消失、点取消也没反应」）。
- 隔离区内的临时文件：worktree 检出不含主根 `.cadt/`，`<worktree>` 块明确「工具路径一律相对主根、临时产物用 `write_file` 写主根 `.cadt/tmp/`（auto 档免审）、不要用 `../` 猜路径、不要用输出重定向写日志再读（复合命令会转人工）」，`run_command` 描述同步补「输出已捕获」。
- AI 也可经 `worktree_manage` 主动 create（走接管 composer 的审批卡，全档必弹），用于「我建议在隔离区里试」的场景。

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

工具层约定：`worktree_manage` 的 export/stat/discard 缺省作用于本会话 `session.worktree`；**二期新增可选 `name`**，只认本会话自己的或本会话派生子代理的隔离区（`resolveWorktreeTarget` 纯函数，归属外拒绝）——工具面天然消除「跨会话删除他人 worktree」的可能；Go 绑定一律校验路径落在 `.cadt/worktree/` 下且目录存在（防路径注入）。

### 6.2 `worktree_manage` 工具定义（文案草案，description 是模型唯一的行为依据）

```js
worktree_manage: {
    name: 'worktree_manage',
    description: [
        '管理本会话的隔离 git worktree（草稿工作区）：改动落在 .cadt/worktree/<slug>/，不直接碰主根，适合有风险的批量改动、大规模重构、不确定能成的试错。',
        'action=create：创建（一个会话同时只能有一个；走 composer 审批卡，全档必弹）。创建后 <worktree> 块会给出前缀，之后所有文件改动都写到该前缀下、run_command 未显式传 cwd 时默认就在隔离区；不要写主根同名文件。',
        'action=list：列出仓库现有 worktree（只读）。',
        'action=export：把 worktree 里相对创建基准的全部改动（含新文件与删除）导出为补丁，交用户在审批卡里审阅后回灌主根。导出是全量语义：上一轮已回灌过的改动再次导出会预检报「不可应用」，属预期——应用成功后应 discard 收尾。worktree 里不要 commit。',
        'action=discard：删除 worktree 与其隔离分支（不可恢复；未 export 的改动会丢）。回灌成功、或用户明确不要这轮试验时用它收尾。',
        '何时不用：常规小改动直接 edit_file/write_file，不要为每次修改开 worktree；依赖共享只覆盖主根顶层的 node_modules/.venv/venv，子目录依赖（如 frontend/node_modules）缺就只在隔离区里装一次，不要手动 mklink 借主根目录。',
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
- run_command / background_command 未显式传 cwd 时默认在 .cadt/worktree/<slug> 里执行；git 命令会自动作用于该 worktree 的分支 <branch>。要看主根显式传 cwd='.'。
- 依赖共享只覆盖主根顶层的 node_modules/.venv/venv；子目录依赖（如 frontend/node_modules）缺就在隔离区里装一次，不要手动 mklink 借主根目录（删除时会跟进 junction 删空目标）。Go 无需共享。
- 完成后调 worktree_manage(action=export) 生成补丁交用户审阅回灌主根；应用成功后建议 discard 收尾。
- 不要 commit 到隔离分支：worktree 是草稿区，分支不保留。
</worktree>
```

### 6.4 审批矩阵

| action | read | edit | auto | full | plan |
|---|---|---|---|---|---|
| create（**AI 主动**） | 工具不可见 | **composer 审批卡** | **composer 审批卡** | **composer 审批卡**（2026-11-17 起全档必弹） | 工具不可见 |
| create（用户手点开关/菜单） | — | 居中确认弹窗 | 居中确认弹窗 | 免（既有档位契约；写的是 `.cadt/worktree` 已豁免区） | — |
| list | 工具不可见 | 免 | 免 | 免 | 工具不可见 |
| export | 工具不可见 | **patch 卡** | **patch 卡** | **patch 卡**（人工审阅闸门，全档必弹，§3.3） | 工具不可见 |
| discard（**AI 主动**） | 工具不可见 | **composer 审批卡** | **composer 审批卡** | **composer 审批卡**（销毁性动作，全档必弹） | 工具不可见 |
| discard（用户手点胶囊/开关） | — | 居中确认弹窗 | 居中确认弹窗 | 居中确认弹窗 | — |

`run_command` 路径的约束不变：`git worktree add/remove` 不进 `GIT_FLOW_SAFE_SUBCOMMANDS`（等于任意目录写盘 + 分支创建，比 add/commit 危险得多），auto 档照常逐条审批；只读白名单里已有的 `worktree list`（`ai-command-rules.js:331`）保持。

### 6.5 权限模型（分层，全部走既有机制，不新造权限面）

| 层 | 机制 | worktree 下的行为 |
|---|---|---|
| 路径硬闸 | `aiResolveScopePath` / `aiPathInside` | 不变：worktree 在根内天然放行；full 档的应用数据目录硬拒仍先于放行 |
| 全局只读锁 | `core/readonly.js`（`settings.readOnlyMode`） | **实施修正（2026-11-17）**：核实后确认 AI 工具面没有 settings.readOnlyMode 闸（那是编辑器文档锁，write_file 也不查它）——`worktree_manage` 与 write_file 同走 AI 档位体系（write 档可见、非计划模式），不单独接文档锁，保持权限面一致 |
| auto 档风险判定 | `isAutoWriteRisky` | `.cadt/worktree/` 精确前缀豁免（§4.1）；脏文件仍 risky，`ai-write-guard.js` 陈旧缓冲防护照常生效 |
| 项目规则 | `.cadt/permissions.json` 的 decidePermission | worktree 路径照常参与（subject = `.cadt/worktree/<slug>/…`）——加一条对 `.cadt/worktree` 的 deny 规则即可整域硬禁该功能，无需新开关 |
| **主根只读闸（主会话，2026-11-17 真机补）** | `mainRootWriteVerdict`（ai-worktree.js） | 隔离区开启期间 `write_file` / `edit_file` 写主根**确定性拒绝**（全档生效，含完全权限；`.cadt/tmp/` 临时产物与范围外绝对路径除外），返回 `WORKTREE_MAIN_READONLY` 指引：改到 `.cadt/worktree/<slug>/…`、冲突在隔离区修正后重新 export。背景：导出预检冲突时模型会「直接改主根对齐」（真机 `edit_file` 改 `style.css` +23 −18），绕过回灌审批卡。`/init` 是应用代发的用户动作，豁免（`appInitiated`）。 |
| 命令通道 | `approveCommandForRun` 链 | cwd 检查天然通过；**命令默认 cwd（`commandCwdOf`）**：隔离会话未显式传 `cwd` 时默认落在隔离区（`run_command` / `background_command` 同口径），防止相对路径命令误改主根；要看主根需显式 `cwd='.'`（隔离开启时主根应只读，写操作仍受项目 deny / 审批链约束）。**git-flow 令牌豁免在 cwd 位于 `.cadt/worktree/` 下时失效**（`gitFlowSafeCommand` 加前缀判断，回退逐条审批）——防止「Git 快捷操作」令牌被拿去在 worktree cwd 里静默 commit 草稿分支；`worktree add/remove` 不进安全集的约束不变。**档位竞态（2026-11-17 真机修复）**：分类器判定最长等 12s，等待期间切到完全权限后迟到的 ask 不再弹卡——`requestCommandApproval` 按当前档位重判（`scopeUpgradedToFull`：full 下除项目 ask 规则外一律自动放行并留痕）。 |
| 回灌闸 | export → patch 审批卡 | 全档必弹（§3.3）；补丁卡即审批，应用不再逐文件过 decidePermission（与 propose_patch 现状一致） |
| 确认卡 | **AI 主动 create / discard → 接管 composer 的审批卡（全档必弹，含完全权限）**；用户手点「隔离」开关 / 胶囊信息卡 → 居中确认弹窗 | AI 路径：`requestWorktreeApproval` 建 `approval.kind='worktree'` 走 `pendingApprovals`，卡片在 `ai-takeover.js` 的 `renderWorktreeTakeover`（创建显示用途/路径/分支；丢弃附改动统计与丢失警告），支持临时收起；裁定由 `decideApproval` 统一落状态并 resolve。用户路径：Promise 化居中弹窗（MutationObserver 监听 dialog hidden，Esc/× 按放弃收敛）保留在 ai-worktree.js 的 confirmDialog。两者结果都进 `logPermission('worktree', slug, …)`，审批记录页可见。 |
| 留痕 | activity-log | create / export / discard 三个动作点记操作摘要（subject `worktree/<slug>`，不记正文与文件清单） |
| 子代理 | 二期已实施（`isolation: 'worktree'`） | 子代理写闸 `agentWorktreeWriteVerdict`：自己的前缀内自动应用、前缀外拒绝、永不弹卡；权限档随父会话（read/edit 只读、auto 工作区可写、full 不圈定）；命令通道走 `internal/sandbox`。`worktree_manage` 的 export/discard 支持可选 `name`，只认本会话或本会话派生子代理的隔离区（`resolveWorktreeTarget`）。 |

## 7. 测试计划

Go（表驱动，跟随现有风格；`go test` 一律后台执行、显式 `-timeout`）：

- `internal/gitinfo/worktree_test.go`：临时仓库（对齐现有 gitinfo_test 的环境假设，无 git 则 skip）→ add（label 派生 slug、碰撞后缀、非法 label 折叠）→ list porcelain 解析（underCadt 标记）→ **隔离性**：主根与 worktree 各改同名文件互不影响 → diff 含未跟踪新文件（-N 验证）与删除文件 → `--no-renames` 输出可被 `internal/patch` 解析 → remove（含删分支）→ prune。
- `internal/search/search_test.go`：`SkipPath` 用例——`.cadt/worktree/x/a.js` 跳、`.cadt/tmp/a.md` 不跳、`.cadtworktree/` 不误伤、rel 为空（检索根自身）不跳；有 rg 时 fixture 跑一遍 `searchWithRipgrep` 验证两条 `--glob` 生效（无 rg skip）。
- `internal/watch/watch_test.go`：`skipWorktreePath` 纯函数——正斜杠/反斜杠、等于前缀、`.cadt/worktree-x/` 不误伤。
- `internal/fsops` / `internal/structuredir`：ReadDirTree 与结构树对 `.cadt/worktree` 子树的跳过 + 调用根例外。

前端（`frontend/test/ai/`，镜像 `src/ai/`，登记 npm test 清单）：

- `ai-worktree.test.mjs`（新）：slug/文案纯函数、`mainRootWriteVerdict` 主根只读判定、`manageTool(create/discard)` 的 AI 审批闸（批准前不落盘、丢弃卡带统计）、`<worktree>` 提示词块断言。
- `internal/gitinfo/worktree_test.go`：生命周期 / junction 共享 / `TestWorktreeRemoveNestedJunction`（嵌套 junction 删除不得伤主根目标）。
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

1. **依赖目录 junction**：`WorktreeAdd` 自动把主根**顶层**的 `node_modules` / `.venv` / `venv`（白名单，只共享通常 gitignore 的目录，git 跟踪的 vendor 不碰）以目录联接接进 worktree（`FSCTL_SET_REPARSE_POINT` 原生创建，免管理员权限、不经 cmd.exe），结果带 `deps` / `depErrors`；`WorktreeRemove` 先**递归摘掉 worktree 内所有 reparse 点**再交 git（只删链接、绝不伤目标，fail-closed），`WorktreeDiff` 的 `git add -N` 对 junction 路径加 exclude pathspec（防止未 gitignore 的依赖目标被当成新文件导出）。**实施实测**：Go 1.27 Windows 下 `os.Lstat` 对 junction 不报 ModeSymlink/dir（`ReadDir`/`WalkDir` 把 junction 当非目录条目、不下钻——遍历天然安全；`os.Stat`/读写正常跟随），`isReparsePoint` 按 reparse tag 精确判定（只认 MOUNT_POINT/SYMLINK，云占位符/去重/ProjFS 不算）。`<worktree>` 块与工具文案说明「只共享主根顶层依赖；子目录依赖在隔离区里装，禁止手动 mklink」。
2. **改动统计（对比 lite）**：`WorktreeStat`（baseSha 有效对比基准，否则对比 HEAD）+ `worktree_manage` 新增 `stat` action + `list` 每个隔离区附一行未提交改动统计 + 胶囊弹层显示统计。完整并排对比视图仍未做，看使用反馈。
3. **孤儿回收**：存储清理页新条目 `ws-worktrees`（KindDanger，走回收站）——children 过滤 = 会话登记之外才算孤儿；宿主注入 `KeepWorktreeNames`（从 sessionstore metas 收 `worktree.path`），**未注入钩子时一律不清（fail-safe）**。git 侧管理记录由启动 prune 收敛，分支残留写进条目 note。
4. **子代理并行 worktree**：`spawn_agent` 新增 `isolation: 'worktree'`——spawn 时建独立隔离区（失败让派单报错，不静默降级），`subToolsForScope(depth, mode, hasWorktree)` 挂 `write_file` / `edit_file`；写闸在 `applyWorkspaceWrite`：子代理会话（parentSessionId 有值 + worktree 登记）前缀内确定性放行（`agent-worktree` 来源）、前缀外确定性拒绝（`agentWorktreeWriteVerdict` 纯函数），**永不弹卡（隔离区即审批边界）**；`run_command` 仍不给（命令通道归 subagent-sandbox 方案）；`worktree_manage` 的 export / stat / discard 支持可选 `name`，只认「本会话自己的或本会话派生子代理的」隔离区（`resolveWorktreeTarget` 纯函数，归属外拒绝）。子代理提示词带隔离区段（前缀用法 + 不 commit + 结论列改动清单）。
5. **主根只读闸（2026-11-17 真机补）**：导出预检冲突时模型绕过审批直接 `edit_file` 主根（`style.css` +23 −18）——`applyWorkspaceWrite` 新增主会话隔离写闸 `mainRootWriteVerdict`：隔离期间只允许写自己的隔离前缀与 `.cadt/tmp/`（全档生效）；`run_command` / `background_command` 的默认 cwd 改为隔离区（`commandCwdOf`）；`<worktree>` 块补「主根只读 + 冲突在隔离区修正后重新 export」指引（配 `ai-worktree.test.mjs` 断言）。
6. **AI 动作审批卡 + 嵌套 junction 防误删（2026-11-17 真机补）**：① `worktree_manage(create/discard)` 从居中确认弹窗改为**接管 composer 的审批卡**（`approval.kind='worktree'`，全档必弹含 full；丢弃卡附改动统计），用户手点的开关/信息卡仍用居中弹窗；② 真机发现 AI 手动 `mklink /J frontend/node_modules` 借主根依赖后，discard 时 `git worktree remove --force` 跟进 junction 把主根依赖删空——`WorktreeRemove` 改为先递归摘掉 worktree 内所有 reparse point（`unlinkReparsePoints`），提示词改为「只共享主根顶层依赖、子目录缺依赖在隔离区里装、禁止手动 mklink」；配 Go 嵌套 junction 用例。
7. **参照 ZCode managed-worktree 补齐（2026-11-18）**：① 隔离会话的 `propose_patch` **全档必弹**（`patchAllowApply` 增 `worktreeActive` 维度，`apply=false` 仍只产出文件）——主根只读下回灌必须过审；② **`.worktreeinclude`**（对齐 ZCode §3.4）：创建时按仓库根清单拷贝「被忽略且匹配」的 dotfiles（junction 覆盖不了），失败不致命；③ **`carry=true` 带入主根未提交改动**（对齐 ZCode fork 的 binary patch：暂存 `--index` + 未暂存 + 未跟踪拷贝），打快照 commit 推进 baseSha，export 只含 AI 草稿；④ 丢弃前查终端占用（`TermList` 的 cwd 前缀）；⑤ `gitRun` 剔除 `GIT_DIR` 等重定向变量（环境隔离）；⑥ 用户手点的创建/丢弃合成 `worktree_manage` 工具卡写进会话历史（对齐 ZCode 的「已创建 worktree」timeline part）；⑦ 审批卡结构化观感（键值明细行 + 提示条），创建卡按 `predictWorktreeSlug`（Go 同规则）显示真实 slug，统计改 `+45 −39 · 3 文件` 紧凑汇总（`worktreeStatTotals`）；顺带修 `WorktreeStat` 缺 `add -N` 导致未跟踪文件不进统计的真 bug。

## 9. 明确不做与已知限制

**明确不做**

- **不做自动 merge 回主根**。永远保留人工审阅闸门（export 全档弹 patch 卡，含 full 档）。
- **不给 `run_command` 的 `git worktree add/remove` 开 auto 档免审**。`GIT_FLOW_SAFE_SUBCOMMANDS` 不含它是对的。
- **不把 worktree 建在 `.cadt` 之外**。一旦出 `.cadt`，`aiPathInside` 就不成立，「不用切工作区」的收益立刻归零。
- **不建 `.cadt/worktree/index.json` 登记表**。`git worktree list --porcelain` + `session.worktree` 已覆盖登记与恢复；少一份会失真的缓存。
- **不做会话级路径前缀重写**（§3.4）。
- **不做增量 export**（§3.3：全量语义 + 引导 discard 收尾）。

**已知限制**

- **依赖共享只覆盖主根顶层**：`linkDepDirs` 只把主根顶层的 `node_modules` / `.venv` / `venv` junction 进来；依赖放在子目录（如本项目的 `frontend/node_modules`）不会自动共享，隔离区里跑测试会缺依赖——正确做法是在隔离区里 `npm install`（装进隔离区自己的目录），dotfiles 类（`.env`）用仓库根的 `.worktreeinclude` 清单声明（创建时自动拷贝）。**绝不允许手动 `mklink /J` 借主根目录**：`git worktree remove --force` 在 Windows 上会跟进 junction 递归删空目标（2026-11-17 真机事故），删除侧已加 `unlinkReparsePoints` 递归摘链兜底，但手动 junction 仍是危险动作。Go 的模块与构建缓存在用户级，无需共享。
- **跨会话软隔离**：主会话写闸只放行**自己的**隔离前缀与 `.cadt/tmp/`（2026-11-17 起 `mainRootWriteVerdict` 收紧），其他会话的 `.cadt/worktree/<other>/…` 与 `run_command` 通道仍可触达（命令不按写路径拦截）。单用户单机场景接受。
- **命令通道不是硬沙箱**：主会话的 `run_command` 在隔离会话里默认 cwd 落在隔离区，但显式 `cwd='.'` / 绝对路径 / `terminal` 工具仍可操作主根——隔离的红线由「写工具只读闸 + 回灌审批卡」承担，不做 OS 级主根只读（子代理才有 `internal/sandbox`）。完全权限本就是对主机的全权授权，隔离只是防误伤与防绕过审阅的工程约束。
- **孤儿隔离区走回收站而非递归删除**：存储清理的 `ws-worktrees` 是 `KindDanger`，`removePath` 强制走 `RemoveToRecycleBin`（SHFileOperation 移动，不跟进 junction），没有回收站时直接拒绝；不会走 `os.RemoveAll` 的缓存直删路径。
- **写闸按路径前缀判定，不做文件系统级校验**：若隔离区内被手动建了「指回主根」的 junction（如 `mklink /J .cadt/worktree/<slug>/src <主根>/src`），再经该前缀写入即可穿透。提示词明确禁止手动 mklink，删除侧递归摘链兜底；要堵死需 OS 级沙箱（子代理才有）。单用户单机场景接受，随 `subagent-sandbox` 的推广再评估。
- **二进制文件改动静默不可回灌**：`git diff` 对二进制只有「Binary files differ」占位，patch 预检会如实标「不可应用」——需要二进制回灌时用户用 git 操作兜底。
- **重复 export 的全量语义**（§3.3）：第二轮预检报「不可应用」是预期行为，文案已引导。
- **`.cadt` 占用会显著增大**：每个 worktree 是一份全量检出；存储清理页的占用统计会如实反映（`internal/storage` 无需改动）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| rg 对 `--glob !.cadt/worktree` 是否真剪枝目录遍历 | 测试 fixture 实测两条 glob；不放心时再补 `--glob !.cadt/worktree/**` 已含双保险（§4.3） |
| `git add -A -N` 在大仓库的耗时 | 只在 export 时执行一次，走 `gitRun` 超时保护；worktree 本身就是新增检出，量级与 add 相当 |
| patch 解析器对 git diff 产物的边角（mode 行、引号路径） | 解析器已支持 git 引号路径；mode 变更等边角由预检如实报错兜底，用户可改用补丁视图手动处理 |
| AI 忘记在 worktree 里改、仍写主根 | `<worktree>` 块每轮注入 + 状态胶囊常驻；**主根写工具确定性拒绝**（`mainRootWriteVerdict`，全档生效，2026-11-17 真机补）——不再依赖审批链（完全权限下没有卡） |
| watch 过滤误伤正常 `.cadt` 事件 | 过滤只命中 `.cadt/worktree` 前缀，`.cadt/logs`、`.cadt/patches` 等照常；护栏测试覆盖 `.cadt/worktree-x` 不误伤 |
| 手动 junction 借主根依赖，discard 时被 git 递归删除牵连主根 | `WorktreeRemove` 先 `unlinkReparsePoints` 递归摘掉所有 reparse point（只删链接、不动目标，`WalkDir` 对 junction 不下钻）；worktree 根本身是链接时 fail-closed 拒绝；提示词与工具描述禁止手动 mklink；`TestWorktreeRemoveNestedJunction` / `TestWorktreeRemoveRejectsRootJunction` 覆盖 |
| 工作区/依赖目录名含 cmd 元字符（`&` `%` 等）导致 junction 创建被注入或假成功 | `createJunction` 改用 `FSCTL_SET_REPARSE_POINT` 原生创建，不经 cmd.exe；`TestCreateJunctionMetachars` 覆盖 |
| 未 gitignore 的 junction 目标被 `git add -N` 索引进导出补丁 | `WorktreeDiff` 对 `reparseRelPaths` 逐个加 `:(exclude,literal)` pathspec；`TestWorktreeJunctionDeps` 断言导出不含 junction 目标 |
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
