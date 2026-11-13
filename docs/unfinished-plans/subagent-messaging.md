# 子代理消息化：从阻塞等待到消息通知模型（实施计划）

> 状态：未开工（2026-11-14 调研成文）
> 决策依据：用户 2026-11-14 要求将 spawn_agent 从阻塞模型改造为消息通知模型，给出 7 条原语；参考实现 deepseek-harness（下称 dsh）
> 范围：`frontend/src/ai/` 的子代理域与主回合注入；不改 Go 流式协议、不改后台终端与定时任务

## 1. 背景与问题

### 1.1 现状（代码事实）

- `frontend/src/ai/ai-subagents.js` `runSubAgent(ctx, input)`：建 `sub` 记录（`id: aiNowId('sub-')`、`key: aiNowId('agent-')`、`toolCallId`、depth、parentSessionId/rootSessionId），创建内存会话 `sub.session` 与 `sub.flow`（`roundId = sub.id + '#' + baseRound + '-' + roundNo`），然后：
  ```javascript
  const outcomePromise = new Promise((resolve) => { sub.resolve = resolve; });
  runSubRound(sub);
  const outcome = await outcomePromise;   // ← 阻塞点：主代理在此等待子代理结束
  return outcome.text;
  ```
- `finalizeSubAgent(sub, state, note)` 是唯一出口：更新 `toolMessage.agent` meta 与 `agentRegistry`，调 `sub.resolve({ok, text, state})`，随后 `subAgents.delete(sub.id)`（error/stopped 连转录一起删）。
- `ai-panel.js` `case 'spawn_agent'`（6386 行附近）await `runSubAgent` 后拼工具结果文本。
- 事件路由：Go `aiEmit(event, payload)`（`ai.go:443`，`runtime.EventsEmit`）→ 前端 `handleEvent(name, payload)`（`ai-panel.js:7486`）按 `payload.id` 匹配：分类器 → 标题任务 → 压缩 oneShot → **子代理（`subAgents.get(payload.id.split('#')[0])`）** → 主 streams（`roundId === payload.id`）。
- `AIStop(sessionId)`（`ai.go:303`）按「精确 id 或 `id#` 前缀」取消所有流，所以 `AIStop(sub.id)` 能停掉子代理任意轮次。
- `subAgentQueue`（`ai-subagents.js:61`）已声明并导出但**无任何使用者**（死代码），本方案将其改造为真正的收件箱。
- 子代理工具集 `subToolsForScope(depth)` 不含 `ask_user`；子代理系统提示明确「不要反问用户（你没有提问渠道）」。

### 1.2 问题

1. **阻塞**：主代理派出子代理后整个工具轮卡在 `await`，无法同时派多个探查子代理再自己干活；一轮内多个 spawn_agent 调用实际**串行**执行（`handleToolRound` 逐个 await）。
2. **悬挂隐患**：resolve 时序问题已修（`ai-subagents.js:762` 注释，2026-11-14），但「工具结果必须等到子代理终态」这一结构本身要求每条异步路径都精确挂上 resolve，脆弱。
3. **无协作通道**：子代理运行中主代理无法补充线索、无法纠正方向；子代理失败/完成只影响工具结果，没有「通知-继续」模型。

### 1.3 用户要求的 7 条原语

1. 主创建子，并发送消息
2. 主停止子，并收集对话记录
3. 主排队消息给子（子运行中排队，下轮消费）
4. 主插队消息给子（立即打断注入）
5. 子失败通知主
6. 子提问通知主（ask_user/审计类问题转交主代理，由主决定如何回答）
7. 子完成通知主

## 2. 目标与非目标

### 目标

1. `spawn_agent` 新增 `mode: 'background'`：立即返回子代理 id，主代理继续自己的回合；**阻塞语义保留为默认**（见 §4.7 取舍）。
2. 建立子代理收件箱（排队/插队双队列）与父会话通知注入通道，落地全部 7 条原语。
3. 完成通知复用「应用消息卡片」（`ai-app-message.js`）交互模式与主对话排队/插话（`ai-message-queue.js`）的语义模型。
4. HUD（智能体团队弹层/详情视图）展示并发子代理的运行态、排队消息数、等待回答等状态。
5. 每阶段可独立提交、独立验证、独立回滚；0 新依赖。

### 非目标（明确排除）

