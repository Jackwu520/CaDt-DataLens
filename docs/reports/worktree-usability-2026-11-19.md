# 隔离工作区（worktree）可用性实测复盘

> 2026-11-19。基于同一会话内连续三轮隔离开发（插件命令矩阵 / 插件 AI 工具 / 插件上下文注入）的实际遭遇整理。**本文只记录现象与期望，不含修改方案的实施**；第五节是可直接当验收清单用的条目。
>
> 来源会话ID：session-mwm2sdc1n4cs5

## 一、背景

三轮隔离开发的共同条件：主根持续有其他并发改动（未提交），因此三次都用了 `worktree_manage(action=create, carry=true)`。

| 轮次 | 隔离区 | 自述产出 | 回灌结果 |
| --- | --- | --- | --- |
| M1 命令入口矩阵 | `plugin-cmd-matrix-*` | 8 个文件 | `applied=1`（部分），最终靠主根 `propose_patch` 补 CHANGELOG |
| M3 插件 AI 工具 | `plugin-tools-*` | 13 个文件 | 首次 `applied=9 skipped=4`；二次 export 报「没有任何文件可直接应用」；最终 discard + 主根逐处补 4 个文件 |
| M5 上下文注入 | `plugin-viewer-context-*` | 6 个文件 | `applied=5 skipped=0`，但 `ai-panel.js` 实际未进；再 export 冲突；discard 后主根 `edit_file` 补两处 |

三轮都以 `discard` 收尾，且都需要在主根手工补文件。**隔离区没有一轮做到「导出即完成」**。

## 二、export 的语义与报错互相矛盾

### 问题 1：`applied/skipped` 与「没有任何文件可直接应用」自相矛盾

**现象**（M3）：第一次 export 返回 `mode=partial applied=9 skipped=4`，语义清晰。补齐后再次 export，返回：

```
【patch:error】PATCH_HUNK_CONFLICT：补丁已保存但没有任何文件可直接应用
```

字面意思是全部失败。实际上**此前 9 个文件已经落地**，只有冲突出现在剩余文件上。

**影响**：使用者会误判「我的工作全丢了」，进而采取破坏性补救动作——本次实测中因此把主根文件 `cp` 进隔离区重做 diff，导致别人的改动混入补丁。

**期望**：报告分三栏——本次应用 N 个 / 此前已应用（跳过）M 个 / 真冲突 K 个（附文件名），并明说「已应用部分无需重做」。

### 问题 2：重复 export 会把已回灌的 hunk 变成「冲突」

**现象**：export 是全量语义（相对创建基准）。第二次 export 的 diff 仍包含已应用片段，预检因此报「不可应用」。这不是冲突，是**已完成**。

**影响**：每轮都要靠人工判断「这个冲突是真冲突还是已应用」。M1 那轮我为定位这一点，反复 export 了三次。

**期望**：预检时识别「该 hunk 在主根已存在」，归入「已应用」而不是「冲突」。

### 问题 3：一次只报一个文件的第一个失败 hunk

**现象**（M1）：报错只给 `CHANGELOG.md` 第 7 行的期望/实际。`docs/plugins/README.md`、`main.js`、`ai-panel.js` 的冲突要后续 export 才逐个暴露。

**期望**：一次列出所有文件的全部可判定失败点。

### 问题 4：缺少 dry-run

**现象**：`propose_patch` 有 `dry_run`，worktree `export` 没有。export 是「落补丁 + 尝试应用」一步到位。

**影响**：无法在执行前知道「哪几个文件会冲突」，只能先导了再收拾。

**期望**：`export` 支持预检模式，逐文件返回能否应用。

## 三、基准漂移一旦发生就没有出路

### 问题 5：`carry=true` 的基准会随主根变动永久失效

**现象**：`carry=true` 把主根「当时的未提交状态」冻结进基准 commit。之后任何其他会话修改同一文件，该文件在 export 时必然 hunk 冲突。三轮全部撞上，涉及 `ai-panel.js`、`main.js`、`CHANGELOG.md`、`docs/plugins/README.md`、`package.json`。

**影响**：隔离区**没有 rebase / 三方合并能力**。唯一出路是 `discard` + 主根手工重做，隔离本身的意义损失大半（M5 那轮即如此）。

**期望**：至少提供诊断——「基准已漂移，冲突文件 X/Y 在主根被改动过」，让使用者能判断是否值得手工重做；理想是提供把隔离区改动重放到最新主根的 rebase。

### 问题 6：`carry=true` 的语义没有提示

**现象**：创建时只说「已从主根带入 N 个未提交改动」，没说明「这些改动被冻结进基准，主根后续变动会导致 export 冲突」。

**期望**：创建回执里点明这个后果，使人能预判。

