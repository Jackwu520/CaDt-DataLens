# 中断式交互卡片（ask_user / 审批 / envAsk）跨应用重启的恢复

> 状态：**待立项**（2026-11-21 方案成文，未开工；同日据四家竞品调研选定对齐路线）
> 来源：实测提问——「审批过程中程序退出重开就没了」「ask_user 询问过程中重启，AI 不知道用户选没选，用户也不知道 AI 给了哪些卡片」。
> 定位：**只解决中断式卡片的重启续跑**。计划审批（`submit_plan`）经查已经完整持久化，不在问题范围（见 §1.1）。
> 对齐路线：**deepseek 中间路线**（2026-11-21 定）——按卡片语义分层：`ask_user` 重启后仍可补答（对齐 deepseek 的 `continued` 投影），审批/envAsk 降级为取消并注入「从中断处继续」新消息（对齐 opencode/codex/ZCode）。依据见 §9 调研。
> 行号以 2026-11-21 工作区实测为准，实施时以代码为准。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 计划审批会丢吗 | **不会**。`activePlan` 随会话落盘，审批卡从它派生，重开即复原（§1.1） |
| ask_user / 写审批 / envAsk 会丢吗 | **会**。卡片数据随会话落盘了，但重启重放时被**强制降级成终态**（cancelled/expired），卡片点不了（§2.3） |
| 根因 | 不是「状态没存」，而是**执行流没存**——等待回答的 `Promise.resolve` 与挂起的 `stream` 都是纯内存，进程退出即消失；卡片即使画回来也没有活着的流接收答案（§3） |
| 建议 | **方案 A′（deepseek 中间路线）**：`ask_user` 恢复为可补答卡、补答走新轮；审批/envAsk 降级为取消 + 注入「从中断处继续」新消息。改动中等（§5） |
| 优先级 | 中。不丢数据，但「重启一次对话就断」是反复出现的体感问题，且 ask_user 场景会让用户完全失去作答机会 |
| 业界对齐 | 四家竞品无一实现「卡片复活 + 原 turn 原地继续」；补答走新输入是通行做法。deepseek 的 timed 提问可补答、opencode 的重启续跑消息是本次对齐的直接参照（§9） |

## 1. 问题：两类审批，一真一假

### 1.1 计划审批（`submit_plan`）是假问题——已经持久化

完整闭环（均已查证）：

- 提交即落盘：`ai-panel.js:10267` 写 `session.activePlan`（`status:'pending'` + 完整 `markdown` + `ts`），`:10274` 紧跟 `persistSessions()`；
- 会话真源编码：`ai-session-store.js:383` 的 `planMode`、`:387` 的 `activePlan` 都进会话 JSONL；
- 审批卡派生：`ai-takeover.js:568` 的 `planApprovalMessage()` 从 `session.activePlan` 读，`:833` 在 `updateComposerTakeover` 里取用，不依赖任何内存态；
- 压缩也不丢：`ai-plan-file.js` 的 `planReferenceBlock` 在压缩后把完整计划回注；
- 落盘文件在批准时才写：`.cadt/plan/plan-<会话id>.md`（`ai-plan-file.js:planFileRelPath`），未批准只走内存预览。

**唯一内存态**是 `dismissedPlanApproval`（`ai-panel.js:865`，「继续规划」后收起卡片的标记），重启后归零 = 审批卡重新出现，正是期望行为。结论：无需改动。

### 1.2 中断式卡片是真问题

`ask_user`（多选/单选问答）、写操作审批、命令审批、环境变量创建（`envAsk`）、补丁审批、worktree 审批、动作审批——这些卡片的共同点是：**AI 发起后暂停本轮，等用户操作，拿到结果才继续**。重启后：

- 用户侧：卡片变成灰色终态（「审批已取消」「用户未回答（页面已关闭）」），无法补答；
- AI 侧：本轮流被收敛成 `stopped`，永远收不到答案，会话停在半途。