- **不动后台终端**（`background_command` / bgJobIndex / 终端标签页）与**定时任务**（`ai-schedule.js`）——它们与子代理消息化只共享「通知注入」这一实现机制，不卷入彼此改动。
- 不做子代理转录磁盘持久化；不做应用重启后的子代理恢复（与现状一致：转录在内存，summary 持久化在父会话 JSONL）。
- 不做 dsh 式名字树（`lead`/`reviewer/checker` 路径名）与跨分支消息：保持「父 ↔ 直接子」直线通信，引用用 agentId。
- 不做多窗口协同（子代理只活在创建它的窗口内存里）。
- 不做 dsh 式外部后端（codex / claude-code / ACP / 出进程）。
- 不改 Go 侧：`AISendChat` / `AIStop` / `AITouchStream` / `aiEmit` 事件名与 payload 结构不变。
- 不给子代理开放写权限或更多工具（只读边界不变）。

## 3. dsh 机制研究摘要

### 3.1 关键文件与结构

| 文件 | 关键结构/函数 | 作用 |
|---|---|---|
| `packages/subagent/subagent/src/manager.ts` | `SubagentManager`：`resident: Map<SessionId, Activation>`、`ChildLock`、`ActivationPool.reserve(capacity)` | 代理注册、容量、每子一把锁串行化投递/释放 |
| 同上 | `interrupt(targetSessionId, authority)`（188 行） | `activation.handle.agent.cancel({kind}, {keepInbox: true})`：停当前轮、收件箱保留；外部执行 abort 后 dispose |
| 同上 | `sendMessage(sender, targetId, content)`（561 行） | 代理间消息，**一律 `delivery: 'steer'`**；接受后返回 `messageId`，不返回回复 |
| 同上 | `deliver(activation, message, delivery)`（638 行） | `steer → agent.steer(msg)`；`queue → agent.followup(msg)` |
| 同上 | `sendWaking(parent, message, delivery)`（669 行） | 父若是常驻子代理则投进其 activation 并唤醒，否则 `parent.steer/followup` |
| 同上 | `notifySettlement(activation, terminal)`（1109 行） | **结算通知**：`createSettlementMessage(...)` 后，父忙碌 `steer`、空闲 `queue`、树正在关闭 `parent.inject`（只入转录不唤醒） |
| 同上 | `finishDisposal`（1033 行） | 结果捕获 → 资源释放 → `notifySettlement` → `subagent/end` 事件 → resolve result |
| `src/continuation-messages.ts` | `AgentMessageSource {kind:'agent-message', form:'relay', senderSessionId}` | 代理间消息的持久归属：「Agent X sent a message: …」，以 **user 消息**注入接收方转录 |
| 同上 | `SubagentSettledMessageSource {kind:'subagent-settled', form:'notice', summary, stopReason, senderSessionId}` | 结算通知归属：**刻意与 agent-message 不同 kind**——通知是运行时的陈述，不是子代理说的话，转录不能把结论记到子代理名下 |
| 同上 | `createSettlementMessage()`（141 行） | 一行状态（finished / was stopped / failed / ran out of room / declined）+ 子代理结束语（或「无结束语」「已发消息故省略」）+ structured + diagnostic |
| 同上 | `withResultDeliveryGuidance()`（83 行） | 派单 prompt 附加：「你的最终答案会自动投递给父代理……父代理拿不到你的完整转录/工具输出/推理」 |
| `packages/core/agent-loop/src/agent.ts` | `followup / steer / inject / cancel(cause, {keepInbox})`（170–197 行） | `followup → next-turn` 队列+唤醒；`steer → next-step` 队列+唤醒；`inject → next-step` 不唤醒 |
| `src/inbox.ts` | `ReactLoopInbox`：`next-turn` / `next-step` 双列表，`claim/splice/append/prepend/replace/remove`，`agent/inbox/spliced` 持久事件 | **双队列收件箱**：排队消息各开新轮；插队消息在下一步边界消费。驱动循环每步 `inbox.claim(target, turn)` 把消息作为 user 消息拼进上下文 |
| `src/catalog.ts` | `subagent/catalog` 会话事件 → `subagentCatalog` 投影 | 父会话拥有的子代理名册（childId/createdAt/mode/label/name），创建时落账，重启后可发现 |
| `src/names.ts` | `ROOT_AGENT_NAME='lead'`、`agent-N` 默认名、`SiblingNameReservations.reserve()` | 模型侧名字方案：兄弟唯一、路径拼接、预留防并发撞名 |
| `packages/subagent/tool-subagent/src/index.ts` | spawn 工具 `delivery: 'parent'`，返回 `{kind:'activation', name}`（326–334 行） | **派单工具本身不阻塞**：收件箱接受即返回，结果以后续通知到达 |
| `tool-subagent-control/src/index.ts` + `wait-agent.ts` | `send_message` / `interrupt_agent` / `list_agents` / `wait_agent` | 控制工具面：投递返回「message delivered to agent X」；interrupt 返回接受回执（fire-and-return）；list 返回 running/inactive 快照；wait 订阅自己收件箱的 `agent/inbox/inserted`，新输入或超时返回 `{timedOut}` |