## 四、环境自举：顺序有隐性依赖且无提示

### 问题 7：新隔离区不自举依赖，且顺序依赖隐蔽

**现象**：隔离区没有 `frontend/node_modules`、`wailsjs/`、`frontend/dist`。必须**按此顺序**自举：

```
cd frontend && npm install
npx vite build          # 产出 frontend/dist
wails generate module   # 依赖 dist，否则失败
```

两个隐性依赖：
- `wails generate module` 无 `dist` 时报 `main.go:20:12: pattern all:frontend/dist: no matching files found`，错误信息不指向「你需要先 vite build」。
- 缺 `wailsjs` 时测试**假失败**在 `工具定义 / wailsjs / mock 三处接线齐全` 与 `test-manifest 找不到文件`——看起来像代码错误，实际是环境未自举。

**影响**：三轮各花一次摸索。对不熟悉本项目的人，这三个失败点会误导排查方向。

**期望**：创建隔离区时提示自举命令；或测试/构建失败时能识别「缺生成物」并给出对应命令。

## 五、通道语义不一致与收尾安全

### 问题 8：隔离期间主根只读，但 `propose_patch` 可写

**现象**：直接改主根被拒（`WORKTREE_MAIN_READONLY`，设计正确——回灌须过审批卡）。但此时的困境是：主根改不了、隔离区基准已旧改不动，唯一出路 discard，而 discard 会丢未导出改动。

**期望**：在 `WORKTREE_MAIN_READONLY` 的拒绝信息里直接给出可行路径（「先 discard 隔离区」或「用 propose_patch 提交」），而不是只报错。

### 问题 9：`discard` 没有保底快照

**现象**：discard 前若有未导出改动即永久丢失。三轮都是靠人工确认「该导的都导了」才敢执行。

**期望**：discard 前若检测到相对基准的未导出改动，自动落一份 `.patch` 到 `.cadt/patches/` 并在回执里给出路径。

### 问题 10：export 后隔离区状态不变，易误判

**现象**：export 成功后，隔离区 `git status` 仍显示全部改动（相对基准仍在）。使用者无法从状态上区分「已回灌」与「未回灌」。

**期望**：回执或隔离区状态里标记「已导出至 <patch 路径>」。

## 六、本轮有效的规避手法（供使用者参考）

1. **导出失败不要 `cp` 主根文件进隔离区重做 diff**——会把他人改动混入补丁（本轮实测导致构建报 `friendlyRetryReason is not exported`，而那是另一会话的半成品）。正确做法是 discard 后回主根用 `propose_patch` / `edit_file` 逐处补。
2. **单行超长文件（如 `frontend/package.json` 的 test 脚本，约 12 KB 一行）不要走补丁**——hunk 行数极易算错，且 diff 无法阅读。discard 后主根直接 `edit_file` 更稳。
3. **export 后务必回到主根 `search_text` 抽查关键符号**（如 `pluginContextText`），确认目标文件真的进了——`applied` 计数不等于你想要的文件都进了（M5 那轮 `applied=5` 里就没有 `ai-panel.js`）。
4. **每轮结束前在主根跑全量测试 + 构建**，隔离区的绿色不代表主根绿色。

## 七、改进优先级（验收清单）

按「本轮实际浪费的时间」排序，逐条可勾选：

- [ ] export 报告分三栏：本次应用 / 此前已应用（跳过） / 真冲突（含文件名）
- [ ] 预检识别「hunk 在主根已存在」并归为已应用，不报冲突
- [ ] export 支持 dry-run，逐文件返回能否应用
- [ ] 冲突一次性列全（所有文件的所有失败点）
- [ ] 基准漂移诊断：明确指出哪些文件在主根被改动过
- [ ] `carry=true` 的创建回执点明「基准已冻结，主根后续变动会导致冲突」
- [ ] 创建隔离区时提示（或自动执行）自举：`npm install` → `vite build` → `wails generate module`
- [ ] 缺 `wailsjs` / `dist` 时的失败信息指向对应自举命令
- [ ] `WORKTREE_MAIN_READONLY` 拒绝信息给出可行路径
- [ ] `discard` 前对未导出改动自动落 `.patch` 并回报路径
- [ ] export 成功后标记「已导出」，区别于未导出改动

## 八、附：修复这些问题的代码位置

- 隔离区编排：`worktree_manage` 工具实现（`.cadt/worktree/` 相关逻辑与 export 的补丁预检）
- 补丁预检与错误码：`internal/patch/`（`PATCH_HUNK_CONFLICT` / `PATCH_PARSE` 的产出点）
- 补丁应用报告：`internal/patch` 的 `applied/skipped` 汇总
- 若实现 dry-run：可复用 `propose_patch` 的 `dry_run` 路径
