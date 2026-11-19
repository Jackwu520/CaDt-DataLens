# 隔离区 export 可信化改进方案

> 状态：**方案重定向**（2026-11-19 立项，同日调研后调整）。依据 `docs/reports/worktree-usability-2026-11-19.md` 的三轮实测复盘 + 业界做法调研。
>
> 核心结论：**三方合并才是正解，双向打补丁救不了基准漂移**。carry=true 已经在 `wt.baseSha` 做了快照 commit——三方合并所需的 merge-base 免费存在，export 现在却丢掉基准、拿 diff 硬对主根当前文件，这是三轮全部撞墙的结构性原因。git 自带的 `git apply -3` 与 `git merge-tree --write-tree` 能直接补上，自研 patch 引擎不必继续堆模糊策略。
>
> 初版方案（PatchPreviewText 预检 + hunk 反向匹配 + baseHash 诊断）降级为兜底路径，存档见 §8。

## 1. 问题回顾（来自复盘报告）

| # | 症状 | 实测影响 |
| --- | --- | --- |
| 1 | `applied=9 skipped=4` 与「没有任何文件可直接应用」两类输出并存 | 误判「全失败」，触发破坏性补救（cp 主根文件重做 diff，混入他人改动） |
| 2 | 重复 export 把已回灌 hunk 报成冲突 | 每轮需人工辨别「真冲突 vs 已完成」 |
| 3 | 一次只报一个文件的第一个失败 hunk | 反复 export 才看全原因 |
| 4 | 无 dry-run | 只能「导了才知道冲突」 |
| 5 | 基准漂移无出路 | 三轮全部撞上，均以 discard + 主根手工补收尾 |
| 6 | 隔离区缺 `node_modules`/`wailsjs`/`dist` | 造成两次测试假失败 |
| 7 | `discard` 无保底快照 | 靠人记「该导的都导了」 |
| 8 | AI 撞上冲突后纠结，试图直改主根被拦 | 报错不给出路，AI 行为不可控（复盘 §五问题 8 + 用户观察） |

## 2. 调研结论（2026-11-19）

### 2.1 关键代码事实

- `GitWorktreeAdd` carry=true 时把主根未提交状态冻结成快照 commit（回执里的 `baseSha`）——**这就是三方合并的 merge-base**。
- `GitWorktreeDiff`（`internal/gitinfo/worktree.go:759`）产出标准 `git diff --no-renames baseSha`，自带 `index <blob>..<blob>` 行；worktree 与主根共享对象库，pre-image blob 全部可解析 → **`git apply -3` 在主根侧直接可用，无需任何自研合并算法**。
- 现有 `internal/patch` 引擎是双向补丁：hunk 上下文硬对当前文件，只有 `AllowOffset` / `IgnoreWhitespace` 两个容错维度，没有「基准」概念。行号漂移能救，语义重叠（主根同处改动）必死。

### 2.2 业界参考

| 参考 | 做法 | 对本方案的启示 |
| --- | --- | --- |
| `git apply -3` | 补丁带 blob 身份时，应用失败自动退化为三方合并（base=pre-image blob，ours=当前工作区，theirs=补丁结果）；真冲突留 `<<< >>>` 标记 | **应用层直接用，零自研** |
| `git merge-tree --write-tree`（git ≥2.38） | 不动索引、不动工作树跑一次真 merge（三方内容合并 + rename 检测 + 目录冲突处理），输出合并 tree + 冲突文件清单（含冲突类型）+ 信息性消息；`--merge-base=<commit>` 显式指定基准 | **dry-run 的完美答案**：三栏报告的分类逻辑 git 全代劳 |
| Aider | 应用失败逐级放宽：归一化 hunk → 补模型漏写的 + 行 → 相对缩进 → 拆大 hunk → 上下文窗口缩到 0 → 临时仓库 cherry-pick 应用（≈3way）。实测：禁用灵活打补丁后编辑错误 +9 倍 | `AllowOffset`/`IgnoreWhitespace` 只覆盖其前两级；「拆 hunk」与「临时仓库 cherry-pick」是兜底补强方向 |
| Cursor fast-apply | 意图与精确 diff 解耦，小模型/Myers 模糊锚点重放到当前文件 | 应用层容错是合理设计，问题出在容错维度不够 |
| Claude Code | Edit 精确匹配失败即把结构化错误喂回模型重试 | **冲突报告必须可消费**：附「主根该文件相对基准改了什么」，AI 才能在隔离区重做而不是伸手碰主根 |
| `git patch-id` / `git cherry` | diff 的稳定指纹；`git cherry` 靠它标记「已在上游」的补丁 | **已应用识别第一层**，比 hunk 反向匹配可靠；反向匹配降为兜底启发式 |