### 3.2 消息流转图

```
                         父代理（lead）
                    ┌──────┬──────────┐
        spawn(delivery:'parent')│          │send_message(steer)
              │收件箱接受即返回  │          │interrupt(keepInbox)
              ▼                │          ▼
        子代理 A ◄─────────────┘    子代理 A
        │ 独立 Agent 循环：            │
        │  next-step(插队): 每步边界 claim，作为 user 消息进上下文
        │  next-turn(排队): 当前轮结束后各开新轮
        ▼
     终态(SubagentResult: output/structured/diagnostic/stopReason)
        │ finishDisposal：释放资源
        ├─► notifySettlement ──► createSettlementMessage（kind:'subagent-settled'，user 消息）
        │        父忙碌 → steer（下一工具步边界出现）
        │        父空闲 → queue（唤醒新轮）
        │        树关闭 → inject（只入转录，不唤醒）
        └─► 'subagent/end' 事件（scoped 到树根，UI/观察者消费）

     子代理 ask_user/消息 → createAgentMessage（kind:'agent-message'）→ 同上投递父代理
```

### 3.3 七原语在 dsh 中的对应

| 原语 | dsh 机制 | 要点 |
|---|---|---|
| 1 创建子并发消息 | spawn 工具 `delivery:'parent'` + `startLocal`（收件箱接受即返回 childId+messageId） | 非阻塞；派单 prompt 附加自动投递说明 |
| 2 停止并收集 | `interrupt({keepInbox:true})` + `finishDisposal` 捕获 output；`list_agents`/catalog 查状态 | 停当前轮不弃排队消息；外部执行停即终 |
| 3 排队 | `agent.followup` → `next-turn`（或 browser `prompt(delivery:'queue')`） | 空闲目标唤醒新轮；运行中目标排到轮后 |
| 4 插队 | `agent.steer` → `next-step`（send_message 对运行中目标一律 steer） | 下一步边界注入，不打断在飞模型调用 |
| 5 失败通知 | `createSettlementMessage(stopReason:'error'/'aborted'/…)` | 与成功同一条通道，一行文案区分 |
| 6 提问通知 | 子代理 `send_message`（kind:'agent-message'）发给父；父用 send_message 回 | 无专用 ask 通道——消息即通道，方向对等 |
| 7 完成通知 | `notifySettlement`（见 3.2） | 忙 steer / 空闲 queue / 关闭 inject 三态投递 |

### 3.4 对 CaDt 的可迁移结论

1. **通知即 user 消息**：dsh 一切代理间通信（消息、完成、失败）最终都是接收方转录里的一条 user 消息，用 `source.kind` 区分归属。CaDt 已有完全对应的表现层——「应用消息卡片」（`submitText(text, null, {app})` + `ai-app-message.js`）。
2. **双队列收件箱**：排队/插队是两个列表而不是一个优先级队列；插队消费点是「步边界」。CaDt 子代理循环的「步边界」= 工具轮结束 → `runSubRound` 之前。
3. **派单工具不阻塞**：结果自动投递 + 明示「父拿不到完整转录」。
4. **interrupt 保收件箱**：停止当前轮 ≠ 清空队列。
5. **等待工具是补充而非主干**：dsh 的 `wait_agent` 只返回「有无新输入」不搬运内容，内容仍走注入。CaDt 若做 `wait_agent`，语义应是「阻塞直到任一/指定子代理终态，把该子代理结论作为工具结果返回」——比 dsh 更直接，因为 CaDt 的结论本来就是给主代理用的。

## 4. 设计

### 4.1 总览：三个通道

```
┌─ 主代理回合 ──────────────────────────────────────────────┐
│  spawn_agent(mode) ─┬─ blocking: await（现状，默认）        │
│                     └─ background: 注册即返回 agentId      │
│  agent_send(agentId, message, urgent) ─► 子收件箱           │
│  agent_stop(agentId) ─► 停止 + 返回转录摘要                 │
│  wait_agent(agentId|any, timeoutSec) ─► 阻塞收单条结论      │
└──────────────────────────────────────────────────────────┘
        ▲ 注入（复用「应用消息卡片」）          │ 事件 ai-chunk/…（payload.id=subId#…）
        │                                      ▼
┌─ 父会话 notice 通道 ─┐            ┌─ 子代理收件箱 ────────────────┐
│ sessionAgentNotices  │            │ sub.pendingStep（插队，前置）    │
│ 忙→下轮边界注入       │            │ sub.pendingTurn（排队，后置）    │
│ 闲→startSessionTurn  │◄─结算通知──│ sub.pendingAsk（提问，挂起等答） │
└──────────────────────┘            └───────────────────────────────┘
```

