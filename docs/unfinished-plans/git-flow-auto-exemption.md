# Git 快捷操作在 auto 档的一次性窄豁免

> 2026-11-16 定稿并实施。状态：已实施，待移入 `docs/finished-plans/`。

## 背景与问题

AI 面板头部的 Git 快捷操作（提交并推送 / 提交代码 / 推送代码 / 拉取代码）把预设指令注入当前会话，AI 随后经 `run_command` 执行 `git status / diff / add / commit / push / pull`。

在 **auto（自动审批）档**下，这些命令的审批结果不一致：

- `git status` / `git diff` / `git log` 命中只读判定 → auto 档直接放行（`ai-command-rules.js` 的 `FAMILY_SPECS.git.subcommands` 只列只读子命令）。
- `git add` / `git commit` / `git push` / `git pull` **不在**只读清单、也**不在**命令族白名单 → auto 档落到分类器；分类器关着或判「ask」→ 弹审批卡（`ai-permissions.js` 的 `decidePermission` auto 分支）。

一次「提交并推送」会弹 3~5 张审批卡（add、commit、push、可能 pull/merge 各一张）。这与 auto 档「非风险自主执行」的契约不符——常规 git 写操作被逐条拦，是设计缺口而非配置问题。

## 方案：一次性 Git 流程令牌

点 Git 快捷操作时给当前会话打一个令牌（git 根 + 过期时间），`approveCommandForRun` 在危险检测、项目规则**之后**检查：令牌有效 + 命令是 git 安全子命令 + 会话处于 auto 档 → 放行（来源 `git-flow`）。

### 安全子命令集（`GIT_FLOW_SAFE_SUBCOMMANDS`）

写：`add`、`commit`、`push`、`pull`、`merge`、`fetch`、`stash`。

只读子命令（`status`/`diff`/`log` 等）本就能被 `analyzeReadOnlyCommand` 放行，无需列入豁免集。

### 护栏（必须保留）

1. **危险检测先行**：`push --force/--delete/--mirror/--force-with-lease/+ref`、`reset --hard`、`clean -f`、`checkout --`、`restore`、`stash drop/clear`、`branch -D`、`update-ref -d` 仍走单次确认（`analyzeDangerousCommand`）。
2. **项目规则优先**：`Bash(git push):deny/ask` 仍生效（`decidePermission` 的 deny/ask 分支在 auto 分支之前）。
3. **非 git 命令不受影响**：`rm`、`npm publish` 等照常走原审批。
4. **窄作用域**：
   - 只对 `run_command` / `background_command` 生效（`terminal` 工具不走豁免）。
   - 只对发起动作的那个会话生效（令牌按 sessionId 存）。
   - 只对 auto 档生效（edit 档仍逐条询问，符合「每次询问」契约）。
   - TTL 15 分钟，过期即失效；不持久化，重启即清。
   - `git -C` / `--git-dir` / `--work-tree` / `-c` 等全局旗标直接判不安全（`GIT_GLOBAL_DANGEROUS`）。
   - cwd 必须在 git 根内（子目录允许，git 会向上找仓库）。

### 子命令级额外限制

| 子命令 | 不放行的形态 |
|---|---|
| `push` | `-f` / `--force` / `--force-with-lease` / `-d` / `--delete` / `--mirror` / `+ref` |
| `stash` | `drop` / `clear` / `branch`；只放行 `create`/`pop`/`push`/`apply`/`save`/`list`/`show` 与无参 |
| `commit` | `--amend`（改写历史提交） |
| `add` | `-A` / `--all` / `-u` / `--update` / `.`（与提示词「不要 git add -A / git add .」对齐） |
| `pull` | `-r` / `--rebase`（改写本地提交形状） |
| `merge` | `--abort`（放弃进行中的合并） |

### 已知保留的审批（本次不处理）