## 2. 现状机制（代码级证据）

### 2.1 卡片数据其实已经落盘

`ai-session-store.js:52-57` 的 `messageFingerprint` 注释明确处理了「消息落盘后被就地改写（工具 running→done、审批 pending→approved）」的问题，指纹覆盖：

- `approval.state/source/remember`（`:70`）
- `ask.state/source/answer`（`:71`）
- `envAsk.state`（`:72`）

即 `questions/options/approval 详情` 等卡片数据随工具消息写进 JSONL，**重开后能从磁盘读回**。所以「用户不知道 AI 给了哪些卡片」这一半，本质是卡片被降级渲染成终态、而非数据丢失。

### 2.2 等待回答的执行流是纯内存

| 卡片 | 等待载体 | 位置 |
|---|---|---|
| ask_user | `new Promise` + `pendingAsks` Map | `ai-panel.js:8487-8490` |
| 写/命令/动作审批 | `pendingApprovals` Map + `resolve` | `ai-panel.js:838`、`:7216`、`:7925` |
| envAsk | `pendingEnvCreations` Map | `ai-panel.js:8114` |
| 挂起的生成流 | `stream` / `streams` Map | `ai-panel.js`（`startSessionTurn` 内核 `:11565`） |

这些 `resolve` 函数和 `stream` 对象无法序列化，进程退出即永久消失。

### 2.3 恢复时强制降级（关键代码）

`ai-panel.js` 会话消息重放段：

| 行 | 条件 | 重启后动作 |
|---|---|---|
| `:1748` | `approval.state === 'pending'` | → `cancelled`，正文「审批已取消（会话重新加载）」 |
| `:1758` | `ask.state === 'pending'` | → `expired`，正文「用户未回答（页面已关闭）」 |
| `:1770` | `envAsk.state === 'pending'` | → `cancelled`，正文「变量创建已取消（会话重新加载）」 |
| `:1779` | 工具消息 `running/pending` | → `error` + `interrupted=true`，正文 `TOOL_INTERRUPTED_TEXT`（`ai-constants.js:14`） |
| `:1821` | 生成任务 `running` | → `failed`，「应用重启，生成任务已丢失」 |
| `:1789` | 子代理 `running` | → `stopped` |
| `:1841` | assistant `streaming` | → `stopped`（上次进程在生成中被杀） |

这是有意的 fail-safe：卡片画回来也没有 `resolve` 可接，只能收尾。旁证——命令审批的会话级放行规则也只存内存（`ai-permission-settings.js:646`），重启需重新授权；队列消息则有 localStorage 快照恢复先例（`ai-message-queue.js:34-38`）。

## 3. 根因

两层问题，缺一不可：

1. **投递层缺失**：没有「用户事后补答 → 喂回 AI」的通路。原通路是 `settleAsk`/`decideApproval` 直接 `entry.resolve(result)` 唤醒挂起的流；流没了，这条路断了。
2. **恢复层选择降级**：因为 (1) 无解，恢复逻辑只能把 pending 打成终态，避免界面出现「永远点不动的卡」。

因此只做「把卡片画回来」没用——必须回答「补答后 AI 怎么接上」。

## 4. 方案对比

| 方案 | 做法 | 解决痛点 | 改动量 | 风险 | 业界 |
|---|---|---|---|---|---|
| **A′（选定）** | 分层：`ask_user` 恢复可补答卡 + 补答起新轮；审批/envAsk 降级 + 注入续跑消息 | ✅ ask 可补答；审批双方知情 | 中等 | 低-中：只 ask 走恢复路径，幂等面小 | deepseek + opencode |
| A（原） | 所有卡片恢复可交互；补答构造工具结果消息 + `startSessionTurn` 起新轮 | ✅ 全部可补答 | 中等偏大 | 中：全类型幂等/多窗口/超时 | 四家均未做 |
| B | 退出前结算 pending 卡 + 插系统消息；重启汇总提示「N 张卡未处理」 | ⚠️ 只做到双方知情，不能补答 | 小 | 低 | codex |
| C | 持久化整个执行流（stream + 调用栈）做进程级续跑 | ✅ | 极大 | 高：等同休眠恢复，不现实 | 无 |