### 4.2 唯一 id 方案

| id | 生成 | 生命周期 | 兼容性 |
|---|---|---|---|
| **agentId** | 沿用 `sub.id = aiNowId('sub-')` | 从「finalize 即删」升级为**终态保留**：移入 `subAgentRecords`（Map，agentId → 终态记录含 `sub.session` 引用、meta、收件箱残余）；`subAgents` 仍只含运行中 | 事件路由 `payload.id.split('#')[0]` 不变；`handleEvent` 子路由扩展为先查 `subAgents` 再查 `subAgentRecords`（仅运行中的会命中事件，records 只是兜底） |
| **messageId** | `aiNowId('msg-')` | 入收件箱时生成，消费时随消息落转录 | 新增，无历史包袱 |
| **roundId** | `subId + '#' + baseRound + '-' + roundNo` 不变 | 后台子代理被唤醒续轮时 `baseRound += 1`（复用主会话 `session.round` 语义），Go `AIStop(subId)` 前缀匹配、`AITouchStream(subId)` 前缀匹配均已兼容 | 与现有 `session#round-stream` 格式同构，路由零改动 |
| **askId** | 子代理 ask_user 的 `toolCallId` | 子代理提问挂起期间有效 | 无 |
| toolCallId / key | 现状不变（父工具调用 id / HUD 注册键） | 不变 | HUD 与持久化 meta 结构不变 |

不引入 dsh 的 UUID/branded id 与名字树：`sub-`、`session-`、`msg-` 前缀互不碰撞（`aiNowId` 时间戳+随机已保证），模型侧一律用 agentId 全文引用。

### 4.3 子代理收件箱（对齐 dsh 双队列）

`ai-subagents.js` 内：

```javascript
// sub 记录上新增：
sub.inbox = {
    step: [],    // 插队：下一轮边界最前注入（urgent 或正常 steer）
    turn: [],    // 排队：下一轮边界最后注入
    ask: null,   // {askId, questions, resolve, timer} 提问挂起
};
```

**消费点**（唯一）：`runSubRound(sub)` 开头、`buildApiMessages` 之前——

1. `sub.inbox` 两个列表非空 → 按序 push 成 `role:'user'` 消息（`content` 带 `「主代理消息：」` 前缀，`notice:true` 标记），step 列表在前、turn 列表在后；清空列表。
2. 嵌套子代理派单期间收到消息：同样在下一轮边界消费（子代理的工具轮结束回到 runSubRound 时）。

**投递**：

- `queueSubAgentMessage(sub, message)`：push `inbox.turn`；若子代理空闲（终态保留可续）→ 冷唤醒（见下）；若在模型流中且 `urgent` → 先 `AIStop(sub.id)`。
- `steerSubAgent(sub, message)`：unshift `inbox.step`；若正在流式 → `AIStop(sub.id)`（对齐主对话插话「停止当前回复并立即发送」）。`handleSubEvent` 的 `ai-done`（finishReason `stopped`）分支增加判断：`s.stopped` 且 `sub.steerKick === true` 时**不 finalize**，置 `sub.steerKick = false`、`s.stopped = false`，直接走 `runSubRound(sub)`（收件箱消息在开头被消费）。
- **冷唤醒**：agentId 命中 `subAgentRecords` 且记录 `continuable !== false` → 用保存的 `sub.session`、profile、entry 重建 live `sub` 对象（`baseRound = 记录.rounds + 1`），重新注册进 `subAgents` 与 HUD，消息入 `inbox.turn`，`runSubRound` 启动。error/stopped 的记录默认不可续（`continuable:false`），`agent_send` 对其返回失败文案。
- `stopSubAgentsOf`（用户停止主回合）与主代理 `agent_stop` 都改走统一 `stopSubAgent(sub, reason)`：置 stopped、`AIStop`、**保留 inbox 内容并写进结算通知文案**（「停止时仍有 N 条未消费消息」），finalize('stopped')。

### 4.4 通知如何进入主代理的回合

**取舍：注入消息卡片为主，工具结果（wait_agent）为辅。**