### 2.3 为什么放弃初版方案作为主路径

初版方案（§8 存档）仍在双向打补丁框架内修补：

1. `PatchRepreview` 的位移搜索只能救行号漂移，救不了语义重叠——复盘问题 5 三轮撞的就是主根真改动，不是漂移；
2. 「已应用」识别、三栏报告全要自研（hunk 反向匹配 + baseHash 比对），工作量大且启发式易误判（方案里自己承认了局限）；
3. `git apply -3` + `merge-tree` 把分类、合并、冲突定位全部交给 git，实现量反而更小。

初版方案的价值被吸收：`PatchPreviewText` 零副作用预检保留为 blob 不可解析时的 dry-run 兜底；hunk 反向匹配保留为「已应用」识别的兜底启发式。

## 3. 新方案：分层骨架

| 层 | 手段 | 解决 |
| --- | --- | --- |
| L0 已应用识别 | `git patch-id --stable` 指纹比对 + hunk 反向匹配兜底 | 问题 2 |
| L1 dry-run | 双侧临时快照 + `git merge-tree --merge-base=baseSha`，零副作用三栏报告 | 问题 3、4、5 诊断 |
| L2 应用 | 主根侧 `git apply -3`，真冲突留标记或 .rej | 问题 1、5 出路 |
| L3 AI 出路 | 拒绝信息给路径 + 冲突报告附主根侧 diff + 包 D 四项 | 问题 6、7、8 |

### L0：已应用识别

- export 前对 `diffText` 跑 `git patch-id --stable` 得指纹，与会话记录的上次导出指纹比对；命中即整份「已应用，无需重做」。
- **指纹局限要写明**：只对「整份 diff 与上次导出完全一致」命中。export 后 AI 又在隔离区继续改是常态，此时整份指纹必不命中（diff 全量语义相对 baseSha，新旧 hunk 混在一起），只能靠按文件反向匹配识别「已应用」部分。
- 反向匹配（目标文件当前内容按序包含该 hunk 全部 + 行即视为已应用）——**启发式，只影响报告措辞**，不改变实际应用行为；真可应用仍以 L1 分类为准。

### L1：dry-run 三栏报告

1. 主根与隔离区各做一次**临时快照**：`GIT_INDEX_FILE=<临时文件> git add -A` + `git write-tree` / `commit-tree`。**必须用临时 index**——直接 `add -A` 会覆盖主根用户已 staged 的内容（用户可能正准备提交），且事后恢复 index 本身是危险动作；临时 index 是 `git stash` 的内部做法，根本不碰主根 index。隔离区侧统一用同一做法（简单一致）。pathspec 排除 `.cadt/` 等目录（参照 carry 已有做法与 `worktree.go` 的 junction 排除经验）。性能注记：临时 index 每次全量重建，大仓库秒级开销，export 低频可接受。
2. `git merge-tree --write-tree --merge-base=<wt.baseSha> <ours快照> <theirs快照>`：
   - exit 0 → 全部干净合入，报告「本次可应用 N」；
   - exit 1 → 解析 Conflicted file info 段得真冲突清单（含 modify/modify、rename/delete 等类型），其余文件归「合并可解」。