**选定 A′（deepseek 中间路线）**，理由：
- `startSessionTurn` 是成熟纯内核（`ai-panel.js:11565`，后台队列起轮、定时任务唤醒、会话投递都走它），补答起新轮无需碰传输层；
- 四家竞品（§9）一致地**不**恢复审批/plan-review 的待处理态，只恢复「可异步补答的提问」——A′ 与这一共识对齐，风险低于全类型复活的 A；
- 用户最痛的是 ask_user「选不了」，A′ 精准解决它，审批降级为「知情 + 续跑」也够用。

## 5. 方案 A′ 详细设计（deepseek 中间路线）

### 5.1 恢复层：按卡片语义分层

改 `ai-panel.js:1748-1786` 的重放逻辑，**不再一刀切降级**：

| 卡片 | 现状（`:1748-1776`） | 恢复后目标 | 对齐参照 |
|---|---|---|---|
| `ask_user`（`:1758`） | `pending → expired` | **`pending → continued`（仍可补答）**，打 `_recoveredPending=true`，登记 `recoveredAsks` | deepseek `userQuestions` 投影 |
| 写/命令审批（`:1748`）、envAsk（`:1770`） | `pending → cancelled` | **保持降级为 cancelled**，但正文换成续跑提示（见 5.2） | opencode / codex / ZCode |
| 计划审批 | 已持久化 | 不动 | ZCode plan-file |

`ask_user` 恢复为可补答的具体处理：
- 保留 `ask.state` 的 pending 语义（新增 `continued` 状态或复用 pending + 标记，实施时定），保留完整 `questions/options`；
- 打 `message._recoveredPending = true`（供 UI 标注「重启前遗留 · 可补答」）；
- 加入模块级 `recoveredAsks` 登记表（key = `sessionId + ':' + toolCallId`），供接管区扫描；
- **ask 的工具消息（`:1779` 的 `running/pending → error`）需豁免**——否则卡片可补答、消息却标 `interrupted`，状态打架。对齐 deepseek：ask 调用补的是「结果未知」但投影仍视作可回答。

审批/envAsk 的降级保留，但正文要改：从「审批已取消（会话重新加载）」改为明确的续跑提示（§5.2），让用户和模型都知道「重启了、从中断处继续」。

### 5.2 投递层：两条路径，都走新轮

核心思路：**重启后流已不存在，任何「回答/审批结果」都只能作为新输入重新注入**——这是四家的共同做法（§9.3）。分两条路径：

**路径 1：ask_user 补答（恢复为可交互）**

用户点恢复的 ask 卡、选完提交 → 调 `resumeFromRecoveredAsk(session, message, payload)`：

1. 复用 `formatAskAnswers`/`askAnswerSummary` 构造注入文本：`用户对之前的问题回答如下：\n<答案>`；跳过则 `用户跳过了之前的问题，请基于现有上下文继续。`；
2. 卡片 `state → answered/skipped` + `answeredAt`，`persistSessions()`；
3. 从 `recoveredAsks` 移除，刷新接管区；
4. `startSessionTurn(session, injectText, {preserveScroll:true})` 起新轮。

**路径 2：审批/envAsk 降级 + 续跑消息（不恢复可交互）**

重放时（§5.1）把 pending 审批降级为 cancelled，同时**往会话注入一条合成 user 消息**（`silent` 或可见均可，实施时定），文案吸收 opencode 的 `CONTINUE_AFTER_SERVER_RESTART` 语义：

```
应用在等待你对某个操作做决定时重启了，该决定未收到，操作未执行。
请从中断处继续，不要重复已完成的工作；如需该决定，请用更简单的方式重新询问用户。
```