- **注入消息（主路径，覆盖原语 5/6/7）**：复用现有「应用消息」机制——`userMessage.app = normalizeAppMessage({kind, label, icon})`，`ai-app-message.js` 的 `APP_MESSAGE_ICONS` 增加 `subagent: 'agents'`、`'subagent-ask': 'ask' 对应图标` 两类；卡片渲染、sanitize、重放全部免费获得。这与 dsh「通知是 user 消息 + source.kind 区分归属」的结论一致（§3.4.1）。
- **工具结果（辅路径，`wait_agent`）**：阻塞等待指定/任一后台子代理终态，把该子代理的结论文本直接作为工具结果返回——用于「并行派出 N 个探查后汇总」的最短路径。通知注入仍会发生（先到先得：若 wait 先拿到结论，结算通知改为只更新 HUD、注入文案标注「结论已经 wait_agent 返回，本条仅状态」或直接跳过正文注入）。

**注入的三个时机**（对应 dsh `notifySettlement` 三态）：

1. **父会话流式生成中** → 挂 `sessionAgentNotices`（Map：sessionId → notice[]）。消费点：`handleToolRound` 工具循环结束、`startRound(s)` 调用之前——把 notice 逐条 `session.messages.push(user 消息)`（带 app 元数据）。若本轮不再有工具轮（finishReason=stop 已定），落到时机 3。
2. **父会话压缩中**（compactOf）→ 挂同一队列，`finishCompact` 后重试（对齐 `ai-schedule.js` 的等待重试模式，但不强切会话）。
3. **父会话空闲** → **自动唤醒新轮**。现状 `sendAppMessage` 深绑 `currentSession()`（输入区、附件、切会话副作用），不能直接用于后台注入。新增内核：

```javascript
// 从 submitText 抽出的纯会话级启动路径（不碰输入区/附件/switchSession）：
async function startSessionTurn(session, text, extra) {
    // submitText 的 6927–7057 行主体：profile/entry 解析、窗口预算预估、
    // user/assistant 消息构造、attachStream、persistSessions、startRound；
    // 区别：session 由调用方给定，跳过 currentSession 读取与输入区清空/渲染。
}
// submitText 保留 UI 部分，内部转调 startSessionTurn；
// sendAppMessage 走 submitText 不变；注入路径走 startSessionTurn。
```

- 注入不切换用户正在查看的会话、不强开面板；后台会话注入后按现有 `setSessionUnread` 机制给「已完成未查看」式标记，面板关着时配合 `notifyDesktop`（失败/提问才 toast，完成静默，见 §4.6）。
- `finishStream` 的 `shouldFlush` 处追加一步 `flushAgentNotices(session.id)`：把残余 notice 连同排队消息一起交给时机 3 的唤醒逻辑。

**通知文案**（对齐 dsh `createSettlementMessage` 的一行式结构）：

```
［子代理通知 · 名称］后台子代理「依赖调查」已完成。
结论：……（截 AI_SUB_SUMMARY_MAX）
如需补充调查可 agent_send 继续；不需要请忽略本条。
```

失败：`……已失败（原因）。可 agent_stop 清理或重新派单。`
提问：`……向你提问：Q1……（请 agent_send(askId=…) 回答；也可先自行 ask_user 向用户确认）`

### 4.5 七条原语的实现路径

| # | 原语 | 实现 | 改动文件 |
|---|---|---|---|
| 1 | 主创建子并发消息 | `spawn_agent` 增 `mode:'blocking'\|'background'`（默认 blocking）；background 分支：限额检查（沿用 `subAgentLimit`/depth，**等待空位的 while 循环只在 blocking 模式**，background 直接报错）→ 建 sub → `runSubRound` → 立即返回 `已派出后台子代理「N」（id=sub-xxx，depth D，轮次上限 R）。完成后会自动通知你；期间可继续其他工作或 agent_send 补充消息。` | `ai-tool-defs.js`、`ai-subagents.js`（runSubAgent 拆分）、`ai-panel.js`（spawn_agent case） |
| 2 | 主停止子并收集 | 新工具 `agent_stop(agentId)`：`stopSubAgent` → 返回转录摘要（最终 assistant 正文 + 最近工具行数统计；转录在 `subAgentTranscripts`，done 保留的现状不变，stopped/error 也保留至本运行期以支撑「收集记录」） | `ai-tool-defs.js`、`ai-subagents.js` |
| 3 | 排队消息 | `agent_send(agentId, message)`（urgent 缺省 false）→ `queueSubAgentMessage` | 同上 |
| 4 | 插队消息 | `agent_send(…, urgent:true)` → `steerSubAgent`（AIStop + 前置注入） | 同上 |
| 5 | 失败通知 | `finalizeSubAgent(state='error')` → `deliverAgentNotice(parentSession, error 通知)`；`flash` 保留（运行期可见性），但仅当父会话正处于流式才 flash，避免双通道噪音 | `ai-subagents.js`、`ai-panel.js` |
| 6 | 子提问通知主 | 子工具集在 background/可续模式下追加 `AI_TOOL_DEFS.ask_user`；子侧 `runSubAskQuestion`：不建 `pendingAsks` UI，而是 `sub.inbox.ask = {askId, questions, resolve}` + 向父注入「子代理提问」notice（含 askId 与问题列表）；父模型用 `agent_send(agentId, answer, {askId})` 作答 → `resolve(格式化答案文本)`，子 ask_user 工具结果落定、续轮。父可自行升级为父级 ask_user。超时兜底：默认 120s 无回答按 `ai_decide` 语义放行（`「主代理未及时回答，请基于现有上下文自行决定并继续」`），不悬挂 | `ai-tool-defs.js`、`ai-subagents.js`、`ai-panel.js`（agent_send case 处理 askId） |
| 7 | 完成通知 | `finalizeSubAgent(state='done')` → `deliverAgentNotice(parentSession, 完成通知)`；替代现状「只 resolve 工具结果」——blocking 模式仍走工具结果（注入跳过，避免双份），background 模式走注入 | `ai-subagents.js` |

