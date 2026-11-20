# 中断式交互卡片（ask_user / 审批 / envAsk）跨应用重启的恢复

> 状态：**待立项**（2026-11-21 方案成文，未开工）
> 来源：实测提问——「审批过程中程序退出重开就没了」「ask_user 询问过程中重启，AI 不知道用户选没选，用户也不知道 AI 给了哪些卡片」。
> 定位：**只解决中断式卡片的重启续跑**。计划审批（`submit_plan`）经查已经完整持久化，不在问题范围（见 §1.1）。
> 行号以 2026-11-21 工作区实测为准，实施时以代码为准。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 计划审批会丢吗 | **不会**。`activePlan` 随会话落盘，审批卡从它派生，重开即复原（§1.1） |
| ask_user / 写审批 / envAsk 会丢吗 | **会**。卡片数据随会话落盘了，但重启重放时被**强制降级成终态**（cancelled/expired），卡片点不了（§2.3） |
| 根因 | 不是「状态没存」，而是**执行流没存**——等待回答的 `Promise.resolve` 与挂起的 `stream` 都是纯内存，进程退出即消失；卡片即使画回来也没有活着的流接收答案（§3） |
| 建议 | 方案 A：恢复卡片为可交互 + 用户补答时**构造工具结果消息、起新轮**让 AI 接上。改动中等偏大 |
| 优先级 | 中。不丢数据，但「重启一次对话就断」是反复出现的体感问题，且 ask_user 场景会让用户完全失去作答机会 |

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

| 方案 | 做法 | 解决痛点 | 改动量 | 风险 |
|---|---|---|---|---|
| **A（推荐）** | 恢复卡片为可交互；补答时构造工具结果消息 + `startSessionTurn` 起新轮 | ✅ 真正解决：可补答、AI 接上 | 中等偏大 | 中：需处理幂等、多窗口、超时 |
| B | 退出前结算 pending 卡 + 插系统消息；重启汇总提示「N 张卡未处理」 | ⚠️ 只做到双方知情，不能补答 | 小 | 低 |
| C | 持久化整个执行流（stream + 调用栈）做进程级续跑 | ✅ | 极大 | 高：等同休眠恢复，不现实 |

**推荐 A**，理由：`startSessionTurn` 已是成熟纯内核（`ai-panel.js:11565`，后台队列起轮、定时任务唤醒、会话投递都走它），构造一条带说明的消息起新轮即可复用整套发送/流式/持久化链路，无需碰传输层。

## 5. 方案 A 详细设计

### 5.1 恢复层：保留 pending 而非降级

改 `ai-panel.js:1748-1786` 的重放逻辑：对 `approval/ask/envAsk` 的 `pending`，不再改状态，而是：

- 保留 `state:'pending'` 和完整卡片数据；
- 打 `message._recoveredPending = true`（区别于普通 pending，供 UI 标注「重启前遗留」）；
- 加入一个模块级 `recoveredCards` 登记表（key = `sessionId + ':' + toolCallId`），供接管区扫描。

工具消息本身（`:1779`）在卡片 pending 时不应再被标 `interrupted`——需按「等待用户」而非「执行中断」收尾，否则卡片状态和消息状态打架。

### 5.2 投递层：补答 → 工具结果消息 → 新轮

核心思路：**审批/回答本质就是用户输入**，用一条系统注记形态的 user 消息注入答案，再 `startSessionTurn(session, text, ...)` 起新轮。这比伪造 `tool_result` 协议简单，语义也成立（多数 harness 对人机交互节点都这么处理）。

各卡片映射：

| 卡片 | 补答动作 | 注入文本（示意） |
|---|---|---|
| ask_user | 用户选完点提交 | `用户对之前的问题回答如下：\n<formatAskAnswers 结果>` |
| ask_user | 跳过 | `用户跳过了之前的问题，请基于现有上下文继续。` |
| 写/命令审批 | 批准/拒绝 | `用户批准了之前的操作：<摘要>` / `用户拒绝了之前的操作` |
| envAsk | 填值提交 | 值**不写会话**（沿用 `ai-panel.js:8137` 的红线），仅在注入文本中一次性传递给执行器 |
| 补丁/worktree/动作审批 | 对应按钮 | 类似批准/拒绝摘要 |

