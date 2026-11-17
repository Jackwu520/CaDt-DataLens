# wait_agent 架构对齐 dsh：等自己的收件箱

> 已实施（2026-11-17）。触发：五层嵌套子代理测试暴露的等待语义缺陷。

## 1. 问题

`wait_agent` 原本的语义是「阻塞等指定 / 任一子代理出终态，直接返回它的结论」。为了安全，它必须靠守卫逐个补漏洞：

| 实测缺陷 | 机制 | 实测证据 |
|---|---|---|
| 子代理自等满超时 | 候选判定 `agentUnderSessionBy` 从目标起点沿 `parentSessionId` 往上追，「起点就是祖先」时也命中，于是子代理把自己算进「可等清单」；下级全结束后只剩自己（不是终态），一路等到 `timeoutSec` | 2026-11-17 五层嵌套：层4-A2 / 层3-B2 各白等 120s，单轮 253s+ |
| 嵌套回报收不到 | `finalizeSubAgent` 用 `sessionById(parentSessionId)` 取父会话，而子代理会话**不进 `sessions` 表**，该调用对嵌套代理恒为 `null` | 层5-A2a 的结论没回到层4-A2 |
| 跨支定向等被拒 | 防祖先互锁的护栏（`不在本代理的任务支下`） | 层4-A2 定向等自己派出的层5 被误拒 |
| 记录回收后取不到结论 | 终态记录 LRU 20 条，超出降级 / 删除 | 30 个代理的满树，前 10 个不可冷唤醒 |

根因是**等待对象选错了**：等「代理实体」就必须维护实体存活、归属与记录生命周期；等「自己的收件箱」则这些问题从定义上不存在。

## 2. 参照实现：deepseek-harness

`packages/subagent/tool-subagent-control/src/wait-agent.ts`（约 130 行）只有一件事：等**调用方自己下一步的新输入**。

- 返回 `{timedOut: boolean}`，**不消费输入**（内容由轮次流程注入）。
- 事件驱动：订阅 `agent/inbox/inserted` 与 `agent/disposed`，超时用 `setTimeout`；无轮询。
- 先订阅再读待处理输入，闭合「入队落在两者之间」的竞态。
- 一个 `WeakMap<Agent, {rootCallId, ids}>` 记住「本次 tool call 已报告过的消息 id」，防止同一 tool call 内自旋。
- 默认 30 s，范围 10 s–1 h；插件卸载时 `lifetime.abort` 放行全部等待。

对照 `packages/subagent/subagent/src/`：并发按**每棵树一个 `ActivationPool`**（默认 8，根不占名额，**明确不排队**——「避免等待后代的父代理又等待自己占用的名额」）；父子链走持久化 session header（`archive-admission.ts` 的 `headerAncestors`）；深度单调（`depth.ts` 的 `Math.max(header.delegationDepth, runtime)`）。

## 3. 我们的实现

### 3.1 等待原语 `frontend/src/ai/ai-inbox-wait.js`

```js
createInboxWaiters() -> {
  wait(ownerId, {timeoutMs, hasPending, isStopped}) -> Promise<{timedOut, stopped?}>
  notify(ownerId) -> number      // 入队即唤醒，幂等
  cancel(ownerId) -> number      // 代理被停止 / 卸载
  sizeOf(ownerId) / clear()
}
```

- `wait` 顺序：先 `hasPending()` → 再注册 waiter → 心跳兜底。注册之前的入队由 `hasPending` 兜住，之后的由 `notify` 兜住。
- 心跳 250 ms **只**检查 `isStopped`（用户停止必须立刻返回），不是轮询等待条件。
- 落地即有输入时不创建任何定时器。
- `cancel` / `clear` 保证不泄漏定时器（测试用假时钟断言 `pending() === 0`）。

### 3.2 三个入队方

| 来源 | 接线点 | 唤醒谁 |
|---|---|---|
| 会话信箱 | `ai-agent-notices.js` 的 `deliverAgentNotice`（入队与 merged 两条路径） | 该 sessionId |
| 子代理收件箱 | `ai-subagents.js` 的 `queueSubAgentMessage` / `steerSubAgent` | `sub.id` |
| 用户插话 / 排队 | `ai-message-queue.js` 的 `createQueueModel({onChange})` | 该 sessionId |

`notify` 只表示「有新东西排队」，**注入仍在轮边界**（`foldNotices` / `consumeSubInbox` / `flushMessageQueue`）。把 notify 当成「立即注入」会把消息插进工具调用中间，破坏轮次模型。

### 3.3 等待执行体

`waitForInbox(input, ctx)`（`ai-subagents.js`）：
1. 收尾轮（`sub.flow.wrapUp`）**立即返回并提示直接给结论**——收尾轮不消费收件箱，等下去必然空等。
2. `hasPending`：子代理看 `unseenInboxCount(sub)`；主代理看信箱 `pendingCount` + 队列 `hasQueuedInput`。
3. `isStopped`：子代理看 `sub.state !== 'running'`；主代理看 `ctx.stream.stopped`。
4. 交给 `inboxWaiters.wait`，按结果给出可执行文案。