- 这条消息在重放阶段就写进会话（随 `persistSessions` 落盘），**不立即起轮**（重启时自动起轮会打扰用户）——用户下次发消息时自然带上它，模型据此续跑；
- 对齐 opencode（synthetic 消息 + `execution.resume`）与 deepseek（合成 `TOOL_OUTCOME_UNKNOWN` 结果）的「告知模型重启 + 别重复」共识，但更克制：不在后台自动重跑。

> 是否对审批类也自动起一次轮（opencode 做法）留作后续选项；A′ 首版不做，避免重启即弹模型回复的打扰。

### 5.3 幂等、并发、超时

- **幂等**：`recoveredAsks` 按 key 一次性消费；处理前复判卡片仍为可补答态，防止重复起轮；续跑合成消息在重放时按 key 去重（重启重放可能多次触发）；
- **多窗口**：会话按工作区分桶，卡片属于会话。用现有回合租约（`AISessionLeaseAcquire/Release`，见 AGENTS.md `sessionstore_app.go`）防双窗口同时处理同一 ask；
- **超时**：ask 的 `deadline` 重启后通常已过期。对齐 deepseek——**忽略原超时**，恢复后给一个全新的作答窗口（原 deadline 属进程内计时，不应跨重启生效）；若用户长期不答，交给会话自己的空闲逻辑，不自动 abort；
- **副作用安全**：审批卡处于 `pending` 时工具**尚未执行**（在等批准），降级为 cancelled 不会造成副作用；ask 补答不触发任何工具副作用，只注入文本——这点比全类型复活的方案 A 更安全。

### 5.4 不纳入范围

- 已落终态的卡片（answered/approved/cancelled）——保持只读历史；
- 生成任务、子代理、后台命令的重启收敛——沿用现状（`failed`/`stopped`/`interrupted`），它们没有用户交互语义；
- **审批 / envAsk 卡片的可交互恢复**——按对齐路线只降级 + 注入续跑消息，不做复活（四家共识，见 §9）；
- 计划审批——已完整持久化，不动。

## 6. 实施步骤（立项后）

1. **纯函数层**：新建 `ai-recovered-card.js`——ask 注入文本构造（复用 `formatAskAnswers`）+ 续跑消息模板 + 恢复判定（哪些卡片可补答），可单测；
2. **恢复层**：改 `ai-panel.js:1748-1786`——`ask pending` 保留为可补答态 + `_recoveredPending` 标记 + 登记 `recoveredAsks` + 豁免 `:1779` 的 interrupted 标记；`approval/envAsk pending` 降级为 cancelled 但正文换续跑提示、注入合成消息（按 key 去重）；
3. **投递层**：新增 `resumeFromRecoveredAsk`，接 `startSessionTurn`；
4. **UI**：恢复的 ask 卡渲染加「重启前遗留 · 可补答」提示，点击走新投递路径；审批卡维持只读终态样式；
5. **测试**：`frontend/test/ai/ai-recovered-card.test.mjs`（纯函数 + 分层恢复判定），登记进 `npm test`；
6. **文档**：实施后移入 `finished-plans/`，CHANGELOG 记一条用户可见变更。

## 7. 验证方式

- 单测：分层恢复判定（ask 可补答 / 审批降级）、ask 注入文本格式、续跑消息模板、幂等 key、合成消息去重；
- 手工验收（关键）：
  1. 发 ask_user → 卡片出现 → 强杀应用 → 重开 → **卡片仍可补答** → 作答 → AI 正确接着走；
  2. 写审批 pending → 重启 → 卡片为取消终态 + 会话里有续跑提示 → 用户再发消息 → AI 从中断处继续、不重复已做的工作、不误以为操作已执行；
  3. ask 的 deadline 重启后已过期 → 恢复仍可作答（不被自动 abort）；
  4. 双窗口打开同一会话，重启后只有一处能处理 ask 卡；
  5. 已终态卡片、计划审批的行为不回归。