执行器语义调整：补答路径**不再**走 `entry.resolve`（流已不存在），而是调新函数 `resumeFromRecoveredCard(session, message, payload)`：

1. 构造注入文本（复用 `formatAskAnswers`/`askAnswerSummary` 等纯函数）；
2. 把原卡片的 `state` 落成终态（`answered`/`approved`/`denied`/`cancelled`）+ `answeredAt`，`persistSessions()`；
3. 从 `recoveredCards` 移除，刷新接管区；
4. `startSessionTurn(session, injectText, {preserveScroll:true})` 起新轮——复用后台起轮通道（参照 `ai-agent-notices.js` 的 `wakeWith`），即使该会话不是当前查看的会话也能唤醒。

### 5.3 幂等、并发、超时

- **幂等**：`recoveredCards` 按 key 一次性消费；处理前复判卡片仍为 `pending`，防止重复起轮；
- **多窗口**：会话按工作区分桶，卡片属于会话。用现有回合租约（`AISessionLeaseAcquire/Release`，见 AGENTS.md `sessionstore_app.go`）防双窗口同时处理同一卡片；
- **超时**：ask 的 `deadline` 重启后通常已过期。策略二选一（实施时拍板）：① 忽略超时，允许用户补答（推荐，体验优先）；② 按 `timeoutAction` 自动结算（`abort`/`recommended`）；
- **副作用安全**：审批卡处于 `pending` 时工具**尚未执行**（在等批准），所以补批准不会造成重复副作用——这点与 `interrupted` 工具（结果未知）不同，文档注释要写清。

### 5.4 不纳入范围

- 已落终态的卡片（answered/approved/cancelled）——保持只读历史；
- 生成任务、子代理、后台命令的重启收敛——沿用现状（`failed`/`stopped`/`interrupted`），它们没有用户交互语义；
- 计划审批——已完整持久化，不动。

## 6. 实施步骤（立项后）

1. **纯函数层**：把「卡片 → 注入文本」的映射抽成 `ai-recovered-card.js` 的纯函数（可单测），复用现有 `formatAskAnswers` 等；
2. **恢复层**：改 `ai-panel.js:1748-1786`，pending 卡片保留 + `_recoveredPending` 标记 + 登记 `recoveredCards`；
3. **投递层**：新增 `resumeFromRecoveredCard`，接 `startSessionTurn`；
4. **UI**：恢复卡片渲染时加「重启前遗留」提示，点击走新投递路径；
5. **测试**：`frontend/test/ai/ai-recovered-card.test.mjs`（纯函数 + 恢复判定），登记进 `npm test`；
6. **文档**：实施后移入 `finished-plans/`，CHANGELOG 记一条用户可见变更。

## 7. 验证方式

- 单测：卡片状态映射、注入文本格式、幂等 key、超时策略；
- 手工验收（关键）：
  1. 发 ask_user → 卡片出现 → 强杀应用 → 重开 → 卡片可交互 → 作答 → AI 正确接着走；
  2. 写审批 pending → 重启 → 批准 → 文件按预期写入，无重复副作用；
  3. 双窗口打开同一会话，重启后只有一处能处理卡片；
  4. 已终态卡片、计划审批的行为不回归。

## 8. 风险与边界

- **语义偏差**：注入文本是新 user 轮而非原 tool_result，模型可能把它当新指令。缓解：文本明确标注「对之前问题的回答/之前操作的决定」+ 要求「继续原任务」；
- **上下文增长**：补答多一轮会多占 token，长会话需注意门禁（`startSessionTurn` 已有 90% 发送门禁兜底）；
- **envAsk 密钥红线**：值绝不能进会话 JSONL，只在注入文本里一次性传递；
- **多窗口竞态**：务必接回合租约，否则可能双份执行。