新工具定义（`AI_TOOL_DEFS`）：

```javascript
agent_send:  { name: 'agent_send',  description: '向后台子代理发消息：默认排队（它下一轮可见）；urgent=true 插队（打断当前模型调用、下一步最前注入）。对已完成的子代理发消息会唤醒它继续工作；带 askId 时是对子代理提问的回答。', parameters: { agentId, message, urgent?, askId? }, required: ['agentId','message'] }
agent_stop:  { name: 'agent_stop',  description: '停止一个后台子代理并收集其过程记录（当前进度 + 最终输出）。已完成/失败的子代理返回历史摘要。', parameters: { agentId }, required: ['agentId'] }
wait_agent:  { name: 'wait_agent',  description: '阻塞等待后台子代理结束并直接返回其结论（agentId 省略时等任一运行中的子代理）。timeoutSec 0–600，默认 120；超时返回当前状态快照。', parameters: { agentId?, timeoutSec? } }
```

`toolsForScope`（`ai-tool-defs.js:484-506`）在含 `spawn_agent` 的档位同步加入三件套；子代理的工具集不含它们（子不控子，保持只读边界；递归派单仍走 spawn_agent）。

### 4.6 UI：HUD 与卡片

- **chips 弹层（`renderChipsPop('agents')`）**：`listAgentsForHud` 增加来自 `subAgentRecords` 的终态条目（合并去重逻辑已有）；行状态徽标沿用 `AGENT_STATE_LABEL`，新增 `waiting`（有排队/插队消息或等待回答）→ 显示「待处理 N」；行右侧保持 chevron 进详情。
- **详情视图（`renderAgentView`）**：运行中视图在消息流尾部追加收件箱预览区（「排队 N 条 · 插队 M 条」，列首行摘要）；`sub.inbox.ask` 非空时显示「等待主代理回答」提示条。background 模式下详情视图新增「停止」按钮（调 `stopSubAgent`）——后台子代理结束时机独立于主回合，用户需要手动干预入口。
- **父会话工具卡**：`toolMessage.agent.state === 'running'` 且 background 模式时，卡片文案「后台运行中 · 完成后通知」；`refreshToolWrap` 不需要新结构。
- **通知卡片**：注入消息走既有 app 卡片（kind `subagent`）；`detectAppMessage`（`ai-app-message.js:32`）增加固定前缀 `［子代理通知 · `、`［子代理提问 · ` 的识别，旧版本会话重放时也能正确归类。
- **噪音控制**：完成通知不 toast（会话未读标记 + 卡片足够）；失败与提问 toast（复用 `notifyTurnFinished` 的 error 分支样式，`sessionId` 指向父会话）。

### 4.7 兼容性：阻塞语义的过渡（取舍）

**保留 blocking 为默认，background 为显式可选。理由：**

1. 阻塞模型对单任务委派认知负担最低：一个工具调用一个结果，上下文干净；后台模式引入「通知乱序进入上下文」，模型需要学会「忽略/消化」通知，这对简单委派是纯开销。
2. 现有会话与技能（`.cadt/`、`docs/skills`）里若有 spawn_agent 用法，默认行为不变即零迁移。
3. dsh 同构结论：其 spawn 工具虽是非阻塞，但「一次性委派拿结果」的常见路径由 caller-delivery（`delivery:'caller'`，程序消费者 await）承担——CaDt 的 blocking 模式正是 caller-delivery 的等价物，两者并存是其验证过的形态。
4. 过渡期系统提示（`ai-panel.js:6550` 工具守则）追加一句：「值得并行的多项调查：spawn_agent(mode='background') 同时派出多个，期间可继续自己的工作，子代理完成会逐个通知你；wait_agent 可汇总等待。单一简单委派仍用默认阻塞模式。」