### 3.4 嵌套投递修复（同批修掉的真缺陷）

新增 `deliverToParent(sub, notice)`：
- 父是运行中的子代理 → `queueSubAgentMessage(parentSub, notice.content, {from: 'subagent'})`；
- 否则 → 会话信箱 `deliverAgentNotice`。

`inboxMessageText` 的来源前缀因此扩成三方：`［用户插话］` / `［主代理消息］` / `［下级代理回报］`。

结算（`finalizeSubAgent`）与提问（`runSubAskQuestion`）都改走它。

### 3.5 接口变化

| 项 | 旧 | 新 |
|---|---|---|
| 参数 | `agentId` + `timeoutSec`(默认 120) | 只有 `timeoutSec`(默认 60) |
| 返回 | 结论文本 / 状态快照 | `timedOut` 语义的可执行说明 |
| 定向等 | 支持（带归属守卫） | 不支持；被别的代理唤醒后可继续 wait |
| 删除 | — | `agentCanBeWaitedBy` / `agentUnderSessionBy` / `subSettledText` / `subRunningSnapshot` |

## 4. 验证

自动化：
- `frontend/test/ai/ai-inbox-wait.test.mjs`（9 例）：落地即有输入、notify 唤醒、超时、被停止、调用时已停止、注册前入队不丢、owner 隔离、多 waiter 与 cancel/clear、不限时可唤醒。
- `frontend/test/ai/ai-subagent-sandbox.test.mjs`：P10（嵌套投递归 `deliverToParent`）、P11（来源前缀三方可辨）、P7 改写（等自己的收件箱 / 不许轮询 / 收尾轮守卫 / 不许从工具 ctx 读队列判定 / 两处停止都要 cancel）。
- `frontend/test/ai/ai-subagents.test.mjs`：`resolveWaitTimeoutSec`（null / 空串 / false / 0 的钳制，防「永久悬挂」回归）、`pendingInboxCount`（ask 不算可注入输入）。
- `frontend/test/ai/ai-agent-notices.test.mjs`：「入队即 notify 且 ownerId 是会话 id」（key 写错在端到端里完全看不见）。
- `frontend/test/core/module-scope.test.mjs`：工厂返回面改为 `waitForInbox`。
- `node --test` 全量 + `vite build` 通过。

手工回归（需重建 exe）：
1. 五层嵌套：层4 派 2 个 background → `wait_agent` 在任一完成时立即返回 → 下一轮读到通知。
2. 主代理 background ×2 → `wait_agent` 被唤醒。
3. 用户插话能打断 `wait_agent`。
4. `wait_agent` 期间点停止 → 立即返回。
5. 收尾轮调 `wait_agent` → 立即返回（不空等）。
6. 同一轮里连调两次 `wait_agent` → 第二次直接返回「已报告过」。
7. 嵌套 `ask_user`：层3 提问 → 层2 收到「［子代理提问］」并用 `agent_send(agentId=…, askId=…, message=…)` 作答 → 层3 继续。
8. 子代理尝试给祖先 / 兄弟 `agent_send` → 报「只能给自己派出的下级发消息」。

## 5. 未做（后续可议）

审批轮已把下面几条留在这里，都**不是**这次实现的回归，而是已知边界。

- **嵌套提问的作答通道**：已修（2026-11-17 同批）。`agent_send` 现在挂在「能派单的层」上，与 `spawn_agent` / `wait_agent` 同批；方向限死为「只发给自己派出的下级」（`agentDescendsFrom` 从上级起追，天然排除自身），向上汇报走最终结论。收件箱来源前缀同期改为「用户插话 / 上级代理消息 / 下级代理回报」——原「主代理消息」在嵌套时会让第 3 层认错来源。
- **收尾轮的工具表**：已修（2026-11-17 同批）。`runSubRound` 在 `wrapUp` 时传 `[]`（Go 侧 `if len(tools) > 0` 才写字段，空数组=无工具）；模型仍幻觉出工具调用时 `runSubToolRound` 直接拒绝并立即 `finalize`，避免收尾轮无限循环。守卫 P13。
- **并发上限按树隔离**（dsh 的 `ActivationPool`）：当前仍是全窗口一个计数器，多会话会互相挤占；文案已改成「并发上限」。若要改，需按 `rootSessionId` 分组计数，并把默认值随层级上限一起调。
- **终态记录 LRU 20**：满树时前 10 个不可冷唤醒。等待语义改动后，父级链不再依赖它，风险已降级（只剩「不响应 agent_send」），但仍是能力边界。
- **深度上限到顶时工具是否可见**：dsh 选择「工具保留、运行时拒绝 + 上下文提示」，我们选择「摘掉工具省 token」。
- **`agent_tree` 自查深度的记录兜底**：已按 `subAgentRecords` 的 `depth` 兜底，但记录被 LRU 删掉后仍会回落成「第 2 层」。