## 8. 风险与边界

- **语义偏差**：注入文本是新 user 轮而非原 tool_result，模型可能把它当新指令。缓解：文本明确标注「对之前问题的回答/之前操作的决定」+ 要求「继续原任务」；
- **上下文增长**：补答多一轮会多占 token，长会话需注意门禁（`startSessionTurn` 已有 90% 发送门禁兜底）；
- **envAsk 密钥红线**：值绝不能进会话 JSONL，只在注入文本里一次性传递；
- **多窗口竞态**：务必接回合租约，否则可能双份执行。

## 9. 业界调研（2026-11-21，四家竞品）

对 `codex` / `deepseek-harness` / `opencode` / `ZCode` 四份本地源码做了只读调研。结论：**没有一家实现了「进程重启后恢复可交互卡片 + 原 turn 原地继续」的完整方案**；主流是「交互请求不持久化 / 降级 + 新 turn 注入输入」。这促成了 §4 的对齐决策——放弃全类型复活的方案 A，选 deepseek 中间路线 A′：只恢复可补答的提问，审批降级 + 续跑消息。A′ 的每一半都有业界验证过的原型。

### 9.1 横向对比

| 维度 | Codex | opencode | deepseek-harness | ZCode |
|---|---|---|---|---|
| 提问工具 | `request_user_input`（阻塞）+ async 版 | `question` 插件（Deferred 阻塞） | `ask_user_question`（legacy 阻塞 / timed 限时） | `AskUserQuestion`（反向 RPC + pending interaction） |
| 请求是否落盘 | **否**，policy 显式丢弃（Transient/non-durable） | **否**，ephemeral 事件，不进 SQLite | 作为 Session 事件日志落盘，问题状态由投影折叠 | 问题正文不落盘（内存 registry 为权威），仅 deadline / receipt 落盘 |
| 重启后请求 | 消失，turn 标 `Interrupted` | 优雅关→reject/cancel；崩溃→丢内存 | timed 提问投影为 `continued`（**仍可回答**）；阻塞类只留结果未知 | reannounce 重发协议请求让 UI 重新登记（依赖 UI 存活）；中断工具补 error result |
| 补答如何回注 | `Op::UserInputAnswer` 重新 submit | synthetic 消息 + `execution.resume` 重跑 turn | `agent.steer(user-question-reply)` 新 turn | `plan_approval_feedback` / active-turn pending input 注入真实 user message |
| 计划审批跨重启 | 批准→「Implement the plan.」新输入/新 thread | plan = agent 切换，agent 选择落库，**跨重启** | plan 状态 log-only 事件持久化；评审本身不跨重启 | plan 文件落 `.zcode/plans/`，compact/resume 重新注入，**跨重启** |

### 9.2 各家关键证据

**Codex**（`codex-rs/`）：`request_user_input` 用 oneshot 阻塞当前 turn（`core/src/session/mod.rs:3699-3737`）；rollout 持久化策略把 `RequestUserInput` / `ExecApprovalRequest` / `ApplyPatchApprovalRequest` 全部 `=> None` 丢弃（`rollout/src/policy.rs:197-203`，注释 "Transient, non-durable events." `:139`）；重启重建 `rollout_reconstruction.rs` 无相关分支，turn 标 `Interrupted`（`app-server/tests/suite/v2/thread_resume.rs:4698` 等）。回答经 `Op::UserInputAnswer`（`protocol/src/protocol.rs:897-904`）重新提交；plan 批准走 `prepare_approved_plan` → "Implement the plan."（`core/src/session/approved_plan.rs:22-48`）。同进程 resume 才从内存表重放 pending（`outgoing_message.rs:565-601`）。

