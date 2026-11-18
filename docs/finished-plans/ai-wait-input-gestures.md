# wait_agent 等待期间的用户消息手势语义

> 状态：**已实施（2026-11-19），存档**
> 关联：`frontend/src/ai/ai-inbox-wait.js`（等待原语）、`frontend/src/ai/ai-message-queue.js`（消息队列与手势）、`frontend/src/ai/ai-subagents.js`（waitForInbox 执行体）、`frontend/src/ai/ai-panel.js`（接线与停止）、`docs/finished-plans/ai-turn-steering.md`（三手势基础语义）

## 1. 背景与问题

`wait_agent` 挂起期间（回合停在工具轮，stream 仍注册在 `streams`、工具卡显示「等待新输入」），用户发消息的三种手势全部沿用「流式中」的语义，产生三个症状（用户原话：等待直接停止、消息发不出去、主代理懵逼）：

1. **排队（Enter）唤醒等待却给不出内容**：入队 → 队列 `onChange` → `inboxWaiters.notify` → wait 立刻结算、工具卡秒关（「等待直接停止」）；但注入仍只在轮边界，wait 的返回值拿不到排队消息的内容，模型只拿到一句不分来源的「收件箱有新输入…直接结束本轮即可读到」。模型若不理会继续干活，queue 车道的消息要等整轮自然结束才 flush——用户盯着「已排队」chip 不动（「发不出去」），模型继续干原任务（「懵逼」）。
2. **插话（Ctrl+Enter）的唤醒文案误导**：steer 本应在紧接的轮边界注入、继续干活即可读到，唤醒文案却一律说「直接结束本轮即可读到」。
3. **抢占（Ctrl+Shift+Enter）丢失停止语义**：`preemptComposerMessage` 先 `enqueueFront`（onChange → notify 把 waiter 一次性结算成「有新输入」）后 `stopGeneration`（`inboxWaiters.cancel` 空转——`settle` 一次性语义被 notify 抢跑）；wait 卡被 `stopRunningToolMessages` 强杀为通用「用户已停止生成」，工具结果被 `handleToolRound` 的 stopped 分支丢弃，模型下回合只看到一张中断卡。
4. **兜底脆弱**：`flushMessageQueue` 在 submitText 失败（lease_failed / over_budget 等）回队后无任何自动重试；排队发生在停止收尾窗口（stopGeneration 后 1.2s）内时 `shouldFlush` 只认 `interjectPending`，普通排队的消息要滞留到下次切换会话。

## 2. 设计裁定（作者定稿）

**排队就正常等这一轮结束再发送，不用非得抢。** 排队保持「不打断」契约的纯粹性：

| 手势 | 机制 | 行为 |
|---|---|---|
| **排队 Enter** | queue 车道，**不 notify、不算待消费输入** | 等待完全不被打扰，工具卡继续挂着；超时检查点提示「有排队消息，可结束本轮接收」；本轮自然结束后 flush 作为正式用户消息送达（不抢） |
| **插话 Ctrl+Enter** | steer 车道 + wake(source='steer') | wait 立即返回「用户插话：下一条请求的轮边界就会注入，继续干活即可读到，无需结束本轮」→ startRound drain 送达 |
| **抢占 Ctrl+Shift+Enter** | 入队 + stopGeneration → cancel 以 stopped 如实结算 | wait 卡「等待被停止：用户中断了本轮」；1.2s 收尾后 flush 开新回合 |
| **通知 / 子代理** | wake(source='notice'/'agent') | 「已随下一轮上下文注入，继续工作即可读到」 |

排队消息永远以正式用户消息开新回合，不注入轮中；想立即让等待中的代理读到，用插话。原方案里的「抢占先 stop 后入队」重排**不需要**：排队车道不 notify，「notify 抢跑 cancel」从根上消失。

## 3. 实现

1. **`ai-inbox-wait.js`**：`notify(ownerId, source)` → settle `{timedOut:false, source}`；source 缺省时保持旧结果形状（不带键，既有 deepEqual 断言不受影响）。`wait` / `cancel` / `clear` 不动。
2. **`ai-message-queue.js`**：
   - `onChange` 只有 steer 车道唤醒且带来源 `notify(item.sessionId, 'steer')`。
   - `flushMessageQueue(sessionId, opts)` 失败自动重试一次：回队后 2.5s `setTimeout` 带 `{fromRetry:true}` 再冲刷；重试自身失败不再安排（持续失败交给下一个自然触发点），既有守卫（忙 / 草稿 / 接管卡）天然防重入。
   - `enqueueComposerMessage` 在「有会话但无活流」（停止收尾窗口；压缩中无流也会命中，无害——flush 被 `compactOf` 挡住，登记只是给下次 finishStream 多一次冲刷机会）补 `interjectPending.add`，让 `shouldFlush` 收下这条消息。