3. L0 识别为「已应用」的文件单列「无需重做」。
4. 全程零副作用；报告进 export 审批卡。
5. **版本门槛**：`merge-tree --write-tree` 需 git ≥2.38（2022-10）。检测到更低版本时 L1 降级走初版 `PatchPreviewText` 链路（§8），L2 维持 `PatchSave` 现状，能力打折但不出错。配套：worktree 工具入口复用 gitinfo 现有 `Available=false` 机制（同 graph/status 面板模式），AI 调 `create` 前就给出「未安装 git」或「git 版本过低，建议升级到 2.38+ 以获得冲突消解能力」的提示，而不是等命令失败后报错。

注意：merge-tree 产出的冲突文件内容带 `<<< >>>` 标记，**只能用于报告，不得直接写入主根**。

### L2：应用

- **执行前重跑一次 L1**（快照便宜）：审批有用户审阅间隔，期间主根可能又变，避免「报告说能合、实际已冲突」的竞态。
- 审批通过后，主根侧 `git apply -3 <diffText>`（经新 Go 绑定）。
- **实施时必须先验证的两个 git 行为**（同初版对 StripLevel 的处理方式，先实测再定实现）：
  - `--3way` 隐含 `--index`，要求「工作区文件与 index 一致」，不一致时整个 patch 拒绝。主根 staged/unstaged 混合是常态——若实测此场景被拒，需逐文件判断或设计 index 侧的临时处理，**不能默默改写用户 index**；
  - `--3way` 会把冲突写进主根 index 的 higher stages（`git status` 显示 unmerged paths）。apply 发生在审批后，写主根语义没破，但需要明确善后策略：收集完冲突报告后恢复 index 原样，还是保留 unmerged 状态交用户用 git 工具接手——实施前定。
- `--3way` 与 `--reject` 互斥：部分应用改为**按文件粒度拆分 diff 分别调用**，天然得到逐文件 applied/skipped 报告（代价：整体不再是原子操作，逐文件结果即为真值）。
- **L1 与 L2 是两套引擎**（merge-tree vs apply-3）：rename 处理不同（merge-tree 有 rename 检测，apply -3 按 delete+add 落地）、边界结论可能不同。现有 diff 已 `--no-renames`，主场景一致；实测若发现系统性偏差，**以 apply -3（真正执行者）为准修正报告分类**。
- 真冲突文件由 git 留 `<<< >>>` 标记，配合 L3 的报告交 AI 在审批语义下处理。
- 自研引擎路径（`PatchSave`）保留为兜底（blob 不可解析、git < 2.38）。

### L3：AI 出路（原问题 8 + 包 D 不变）

1. `WORKTREE_MAIN_READONLY` 拒绝信息直接给可行路径（「先 discard 隔离区」或「用 propose_patch 提交」）。
2. L1/L2 冲突报告附「主根该文件相对基准改了什么」（`git diff baseSha <ours快照> -- <file>`），AI 据此在隔离区重做对应文件，而不是尝试直改主根。
3. 包 D 四项维持不变：create 回执自举提示 → 漂移诊断（现可由 L1 报告自然覆盖，不再需要 baseHash 自算）→ discard 前保底 `.patch` → export 状态标记（`exportedAt` / `lastExportPatch`）。

### 报告体量护栏（防上下文爆炸）

冲突多时报告本身成为新的上下文风险源——尤其是 L3 的「主根侧 diff」：大重构场景下单文件 diff 即可上万行，几十个冲突文件全内联进工具回执会塞满会话。与项目既有惯例一致（wipeguard 通知 8 条截断、worklog 只存标题一句话），定三条硬规则：