**opencode**（`packages/`，v2 事件溯源）：pending 全在内存（`core/src/permission.ts:157` 的 Map、`core/src/form.ts:109-116` 的 Cache），事件是 ephemeral（`schema/src/permission.ts:41-47`），SQLite 无 question/permission part 类型。优雅关闭降级为 reject/cancel（`permission.ts:161-174`、`form.ts:215-227`）。**恢复机制最有参考价值**：execution claim + synthetic 消息 `CONTINUE_AFTER_SERVER_RESTART = "The server restarted while you were working. Continue from where you left off..."` + `execution.resume` 重跑 turn（`core/src/session/execution/restart.ts:23-26,90-106`）。

**deepseek-harness**（`packages/`，**A′ 中 ask 可补答路径的直接原型**）：`ask_user_question` 的 timed 模式超时返回 `{pending:true, callId}`、agent 继续工作，迟到回答经 `agent.steer()` 作为 `user-question-reply` 用户消息注入新 turn（`packages/interaction/user-questions/src/index.ts:187-232`）。交互作为 Session 事件日志落盘（JSONL/zstd），问题状态由 `userQuestions` 投影从 `tool/call` / `tool/result` / `user/message` 折叠（`user-questions/src/projection.ts:238-306`），不单独存等待状态。resume 用 `interruptedTurnClosers` 给未结算工具补 `TOOL_OUTCOME_UNKNOWN`（`core/session/src/repair.ts:18,209`）；投影把该结果视同 pending → 标 `continued` 仍可回答（`projection.ts:260-266`）。**但** plan-review / approval 走无 timeout 的阻塞 `ask()`，不进投影、不跨重启恢复待处理态（明确写在 `user-approval/README.zh.md` 已知限制）。

**ZCode**（`apps/zcode-cli/`，本应用多处机制的原型）：`AskUserQuestion` 走反向 RPC（`interaction-broker.ts:333-360`），回答以 `decision:"modify", modifiedInput:{answers}` 回填工具输入（`:449-466`）。**中断工具补 error result**：`INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]"`（`core/src/agent/session-history-hydrator.ts:70`），pending/running 工具在历史水化时补该结果（`:327-388`）——这正是本应用 `TOOL_OUTCOME_UNKNOWN` 语义的原型（注：ZCode 全库无该字面量）。reannounce 每 1s 重发协议请求让 host 重新登记 pending（`interaction-broker.ts:492-506`）。plan-file-continuity 落 `.zcode/plans/plan-<sessionId>.md`，compact/resume 重新读取注入（`core/src/runtime/helpers/plan-file-continuity.ts:19-48,59-100`），与本应用 `.cadt/plan/` 实现同源。

### 9.3 对方案 A′ 的影响（对齐依据）

1. **方向验证**：四家都有「把回答/审批结果作为新输入重新注入 agent」的通路（Codex Op、opencode synthetic、deepseek steer、ZCode plan_approval_feedback），A′ 的投递层属业界通行做法，可放心复用 `startSessionTurn`。
2. **ask 可补答参照 deepseek**：它证明了「不伪造 tool_result、把恢复的提问当作可回答投影（continued）、补答走新 turn 注入」这条链路可行——这正是 §5.1-5.2 路径 1 的设计。直接用其 `continued` 语义替代本应用当前的「pending → expired」强制降级。
3. **审批降级文案参照 opencode / ZCode**：重启后的合成消息要明确告诉模型「从中断处继续，不要重复已完成的工作」（opencode 的 `CONTINUE_AFTER_SERVER_RESTART`），而非本应用现在的 `TOOL_INTERRUPTED_TEXT`（只说结果未知）。§5.2 路径 2 的续跑消息已吸收这一点；但 A′ 比 opencode 克制——不自动起轮，等用户下次发言带上。
4. **边界共识**：四家一致地**不**恢复 plan-review / 权限审批的待处理态（只持久化策略/状态/计划本身）。这正是 A′ 相对方案 A 的收敛点：审批/envAsk 只降级 + 续跑消息，不做复活；计划审批完全排除在范围外。