首次提交时写 `.cadt/git-commit-style.json`（`write_file`）在 auto 档仍会弹一次卡——`.cadt` 整树是 risky 路径（`ai-panel.js` 的 `isAutoWriteRisky`），这是有意的写保护，且只发生一次（文件存在后不再写）。若想连它也免，需另立方案。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `frontend/src/ai/ai-command-rules.js` | 新增 `GIT_FLOW_SAFE_SUBCOMMANDS` + `gitFlowSafeCommand(command, gitRoot, cwd)` 纯函数；修复 `shortFlagSet` 拆 `--long=value`、`gitGlobalFlagHit` 拦短选项粘连值（审查 B1/B2/B3） |
| `frontend/src/ai/ai-permissions.js` | `decidePermission` 增加 `gitFlowSafe` 入参，auto 分支在 `readOnly` 之前检查 → `{decision:'allow', source:'git-flow'}` |
| `frontend/src/ai/ai-panel.js` | import `gitFlowSafeCommand`；`gitFlowTokens` Map + `setGitFlowToken`/`gitFlowTokenFor`；`approveCommandForRun` 计算 `gitFlowSafe`（显式排除 terminal）；`COMMAND_AUTO_LABELS` 加 `git-flow` 标签；`createAIGitUi` ctx 传 `setGitFlowToken` |
| `frontend/src/ai/ai-git-ui.js` | `runGitAction` 在 `sendAppMessage` 前调用 `setGitFlowToken(session.id, gitEntryState.root)` |
| `frontend/src/ai/ai-command-rules.test.mjs` | 新增 `gitFlowSafeCommand` 用例（安全 / 危险 / 复合 / 非 git / 全局旗标 / cwd 越界 / `--force-with-lease=` / `-C` 粘连 / `commit -a` / `add ..` / `stash push -u`） |
| `frontend/src/ai/ai-permissions.test.mjs` | 新增 `decidePermission` 的 `gitFlowSafe` 用例（allow + 来源；deny/ask 优先；非 auto 不生效；非命令通道不生效） |

无 Go 改动、无新后端绑定、无 mock-backend 改动、无 package.json 改动。

## 审查修复（2026-11-16 子代理「Git豁免审查」）

只读审查发现 2 个高危及若干中低危问题，已全部修复：

- **B1【高】** `git push --force-with-lease=<ref>` 绕过危险检测与豁免（`shortFlagSet` 不拆 `--long=value`）→ 已修 `shortFlagSet` 拆 `--xxx=...` 前缀，`--force-with-lease=<ref>` 现在 `dangerous=true`（危险检测拦截）+ `gitFlowSafe=false`（豁免不放行），双层拦截。
- **B2【中高】** `git -C/other push`、`-cfoo=bar` 粘连短选项绕过 cwd 约束（`GIT_GLOBAL_DANGEROUS` 检查用 `arg.startsWith(flag+'=')` 漏判粘连值）→ 新增 `gitGlobalFlagHit` 统一判定，短选项按前缀匹配。
- **B3【中】** `git pull --rebase=merges` 绕过 `--rebase` 护栏（同 B1 根因）→ 随 `shortFlagSet` 修复。
- **B4【中低】** `git commit -a` / `git add ..` / `git stash push -u` 流程约束放宽 → 已补拦截，与提示词口径对齐。
- **D【低】** `terminal` 工具也走 `approveCommandForRun`，靠「cwd 非路径」偶然挡住豁免 → 显式 `toolName !== 'terminal'` 排除。

修复后验证：`npm test` 784 全过、`go test ./...` 全过、`wails build -devtools` 通过；`--force-with-lease=<ref>` 等 11 条危险/边界命令实测 `dangerous=true` 或 `gitFlowSafe=false`。

## 决策链位置（`decidePermission`）

```
项目 deny → 危险命令（非 full 单次确认）→ 项目 ask → 会话/项目 allow → full
→ write/web/read 分支
→ auto 分支：gitFlowSafe → readonly → familyAuto → classifierEnabled → ask
```

`gitFlowSafe` 放在 auto 分支最前，但在危险检测与项目规则之后——危险变体与 deny/ask 规则优先，不会被豁免绕过。

## 验证

- 单元测试：`node --test src/ai/ai-command-rules.test.mjs src/ai/ai-permissions.test.mjs src/ai/ai-git.test.mjs`（44 个用例全过）；完整 `npm test` 784 全过。
- 手动核对：`gitFlowSafeCommand('git push --force origin main', root, cwd) === false`；`gitFlowSafeCommand('git add src/a.js', root, cwd) === true`；`gitFlowSafeCommand('git -C other status', root, cwd) === false`。
- 审查修复后实测：`git push --force-with-lease=origin/main`、`git pull --rebase=merges`、`git -C/other push`、`git commit -a`、`git add ..`、`git stash push -u` 全部 `gitFlowSafe=false`，其中 `--force-with-lease=<ref>` 同时 `dangerous=true`。
- 构建：`wails build -devtools` 通过。

## 风险与回滚

- **风险**：15 分钟窗口内同一会话的 git 写命令免审批。缓解：仅 auto 档、仅安全子命令、危险变体仍拦、项目 deny/ask 仍优先、TTL 15 分钟。若用户觉得窗口太长，可调 `GIT_FLOW_TOKEN_TTL_MS`。
- **回滚**：改动集中在 4 个前端文件 + 2 个测试文件，`git revert` 单 commit 可整体回退；令牌是内存态，重启即失效，无持久化残留。