1. **工具回执只给索引，不给全文**。export 回执给 AI 的部分上限约 60 行：汇总行（可应用 N / 合并可解 M / 真冲突 K / 已应用 J）+ 真冲突清单最多前 20 条（文件名 + 冲突类型，一行一条），超出折叠为「…另有 N 个文件冲突」；merge-tree 的 free-form messages 只提取含文件名的行，同样受 20 条上限。**全量报告每次 export 独立落盘，不覆盖**：`<主根>/.cadt/worktree/<name>/export-report-<yyyyMMdd-HHmmss>.md`（**必须落主根侧**——隔离区会被 discard 连目录一起删掉），与当次导出的 `.patch` 同源（L2 落 `.cadt/patches/` 已有同名去重机制，报告文件名跟随补丁文件名便于历史对齐）；回执与 worktree 记录（`lastExportReport`，与 `lastExportPatch` 并列）都指向**本次**文件，历史报告保留供「这次和上次差在哪」比对，discard 清理时随隔离区记录一并清。用户在审批卡/编辑器看全量（UI 不占模型上下文），AI 要细节再按需读。
2. **主根侧 diff（L3 第 2 条）绝不内联进回执**。回执只给「文件名 + 主根是否被改过」的判定；AI 需要细节时走按需通道逐文件拉取（`worktree_manage` 新增 `action=conflict_detail`，或复用现有 diff 绑定），单文件 diff 封顶 200 行，超出提示改用 `search_text` 定位符号。与复盘问题 3「一次列全」不矛盾：列全的是**文件级**清单（每文件一行，便宜），hunk 级/内容级细节按需取（贵）。
3. **冲突文件内容（带 `<<< >>>` 标记）永不进上下文**。merge-tree 的结果 tree 只用于报告分类；AI 要看冲突现场应直接读主根/隔离区工作区文件本身（现有 read 通道，天然有分页与体量控制）。

## 4. Go 侧改动清单（新）

| 改动 | 位置 | 说明 |
| --- | --- | --- |
| `GitApply3Way(root, patchText)` | gitinfo + Wails 绑定 | 跑 `git apply -3`，捕获退出码、stdout/stderr、冲突文件列表 |
| 工作区临时快照辅助 | internal/gitinfo | `GIT_INDEX_FILE=<临时文件>` 下 `add -A`（带 pathspec 排除）+ `write-tree`/`commit-tree`，返回 OID；**不碰主根/隔离区的 index、HEAD、分支** |
| `GitMergeTree(base, ours, theirs)` | gitinfo + Wails 绑定 | 跑 `merge-tree --write-tree --merge-base=...`，解析 tree OID / 冲突段 / 消息 |
| `GitPatchID(diffText)` | gitinfo + Wails 绑定 | `git patch-id --stable`（stdin 喂 diff） |

前端（`frontend/src/ai/ai-worktree.js`）：`manageExport` 改走 L1→L2 链路；三栏报告渲染（可复用初版包 B 的模块设想，但数据源换成 merge-tree 输出）；包 D 四项落点不变。

## 5. 显式不做的事

| 不做 | 理由 |
| --- | --- |
| **自研 rebase（把隔离区改动重放到最新主根）** | `merge-tree` + `apply -3` 就是 git 自己的 rebase 内核，自研三方合并成本远超收益且更易错 |
| **继续给 internal/patch 堆模糊策略** | 3way 是正解；模糊策略只保留 AllowOffset/IgnoreWhitespace 现状作为兜底 |
| **自动执行 `npm install`** | 隔离区跑 install 要拉数百 MB，且引入新失败面。只提示命令，由人决定 |
| **改变「不可应用则删补丁文件」的 Go 行为** | L2 让主根应用不再依赖 `PatchSave` 的错误路径；该行为对 `propose_patch` 仍是合理策略 |

## 6. 实施顺序

- **S1（dry-run 先行）**：快照辅助 + `GitMergeTree` + `GitPatchID` 绑定；前端 `manageExport` 改零副作用预检 + 三栏报告。此步已能解决问题 2/3/4 与 5 的诊断。
- **S2（应用换轨）**：`GitApply3Way` 绑定 + 按文件拆分调用；审批通过后主根应用走 `apply -3`，自研引擎降为兜底。
- **S3（出路与收尾）**：L3 四项（拒绝信息给路径 → 自举提示 → discard 保底 → 导出标记）。
- 每步独立提交、可单独 revert。