3. **`ai-subagents.js`**：
   - 导出纯函数 `waitWakeText(source)`（steer → 插话文案；notice/agent/未知 → 通用通知文案）与 `waitTimeoutText(timeoutSec, hasQueued)`（有排队消息时在超时检查点追加提示，措辞是「建议可结束本轮」，不指挥）。
   - `waitForInbox`：`countPending` = 信箱数 + **steer 车道**（排队不计——落地即有输入与 250ms 心跳都不会被排队消息唤醒）；超时分支按 `lanesOf(viewer.id).queue` 追加提示；唤醒结果按 `result.source`（无 source 时按当前 steer 车道推断）分文案。
   - ctx 注入由 `hasQueuedInput`（任意条目布尔）改为 `queueLanesOf(sessionId) → {queue, steer}`。
4. **`ai-panel.js`**：`queueLanesOf` 接线（steer = delivery==='steer' 的条目；queue = 其余）；`stopRunningToolMessages` 对 `wait_agent` 特判中断文案「等待被停止：用户中断了本轮」。
5. **`ai-agent-notices.js`**：`notifyWaiters` 带 `'notice'`；`ai-subagents.js` 的 `notifyInbox` 带 `'agent'`。
6. **`ai-tool-defs.js`**：`wait_agent.description` 同步新返回语义（按来源区分 + 排队不打扰等待的说明）。

## 4. 行为核对（改后）

- **Enter 排队（等待中）**：卡不关、wait 继续挂；默认 60s 超时后模型读到「有排队消息，可结束本轮接收」，自行收轮 → finishStream → flush → 消息作为新回合送达。延迟上界 ≈ 一个 timeout，且完全由模型自主决定（排队 = 不打扰）。
- **Ctrl+Enter（等待中）**：wait 立即返回、卡收口为「有插话」；紧接的 startRound（roundNo>1）drain 注入，模型在同一轮读到。若模型就此结束整轮，ai-done 的 steer 续轮分支或 fallbackSteerToQueue 兜底送达，不丢。
- **Ctrl+Shift+Enter（等待中）**：cancel 以 `{stopped:true}` 结算等待 → 「等待被停止」→ handleToolRound 判 stopped 丢弃（整轮本就被抢占）→ 卡显示特判文案 → 1.2s 兜底 finishStream → hasInterject → flush → 新回合。
- **回归**：普通流式中三手势行为不变；停止收尾窗口内排队随收尾冲刷；flush 失败 2.5s 自愈一次。

## 5. 测试

- `ai-inbox-wait.test.mjs`：notify 带 source 透传 + 缺省保持旧形状。
- `ai-subagents.test.mjs`：`waitWakeText` 按来源分文案（steer 不指挥收轮；通用文案不冒充插话）、`waitTimeoutText` 提示是建议不是指令。
- `ai-message-queue.test.mjs`：行为级——排队入队不 notify、steer 入队 notify 带来源。
- `ai-turn-steer-wiring.test.mjs`：源码级——onChange 只认 steer 车道、enqueue 路径无 notify、停止窗口登记 interjectPending、flush 重试带 fromRetry 标记。
- `ai-subagent-sandbox.test.mjs`：`queueLanesOf` 必须从模块 ctx 解包 + countPending 只认 steer + 超时提示要读 queue 车道。

## 6. 已知边界

- 排队语义下，若模型在等待中超时后**选择继续等待**（连续 wait_agent），排队消息会一直等到模型自行收轮——用户可用插话或抢占立即送达，这是排队契约的固有代价，不做强制。
- steer 挂着时模型重入 wait_agent 会命中 `reportedPending` 防自旋守卫（「已报告过，直接结束本轮」）——结束整轮会把它降级成排队送达，两条车道都不丢消息。
- flush 重试只覆盖「冲刷已触发但起轮失败」的瞬态场景；「冲刷从未触发」（如后台会话无人切回）仍属 `ai-queue-background-flush.md` 评估稿的范围。
- 重试存在一个极窄的理论竞态窗口（`model.remove` 之后、`submitText` 注册流之前恰好触发重试且队列还有第二条）：并发起轮由回合租约裁决，败者干净失败回队、`fromRetry` 阻止重试风暴——不丢消息、不重复发送，存量语义本就如此，重试只是新增触发点。