`mode` 参数缺省即 blocking，OpenAI/Anthropic 的工具 schema 增加枚举即可，无协议风险。

### 4.8 系统提示与子代理提示

- 子代理系统提示（`AI_SUB_SYSTEM_PROMPT`）在可提问模式下追加：「你可以在关键决策点用 ask_user 向主代理提问（由主代理决定答案或转询用户）；等待回答期间你的轮次暂停，超时后请自行决定并继续。」

## 5. 阶段划分

> 原则：每批独立提交、独立验证、可独立回滚；批内文件互不跨域。

### 阶段 A：注入内核（纯重构，无行为变化）

- 从 `submitText` 抽出 `startSessionTurn(session, text, extra)`（`ai-panel.js`），`submitText` 转调；`sendAppMessage`、排队冲刷路径回归验证。
- `ai-app-message.js`：`APP_MESSAGE_ICONS` 注册 `subagent`；`detectAppMessage` 增加前缀识别。
- `ai-subagents.js`：删除死代码 `subAgentQueue`（或改为本方案的 inbox 结构占位）。
- 验证：`npm test`（既有 111 用例）+ 手工回归「定时任务注入 / 排队插话 / 后台会话完成通知」。

### 阶段 B：后台派单 + 完成/失败通知（原语 1、7、5）

- `ai-subagents.js`：`runSubAgent` 拆 `startSubAgent`（建记录、入 `subAgents`、启动首轮）与阻塞等待；新增 `subAgentRecords`、`deliverAgentNotice`、`finalizeSubAgent` 改造（终态入 records、done/error 发通知、blocking 模式不发避免双份）。
- `ai-panel.js`：`handleEvent` 子路由兜底查 records；`spawn_agent` case 支持 mode；`handleToolRound` 工具循环后消费 `sessionAgentNotices`；`finishStream` 后唤醒（`startSessionTurn`）。
- `ai-tool-defs.js`：spawn_agent 增 `mode`。
- 验证：单测（通知文案组装、notices 消费 fold——放 `ai-subagents.test.mjs`，纯函数拆出 `buildSettlementNotice`）；手工：后台派单 → 主代理继续干活 → 完成通知卡片出现并自动续轮；失败场景同。

### 阶段 C：agent_send / agent_stop + 子收件箱（原语 2、3、4）

- `ai-subagents.js`：`sub.inbox` 双队列、`queueSubAgentMessage` / `steerSubAgent` / 冷唤醒 / `stopSubAgent` 统一；`runSubRound` 消费点；`handleSubEvent` steerKick 分支。
- `ai-tool-defs.js` + `ai-panel.js`：`agent_send` / `agent_stop` 工具与执行 case；`toolsForScope` 挂钩。
- HUD：waiting 状态、收件箱预览、详情视图停止按钮。
- 验证：单测（inbox 消费顺序、steerKick 状态机、冷唤醒记录校验）；手工：运行中排队/插队、对已完成子代理发消息唤醒、停止并收集记录、用户主回合停止连带子代理停止。

### 阶段 D：子提问转交（原语 6）

- `ai-subagents.js`：`runSubAskQuestion` 桥、`sub.inbox.ask`、超时兜底；子工具集按模式追加 ask_user。
- `ai-panel.js`：`agent_send` 处理 askId 回答；提问 notice 卡片。
- 验证：单测（ask 生命周期：挂起→回答→落定；超时分支）；手工：子提问 → 父回答 → 子继续；父升级 ask_user 问用户 → 回填子；超时自行决策。

### 阶段 E：wait_agent + 收尾

- `ai-tool-defs.js` + `ai-subagents.js`：`wait_agent`（内部复用结算 promise：blocking 模式的 `outcomePromise` 机制泛化为每子一个 `settledPromise`，finalize 时 resolve；wait 按 agentId 或任意竞速）。
- `ai-panel.js`：spawn/守则系统提示更新；HUD 收尾。
- `CHANGELOG.md`、`README.md` 对应小节。
- 验证：并行 3 子代理 + wait_agent 汇总；全量 `go test ./...`（确认零 Go 改动）+ `npm test` + `vite build` + `wails build`。

## 6. 验证清单（整体验收）