## 7. 验证方式

**端到端手工验证**（真实仓库，不要 mock）：

1. 开隔离区改 3 个文件 → export → 应显示「本次可应用 3」
2. 再 export 一次 → 应显示「已应用 3，无冲突」（patch-id 命中）
3. 主根改其中一个文件的远处几行（行号漂移）→ export → merge-tree 干净合入，报告标注可应用
4. 主根改同一处（语义重叠）→ export → 报真冲突 + 附「主根相对基准的改动」，AI 依报告在隔离区重做，不再尝试直改主根
5. 有未导出改动时 discard → 应落 `.patch` 并给出路径
6. 构造 30+ 文件冲突的场景（如主根大重构后 export）→ 回执行数应有界（≤60 行 + 折叠计数），全量报告落盘可读，AI 依 `conflict_detail` 逐文件取细节
7. 主根构造 staged + unstaged 混合状态 → export 应用应成功或给出明确指引，**用户暂存区内容不得丢失**（快照用临时 index、apply -3 的 index 行为按实测结论处理）
8. 老版本 git（<2.38，可用 `GIT_VERSION` 模拟或跳过）→ L1/L2 降级走初版兜底链路，不报错

**回归**：`propose_patch` 的 dry_run / `PatchSave` 路径不受影响；blob 不可解析时兜底走 `PatchPreviewText`（初版包 A 链路，见 §8）。

## 8. 初版方案存档（2026-11-19 上午，已降级为兜底）

> 以下内容保留备查；主路径已被 §3 取代。

- **包 A（export 改走预检起点）**：`manageExport`（约 777–826 行）先 `PatchPreviewText`（`patch_app.go:97`，零副作用，设置 `RawText` + 内存 plan），可应用才 `PatchSave` 落盘。→ 现降级为 blob 不可解析时的兜底路径。
- **包 C（位移搜索消解）**：冲突时 `PatchRepreview(planId, true, false)`（`patch_app.go:118`）。**已识别的风险点**：`PatchRepreview` 不带 `StripLevel`（落默认 0），而 `PatchPreviewText` 传 `StripLevel: -1` 自动探测；若有碍，`PatchRepreview` 补一行 `opts.StripLevel = -1`。→ 现降级为自研引擎兜底路径内的容错。
- **包 B（三栏报告 + hunk 反向匹配）**：新增纯函数模块 `frontend/src/ai/ai-worktree-report.js`（可单测），反向匹配是启发式、只影响报告措辞。→ 报告模块设想保留，数据源换 merge-tree；反向匹配降为 L0 兜底。
- **包 D**：create 回执自举提示 / 漂移诊断 / discard 保底快照 / export 状态标记——已整体并入 §3 L3。
- 原方案声称「Go 零改动」的前提是不出双向补丁框架；改为 git 原生路径后需要 §4 的四个绑定，换来真合并能力。

## 9. 相关代码位置

| 位置 | 作用 |
| --- | --- |
| `frontend/src/ai/ai-worktree.js:777-826` | `manageExport`（L1→L2 链路落点） |
| `frontend/src/ai/ai-worktree.js` 的 `createForSession` / discard 分支 | L3 / 包 D 落点 |
| `internal/gitinfo/worktree.go:759` | `GitWorktreeDiff`（标准 diff，自带 index blob 行，apply -3 的前提） |
| `patch_app.go:97` / `patch_app.go:118` | `PatchPreviewText` / `PatchRepreview`（兜底路径） |
| `internal/patch/patch_save.go:54-57` | 「不可应用即删文件」现状（L2 绕开，不改） |
| `frontend/wailsjs/go/models.ts:2019` | `PatchFileOut` 字段定义（兜底路径仍用） |
| git 文档 | `git apply -3`（blob 回退三方合并）、`git merge-tree --write-tree`（≥2.38，`--merge-base`）、`git patch-id --stable` |