1. 单一后台子代理：派出 → 主代理同回合继续 read_file → 子完成通知卡片 → 主代理引用结论收尾。
2. 并行三子代理：一轮内三个 background spawn（不再串行等待）→ wait_agent 或逐个通知汇总。
3. 排队：子运行中 agent_send（urgent=false）→ 子下一轮消费，消息以「主代理消息」出现在其上下文（详情视图可见）。
4. 插队：子长流式中 agent_send(urgent=true) → 当前调用中止、消息最前注入、子不终止继续工作。
5. 失败：断网/错误 key 使子失败 → 父会话收到失败通知卡 + toast，主代理不悬挂。
6. 停止：agent_stop 返回转录摘要；主回合用户停止连带后台子代理停止并留「停止时未消费消息」文案。
7. 提问：子 ask_user → 父收到提问通知 → agent_send(askId) 回答 → 子落定续轮；120s 超时走 ai_decide 放行。
8. 冷唤醒：对已完成（done）子代理 agent_send → baseRound+1 续轮，事件路由正确（`subId#2-1`）。
9. 会话重放/重启：通知卡片、spawn meta、HUD 兜底扫描全部照旧渲染；records 丢失不报错（详情视图落「重启后仅保留状态与结论摘要」分支）。
10. 回归：blocking 默认行为与现状逐字节一致（同任务对比工具结果文本格式）；定时任务注入、排队插话、压缩期间注入不受影响。

## 7. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 注入消息撑大父上下文 | 通知正文截断（复用 `AI_SUB_SUMMARY_MAX`）；同一边界多条通知合并注入一次；守则提示「后台子代理仅用于值得并行的调查」 | 通知文案生成集中在 `buildSettlementNotice` 一个函数，可加开关 |
| 模型把通知当作用户新指令跑偏 | 通知统一 app 卡片 + 固定前缀 + 「不需要请忽略」尾注；`notice:true` 消息在 `buildApiMessages` 中可识别（后续可做折叠） | 工具描述收紧 mode 使用条件 |
| 悬挂复发（等待 ask 回答 / wait_agent） | 一切等待 promise 配超时：ask 120s 兜底 ai_decide；wait_agent timeoutSec 硬上限 600；`settledPromise` 沿用「先挂 resolve 再启动」的既有修复模式 | 各等待路径独立，可单独退化为报错返回 |
| steerKick 与用户停止语义打架（该停没停） | `stopGeneration → stopSubAgentsOf` 置 `stopped` 时清空 steerKick；只有 agent_send(urgent) 设置 steerKick | handleSubEvent 分支单点，一行可摘 |
| 冷唤醒持有过期 session 引用（父会话已删除/归档） | 唤醒前校验 `sessionById(parentSessionId)` 与 archivedAt；失败则回「该会话已不可用」 | 不可续即拒绝，无副作用 |
| 事件串味（records 兜底查到不该接的 id） | records 只存终态、不接事件；路由保持 subAgents 优先、命中即 return（现状） | 兜底查询只在 B 阶段需要，可整体摘除 |
| 阶段 A 重构伤及 submitText 主路径 | 抽取为逐字搬移 + 差异最小（session 参数化）；回归清单第 10 条 | 单提交单回滚 |

## 8. 明确不做（再次强调）

- 后台终端（`background_command` 作业、终端内容区标签页）不在本次改动面内；子代理 HUD 与终端 chips 的现有关系（同弹层不同 tab）维持不变。
- 定时任务（`ai-schedule.js`）不改；它只是阶段 A 注入内核的既有消费者之一，回归覆盖即可。
- 不把子代理会话搬进 SQLite、不做会话索引、不改 `sessionstore*`。

## 9. 任务清单

- [ ] A1 抽 `startSessionTurn` 内核 + 回归
- [ ] A2 app-message 子代理 kind/前缀
- [ ] A3 清理 subAgentQueue 死代码
- [ ] B1 subAgentRecords + 终态保留 + 通知文案函数（含单测）
- [ ] B2 background 模式 spawn + 完成/失败通知注入（含消费点与唤醒）
- [ ] B3 HUD 终态合并与卡片文案
- [ ] C1 子收件箱双队列 + 消费点（含单测）
- [ ] C2 agent_send / agent_stop 工具与执行
- [ ] C3 steerKick / 冷唤醒 / 统一停止（含单测）
- [ ] C4 HUD waiting 状态与详情视图扩展
- [ ] D1 子 ask_user 桥 + 提问通知 + 超时兜底（含单测）
- [ ] D2 agent_send askId 回答链路
- [ ] E1 wait_agent
- [ ] E2 系统提示 / CHANGELOG / README / 方案状态更新
