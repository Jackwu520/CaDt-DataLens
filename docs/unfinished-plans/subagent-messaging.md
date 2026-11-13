# 子代理消息化：从阻塞等待到消息通知模型（实施计划）

> 状态：未开工（2026-11-14 调研成文；同日增补「侧边对话」§4.9/阶段 F、「子代理压缩」§4.10/阶段 G、「ai-panel.js 拆分边界」§4.11、「共享信箱与会话间投递」§4.12/阶段 H）
> 决策依据：用户 2026-11-14 要求将 spawn_agent 从阻塞模型改造为消息通知模型，给出 7 条原语；参考实现 deepseek-harness（下称 dsh）。同日确认「侧边对话」取「两者都要」形态（用户支线对话 + 子代理对话视图，统一旁路会话基建）
> 范围：`frontend/src/ai/` 的子代理域、主回合注入与侧边对话（§4.9）；不改 Go 流式协议、不改后台终端与定时任务

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
- 子代理无压缩机制（`ai-subagents.js:46` 模块注释自述）；`sub.session.summary` 字段存在但恒 null；消息数超 `AI_SUB_MESSAGES_MAX`（400，`ai-subagents.js:50`）时置 `wrapUp` 强制跑一轮无工具总结轮收尾（785-797），收尾请求失败回退转录摘录（946-951）。

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
6. **侧边对话**（2026-11-14 增补，§4.9）：用户支线对话（普通会话 + `sideOf` 元数据）与子代理对话视图（agentView 输入行）统一在旁路会话基建（`startSessionTurn` / `sessionAgentNotices` / 子收件箱 / 交互语言）上。
7. **子代理压缩**（2026-11-14 增补，§4.10）：auto-compact（轮边界估算超阈触发，复用 `config.autoCompact`/阈值，零新设置）+ 手动压缩（主代理 `agent_compact` 工具 + agentView 按钮）；摘要经 `buildApiMessages` 对 `sub.session.summary` 的既有判断零改动注入。
8. **共享信箱与会话间投递**（2026-11-14 增补，§4.12）：会话间「挂号信」式投递（`session_send` 单播/组播统一工具 + 用户投递动作）；信箱 = `sessionAgentNotices` 的正式化（一条注入管道、N 个发送方）；模型侧无广播（组播 ≤10 个显式目标），「通知运行中的会话」仅限用户动作；范围限同窗口内存会话。

### 非目标（明确排除）

- **不动后台终端**（`background_command` / bgJobIndex / 终端标签页）与**定时任务**（`ai-schedule.js`）——它们与子代理消息化只共享「通知注入」这一实现机制，不卷入彼此改动。
- 不做子代理转录磁盘持久化；不做应用重启后的子代理恢复（与现状一致：转录在内存，summary 持久化在父会话 JSONL）。（用户支线对话是普通持久化会话，不受此条约束——见 §4.9.1）
- 不整体拆分 ai-panel.js 留守核心（submitText/startRound/executeTool/streams 等）；本方案只搬走自己域内的存量并承接新增能力，边界与净账见 §4.11。
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
│  agent_compact(agentId) ─► 轮边界/立即压缩（§4.10）         │
│  wait_agent(agentId|any, timeoutSec) ─► 阻塞收单条结论      │
│  session_send（单播/组播）/ session_list ─► 信箱（§4.12）   │
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
| **agentId** | 沿用 `sub.id = aiNowId('sub-')` | 从「finalize 即删」升级为**终态保留**：移入 `subAgentRecords`（Map，agentId → 终态记录含 `sub.session` 引用、meta、收件箱残余、profile/entry 引用——压缩与冷唤醒都需要）；`subAgents` 仍只含运行中。records 设 LRU 上限（建议 20）：超出降级为仅状态+结论摘要、`continuable:false`，详情视图复用「重启后仅保留摘要」分支 | 事件路由 `payload.id.split('#')[0]` 不变；`handleEvent` 子路由扩展为先查 `subAgents` 再查 `subAgentRecords`（仅运行中的会命中事件，records 只是兜底） |
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

1. `sub.inbox` 两个列表非空 → 按序 push 成 `role:'user'` 消息（`content` 带 `「主代理消息：」` 前缀，`notice:true` 标记），step 列表在前、turn 列表在后；清空列表。（F3 起按来源区分前缀：主代理消息 / 用户插话，见 §4.9.4）**`wrapUp` 收尾轮不消费收件箱**，残余随终态进 records 并在结算文案标注（与 stopped 的「未消费消息」同款）。
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
- **唤醒防护**（2026-11-14 增补）：`startSessionTurn` **不读模块级 `pendingEdit`**，注入路径恒传 `truncateAt=null`——若目标正是当前查看会话且用户处于重发/编辑态（`pendingEdit` 非空），本次唤醒改挂 notices 队列延后，避免破坏编辑流。唤醒调用**单飞**（waking 集合）：并发通知只有第一个执行唤醒，后来者发现已有流即转排队，杜绝双重唤醒。
- `finishStream` 的 `shouldFlush` 处追加一步 `flushAgentNotices(session.id)`：把残余 notice 连同排队消息一起交给时机 3 的唤醒逻辑。

**通知文案**（对齐 dsh `createSettlementMessage` 的一行式结构）：

```
［子代理通知 · 名称］后台子代理「依赖调查」已完成。
结论：……（全文，不截断）
如需补充调查可 agent_send 继续；不需要请忽略本条。
```

失败：`……已失败（原因）。可 agent_stop 清理或重新派单。`
提问：`……向你提问：Q1……（请 agent_send(askId=…) 回答；也可先自行 ask_user 向用户确认）`

- **截断口径（2026-11-14 决策：对齐 dsh，取消 8000 截断）**：现状 `finalizeSubAgent`（`ai-subagents.js:996`）在 resolve 前把结论截到 `AI_SUB_SUMMARY_MAX`（8000 字符）——工具结果（模型实际收到的）与卡片显示（`toolMessage.agent.summary`）同源同截断。调研/扫描类子代理的长报告被拦腰截断且无路可取回（done 即删、无续问通道），等于白跑。**B 阶段起移除该截断**：`finalizeSubAgent` / 结算通知 / `wait_agent` / `agent_stop` 的最终正文一律**全量投递**（对齐 dsh `createSettlementMessage` 携带完整结束语、投递层不截断；dsh 唯一硬截断在诊断通道 4096 字节，CaDt 无此通道，子代理转录 `subAgentTranscripts` 的展示层 600/2000 字截断保留不动——展示与上下文分离）。长度控制全部前移：①§4.8 投递契约（结论自带证据、紧凑完整）；②子代理单响应受模型/Provider 的 max output tokens 硬上限约束（≈ dsh 的 `maxTokens` 预算位，耗尽可见不静默）；③轮次预算 wrapUp 收尾。**残留风险**：失控长结论冲大父上下文——由父会话既有机制兜底（下轮预算预检拒绝 / 自动压缩），不新增投递层机制；`AI_SUB_SUMMARY_MAX` 常量与「已截断」尾注一并移除。

### 4.5 七条原语的实现路径

| # | 原语 | 实现 | 改动文件 |
|---|---|---|---|
| 1 | 主创建子并发消息 | `spawn_agent` 增 `mode:'blocking'\|'background'`（默认 blocking）；background 分支：限额检查（沿用 `subAgentLimit`/depth，**等待空位的 while 循环只在 blocking 模式**，background 直接报错）→ 建 sub → `runSubRound` → 立即返回 `已派出后台子代理「N」（id=sub-xxx，depth D，轮次上限 R）。完成后会自动通知你；期间可继续其他工作或 agent_send 补充消息。` | `ai-tool-defs.js`、`ai-subagents.js`（runSubAgent 拆分）、`ai-panel.js`（spawn_agent case） |
| 2 | 主停止子并收集 | 新工具 `agent_stop(agentId)`：`stopSubAgent` → 返回转录摘要（最终 assistant 正文 + 最近工具行数统计；转录在 `subAgentTranscripts`，done 保留的现状不变，stopped/error 也保留至本运行期以支撑「收集记录」） | `ai-tool-defs.js`、`ai-subagents.js` |
| 3 | 排队消息 | `agent_send(agentId, message)`（urgent 缺省 false）→ `queueSubAgentMessage` | 同上 |
| 4 | 插队消息 | `agent_send(…, urgent:true)` → `steerSubAgent`（AIStop + 前置注入） | 同上 |
| 5 | 失败通知 | `finalizeSubAgent(state='error')` → `deliverAgentNotice(parentSession, error 通知)`；`flash` 保留（运行期可见性），但仅当父会话正处于流式才 flash，避免双通道噪音 | `ai-subagents.js`、`ai-panel.js` |
| 6 | 子提问通知主 | 子工具集**仅在 background 模式**追加 `AI_TOOL_DEFS.ask_user`（blocking 子代理的父回合被 await 占住，提问必然 120s 超时——工具档挂载点必须按模式硬性区分，这是实现陷阱）；子侧 `runSubAskQuestion`：不建 `pendingAsks` UI，而是 `sub.inbox.ask = {askId, questions, resolve}` + 向父注入「子代理提问」notice（含 askId 与问题列表）；父模型用 `agent_send(agentId, answer, {askId})` 作答 → `resolve(格式化答案文本)`，子 ask_user 工具结果落定、续轮。父可自行升级为父级 ask_user。超时兜底：默认 120s 无回答按 `ai_decide` 语义放行（`「主代理未及时回答，请基于现有上下文自行决定并继续」`），不悬挂；**迟到的回答**（超时后 agent_send(askId) 到达）降级为普通排队消息、前缀标注「（迟到的回答）」，不报错 | `ai-tool-defs.js`、`ai-subagents.js`、`ai-panel.js`（agent_send case 处理 askId） |
| 7 | 完成通知 | `finalizeSubAgent(state='done')` → `deliverAgentNotice(parentSession, 完成通知)`；替代现状「只 resolve 工具结果」——blocking 模式仍走工具结果（注入跳过，避免双份），background 模式走注入 | `ai-subagents.js` |

新工具定义（`AI_TOOL_DEFS`）：

```javascript
agent_send:  { name: 'agent_send',  description: '向后台子代理发消息：默认排队（它下一轮可见）；urgent=true 插队（打断当前模型调用、下一步最前注入）。对已完成的子代理发消息会唤醒它继续工作；带 askId 时是对子代理提问的回答。', parameters: { agentId, message, urgent?, askId? }, required: ['agentId','message'] }
agent_stop:  { name: 'agent_stop',  description: '停止一个后台子代理并收集其过程记录（当前进度 + 最终输出）。已完成/失败的子代理返回历史摘要。', parameters: { agentId }, required: ['agentId'] }
wait_agent:  { name: 'wait_agent',  description: '阻塞等待后台子代理结束并直接返回其结论（agentId 省略时等任一运行中的子代理）。timeoutSec 0–600，默认 120；超时返回当前状态快照。', parameters: { agentId?, timeoutSec? } }
agent_compact: { name: 'agent_compact', description: '压缩后台子代理的上下文：运行中的子代理在下一轮边界执行；已完成的子代理立即压缩（之后 agent_send 唤醒将以精简上下文继续）。返回压缩前后规模与摘要预览。', parameters: { agentId }, required: ['agentId'] }
session_list:  { name: 'session_list',  description: '列出本窗口内可投递的 AI 会话（id/标题/状态/工作区，最近活动倒序，上限 50），用于 session_send 选址。', parameters: {} }
session_send:  { name: 'session_send',  description: '向一个或多个（1–10 个显式 id，无广播/通配）AI 会话的共享信箱投递消息（挂号信）：对方忙则排到其下一轮边界、空闲则唤醒新轮；逐目标返回回执（messageId/原因 + 唤醒数），不保证对方回复。targetSessionIds 用 session_list 查询。能单播不组播；不要与另一会话无意义地互相投递；收到「信箱已满」回执后停止投递。', parameters: { targetSessionIds, message, urgent? }, required: ['targetSessionIds','message'] }
```

`toolsForScope`（`ai-tool-defs.js:484-506`）在含 `spawn_agent` 的档位同步加入三件套（C2 落地）；`agent_compact` 于 G3 加入成四件套；`session_send`/`session_list` 于 H1 加入、档位与 spawn_agent 相同（跨会话唤醒是编排类重能力）；子代理的工具集不含它们（子不控子、子不控会话，保持只读边界；递归派单仍走 spawn_agent）。

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

- **结果投递契约**（2026-11-14 增补，对齐 dsh `withResultDeliveryGuidance`，continuation-messages.ts:83）：子代理系统提示（`AI_SUB_SYSTEM_PROMPT`，所有模式）追加：「主代理只会收到你的最终结论文本，看不到你的完整转录、工具输出或推理过程——最终结论必须自带结果与关键证据（path:line），不要指望父代理从过程记录里找信息。」投递层不截断（§4.4 决策），本契约为结论长度的**主控手段**（源头控制）：长报告完整到达父上下文，紧凑性靠子代理自律。
- 子代理系统提示（`AI_SUB_SYSTEM_PROMPT`）在可提问模式下追加：「你可以在关键决策点用 ask_user 向主代理提问（由主代理决定答案或转询用户）；等待回答期间你的轮次暂停，超时后请自行决定并继续。」

### 4.9 侧边对话：用户向旁路会话（2026-11-14 增补）

> 形态确认为「两者都要」：用户支线对话 + 子代理对话视图。结论：**统一在运行时基建与交互语言上，不统一在存储形态上**——支线对话是普通持久化会话（`sideOf` 元数据），子代理侧边视图是 agentView 覆盖层增强（转录仍内存态）。以下行号为 2026-11-14 调查快照。

#### 4.9.1 底座选型：支线对话 = 真 AI 会话，不是子代理

| 代码事实 | 推论 |
|---|---|
| 多会话并发流是显式设计：`streams` 按会话隔离（`ai-panel.js:1502-1504` 注释「每个会话一条独立的流……互不打断」）、事件按 roundId 遍历路由（7531-7540）、后台会话照常入列、切回全量重建（2196-2219） | 母会话流式时支线正常收发，**流基建零改动** |
| 持久化一会话一目录 meta+JSONL（`sessionstore.go:14-19`）；加字段仅 4 处：`normalizeSession`（`ai-panel.js:1129-1167`）、`buildSessionMeta`（`ai-session-store.js:223-253`，metaSignature 自动覆盖新字段）、列表渲染、创建者 | `sideOf` 成本极低，用户数据跨重启保留 |
| `sub.session` 不入 `sessions`、不持久化（`ai-subagents.js:751`）；`subAgentTranscripts` 200 条上限、tool 截 600 字 / assistant 截 2000 字（101-109、837、901-906）；重启只留摘要 | 拿子代理当支线底座须把持久化硬塞进子代理域（违反 §2 非目标），且截断会真实丢失用户对话 |
| HUD `agentView` 是面板内覆盖层、无 composer（`style.css:8985-8992`、`ai-subagents.js:515-552`） | 子代理侧的「会话式体验」是**增强项**（加输入行），不是现成能力 |

且子代理机器（depth/限额/收件箱/冷唤醒）对支线是纯包袱：支线的发送方就是用户，收件箱=输入框。

#### 4.9.2 「统一旁路会话基建」的实在含义

统一的是四条管道 + 一套交互语言，每条都有 ≥2 个消费者：

| 管道 | 既有消费者 | 侧边对话侧消费者 |
|---|---|---|
| `startSessionTurn`（§4.4，A 阶段） | 定时任务注入（现走 switchSession + 忙等重试，`ai-schedule.js:328-335`）、后台通知唤醒（B） | 带回主对话的空闲唤醒（F2） |
| `sessionAgentNotices` 注入通道 + app 卡片（B） | 子代理完成/失败/提问通知（B/D） | 「支线结论」卡片（F2） |
| 子收件箱 step/turn + steer/queue（C） | 主代理 `agent_send`、`stopSubAgentsOf`（C） | agentView 用户插话（F3） |
| 交互语言：Enter 排队 / Ctrl+Enter 插队 / 未读标记 / 停止保留收件箱 | 主 composer（`ai-composer.js:460-467`）与 message-queue | agentView 输入行沿用同一语义（F3） |

#### 4.9.3 形态一：用户支线对话

- **创建**：头部「⋯」菜单与 assistant 消息操作条（复用 branch 入口位置，`ai-panel.js:2983-2986`、8866）各加「新建支线对话 / 侧边追问」→ `createSessionData` + `sideOf = 母会话.id`（scope 默认 read，同现状）→ persist → 切过去。**不复制母会话历史**——与 `branchSessionAt`（8735-8783，全量分叉）明确区分：分支=独立重演历史，支线=轻关联旁路。
- **引用**：从消息行发起时往新会话 composer 草稿预填 markdown 引用块（`> 引用自「母标题」：`+ 截断文本）；写入 drafts 表（8873-8897）后切换，`loadComposerDraft` 即恢复；附件/图片照常。
- **工具与权限：零新代码**——支线就是普通会话，scope 默认 `'read'`，用户按现有权限四档自行升级；即「子代理只读哲学」的会话版。
- **带回主对话**：支线 assistant 消息操作条加「带回主对话」→ `deliverAgentNotice(母会话, {kind:'sidechat', label:'支线结论 · ' + title, content: 结论全文})`（与 §4.4 不截断决策同口径）。B 阶段的 `deliverAgentNotice` 签名从一开始就定为 `(session, {kind,label,content})` 通用形，子代理结算与支线带回共用一条管道；母会话空闲 → `startSessionTurn` 唤醒新轮，忙 → notices 下轮边界注入；母会话已删除 → flash 兜底。注入不切走用户当前查看的会话（§4.4 原则），母会话以未读标记提示。
- **列表呈现**：组内紧跟母会话 + 「支线」徽标 + 缩进 class（`renderItem` ai-session-list.js:368-446、组内排序 `buildWorkspaceGroups` 448-471）；「提升为独立会话」= 清 `sideOf`；母会话删除后徽标回落为普通会话。
- sideOf 不嵌套；支线内可再 spawn 子代理（普通会话能力，depth 从 0 起算）。

#### 4.9.4 形态二：子代理对话视图（agentView 增强）

- **输入行**：agentView footer 加一行输入（活跃子代理，或 done 且可续的记录）：Enter → `queueSubAgentMessage(sub, text, {from:'user'})`（排队，下轮消费）；Ctrl+Enter → `steerSubAgent`（插队）；对 done 记录输入即冷唤醒入口（复用 C 阶段，baseRound+1）；error/stopped 记录禁用并显示原因。消息带 `from:'user'`，§4.3 消费前缀据此区分「主代理消息：」/「用户插话：」。
- **与 C4 分工**：停止按钮、收件箱预览、waiting 状态在 C4 落；F3 只加输入行与来源区分。
- **渲染不重构**：agentView 维持简化渲染（`agentBlock`/`agentToolRow`）；主渲染器虽字段兼容（`renderToolMessage` 按字段分支），整面替换收益低，明确不做。
- 转录**仍不持久化**：agentView 是子代理的侧边视图，不是会话列表新条目（§2 非目标不变；重启后落「仅保留状态与结论摘要」分支）。

#### 4.9.5 与七原语的关系

侧边对话是**用户向**补充：不新增模型原语、不动 `AI_TOOL_DEFS` 与工具守则；与原语 6（子提问通知主）共享注入管道，与原语 3/4（排队/插队）共享收件箱语义。

### 4.10 子代理压缩：auto-compact + 手动压缩（2026-11-14 增补）

> 现状：子代理无压缩机制（`ai-subagents.js:46` 模块注释自述）；消息数超 `AI_SUB_MESSAGES_MAX`（400）置 `wrapUp` 强制收尾轮兜底。主对话「无逐轮硬上限、靠 auto-compact 控量」的能力子代理没有——本节补齐，wrapUp 保留为最终兜底。以下主会话压缩事实均为 2026-11-14 调查快照（行号同前约定）。

#### 4.10.1 主会话压缩机制的可复用面（调查结论）

| 机制 | 事实 | 子代理侧结论 |
|---|---|---|
| 摘要注入 | `buildApiMessages` 对 `session.summary` 是通用形状判断（`ai-panel.js:3300-3305`，第二条 system `<conversation_summary>`），`sub.session.summary` 字段已有（恒 null） | **零改动生效**：赋值 `{text:…}` 即注入 |
| 压缩请求 | `compactTranscript`（9564-9586）只读 messages、会话无关；system = `AI_COMPACT_SYSTEM_PROMPT`（保留偏好/决定/事实/路径/未完成，≤800 字）；工具数组传空 | 提示词与转录组装**原样复用** |
| 截断落账 | `finishCompact`（9705-9742）：cutoff = 保留最近 6 条且回退锚定 user 轮（9720-9721）；summary 形状 `{text, upTo, createdAt, trigger, before}`；磁盘归档先于内存裁剪（9729） | 抽出纯函数内核（G1）；子侧跳过磁盘归档/渲染/队列冲刷；`subAgentTranscripts` 是展示层、独立于 messages——**详情视图全程可看，展示与上下文分离** |
| 事件路由 | 全局单 `oneShot`（`ai-panel.js:406`），`handleEvent` 最优先匹配（7503-7522）；`startCompact` 守卫含**全局** `anyStreaming()`（9600） | **不能复用全局 oneShot**：后台子代理压缩时父会话常在流式，全局锁互相卡死 → 新增 `subCompacts` Map（subId → oneShot 形状）；路由分支插在 oneShot 之后、**subAgents 分支之前**——否则 `payload.id.split('#')[0]` 命中 `handleSubEvent`，其只认当轮 roundId（`ai-subagents.js:870`）而静默丢弃压缩事件 |
| roundId | `session.id + '#compact-' + ts + '-' + seq`（9626），不占 round 命名空间 | 同构：`sub.id + '#compact-…'`；`AIStop(sub.id)` 前缀匹配天然覆盖取消压缩 |
| 触发与阈值 | `maybeAutoCompact` 仅在 finishStream 尾部且要求全局空闲；`config.autoCompact` + `autoCompactThreshold`（默认 0.8）+ `autoCompactCount` 连续 2 次上限、成功轮清零 | 子侧触发点改在 `runSubRound` 轮边界（本就串行空闲）；开关与阈值**复用 config，零新设置**；连续 2 次上限镜像为 per-sub 计数 |
| usage 记账 | 压缩调用不读 `payload.usage`、不入账 | 保持同等粒度 |

#### 4.10.2 auto-compact（子代理）

- **检查点**：`runSubRound` 开头、创建 assistant 与 `buildApiMessages` 之前（与收件箱消费同一边界；顺序=先消费收件箱再判定压缩，避免把刚到的指令压进摘要）：`s.wrapUp` 已置或 `roundNo >= maxRounds` 时跳过；`config.autoCompact` 开启且 `estimateApiMessagesTokens(buildApiMessages(sub.session, null, s.systemPrompt))` ≥ `contextWindowOf(entry) × config.autoCompactThreshold` → 压缩（子工具集固定小集合，工具开销并入估算常数）。
- **执行**：置 `sub.compacting = true`（HUD 详情视图 meta 显示「压缩中」）→ `subCompacts.set(sub.id, …)` → `AISendChat(sub.id + '#compact-…', flow.profileCfg, 压缩消息, [], retryMax)`；成功 → 内核应用 summary + 裁剪 messages；失败 → 清注册走普通 ai-error 路径，连续失败由计数收敛到 wrapUp。完成后 `sub.compacting = false`，继续本轮。
- **防循环**：per-sub 连续压缩计数，一轮正常完成（未触发压缩）即清零；≥2 次后不再自动压缩，交 `AI_SUB_MESSAGES_MAX` wrapUp 收尾——与主会话 `autoCompactCount` 语义一致。
- **与既有预算的关系**：压缩只扩消息容量，不动 `maxRounds`（真实预算）与 400 条 wrapUp 兜底；`subAgentTranscripts`、结算 summary、wait_agent 语义（压缩中未终态）均不受影响。

#### 4.10.3 手动压缩（两个发起方）

1. **主代理**：新工具 `agent_compact(agentId)`（§4.5，G3 起成四件套）：
   - 运行中 → 置 `sub.compactRequested`，下一轮边界执行（不打断在飞工作），返回「已请求压缩，将在当前工具轮结束后执行」；
   - done 且可续的 records → 立即压缩（不开轮），返回前后估算与摘要前 200 字；之后 `agent_send` 冷唤醒天然以瘦身上下文续跑（与 §4.3 协同）；
   - error/stopped 记录 → 拒绝「已终止，无需压缩」。
2. **用户**：agentView footer「压缩」按钮（与 F3 输入行同区域）走同一 `requestSubCompact(sub)` 入口；按钮态跟随 compacting/可续状态。
3. **不通知父会话**：压缩不是结算，不发 notice；模型经工具结果得知，用户经 HUD 得知。

#### 4.10.4 互斥与停止语义

- **用户停止**：`stopSubAgent` 在压缩中 → `AIStop(sub.id)` 前缀取消压缩流 → subCompacts 清理 → finalize('stopped')（对齐主会话「压缩中点停止 = cancelOneShot」，`ai-panel.js:7654-7657`）。
- **压缩中收到 urgent（steer）→ 降级为排队**：不置 steerKick、不 AIStop（避免丢摘要），压缩完成后下一边界消费——`steerSubAgent` 入口加 compacting 判断。
- **主会话 oneShot 与 subCompacts 完全独立**：父压缩不阻塞子压缩，反之亦然；`startCompact` 的全局 `anyStreaming` 守卫不适用于子（后台子代理定义上与父并发），子侧守卫只有「本 sub 空闲或在轮边界」。
- **父会话压缩中（compactOf(parent)）收到子结算通知** → 走 §4.4 时机 2 队列，不受影响。

### 4.11 ai-panel.js 拆分边界：本方案负责的部分（2026-11-14 增补）

> 决策：「ai-panel.js——交给消息化方案消化（子代理运行时/消息队列/旁路会话还会拿走几千行），现在硬拆留守核心边际收益最低」。本节把「消化」落成可验收的边界：**不整体拆 panel，施工即搬迁**——凡本方案触及的域逻辑与新增能力一律落模块，panel 只留薄接线；行号同前为 2026-11-14 快照（panel 现 11071 行）。

#### 4.11.1 存量清单：本方案域在 panel 的剩余部分

| 域 | panel 存量（file:line） | 处置 | 归宿 |
|---|---|---|---|
| 消息队列尾巴 | `messageQueue`/`interjectPending` 所有权在 panel（466-467），flush 调用点散布（8929、9741、7311-7315） | 所有权移入队列模块（panel 经模块 API 访问），flush 调用点收敛 | ai-message-queue.js（随 A1 顺带） |
| spawn 执行 | executeTool 的 spawn_agent case（6386 附近，阻塞等待与结果拼装） | B 拆 mode 后 case 变薄（转发 startSubAgent/wait） | 逻辑进 ai-subagents.js |
| agent meta 恢复 | normalizeSession 的 `m.agent` 逻辑（1054-1068） | 移为 ai-subagents 导出的 normalizeAgentMeta，normalizeSession 转调 | ai-subagents.js |
| 死别名 | `subAgentLimit`/`subAgentMaxDepth`（10836-10837，无调用者） | 删除 | — |
| 压缩内核 | `compactTranscript`（9564-9586）+ finishCompact 的 cutoff/summary/裁剪段（9714-9733） | G1 抽出；主压缩 UI 守卫与 oneShot 生命周期**留守**（主会话域，不属本方案） | ai-compact.js（新） |
| 事件路由/停止链路 | handleEvent 子代理分支（7524-7529）+ G2 的 subCompacts 分支；stopGeneration 内 stopSubAgentsOf 调用 | **保留**——路由与停止是 panel 职责，薄分支转调模块 | panel 留守 |

#### 4.11.2 新增能力的归宿（施工即搬迁）

| 能力（阶段） | 归宿 | panel 只留 |
|---|---|---|
| `startSessionTurn` 内核（A） | **panel 内参数化抽取，不新建模块**：内核与 streams/oneShot/persist/startRound 等闭包状态深度耦合（约 12 项依赖），独立模块的注入面大于收益；消费者（notices/支线/定时任务）经 ctx 拿函数即可，与 ai-schedule 调 sendAppMessage 同模式 | 函数本体（~110 行） |
| notices 通道 + `deliverAgentNotice` + `buildSettlementNotice` + 消费 fold + 唤醒（B） | **ai-agent-notices.js（新）**，~200 行 | handleToolRound/finishStream 各一个薄调用点 |
| 收件箱/冷唤醒/steerKick/统一停止/`settledPromise` + agent_send / agent_stop / agent_compact / wait_agent 执行体（C/D/E/G3） | **ai-subagents.js**（1015 → 约 1700+ 行） | executeTool 薄 case（每个 ~8 行）+ 路由分支 |
| 子压缩执行体 + subCompacts（G2） | **ai-subagents.js** | 路由薄分支 |
| 支线对话动作域（创建/引用/带回/提升）（F） | **ai-sidechat.js（新）**，~200 行；sideOf 渲染改造进 ai-session-list.js；agentView 输入行在 ai-subagents.js | 菜单/操作条接线 + 消息操作条分发一行 |
| agentView「压缩」按钮（G3） | **ai-subagents.js**（HUD 本在其中） | 无 |
| 会话信箱 / 投递执行体 + session_list / session_send（H） | **ai-agent-notices.js**（信箱 = notices 通道正式化）；选择器 UI 在 ai-session-list.js | executeTool 薄 case |

#### 4.11.3 净账（诚实口径）

- 存量摘出 ≈ **-200 行**：压缩内核 ~120-150 + 队列所有权 ~20 + agent meta ~15 + spawn case 变薄 ~30 + 死别名 2。
- 新增能力 ~1000+ 行（notices ~200、子代理运行时增量 ~500、sidechat ~200、子压缩 ~150）**全部落在模块**——panel 对照「直接写进 panel」的写法少增同量，这是本方案对 panel 的主要价值。
- panel 绝对规模预计 11071 → ~10900（±100）。「几千行」的构成 = 新增能力不进 panel + 历史已拆走的 ai-subagents.js / ai-message-queue.js；**本方案对 panel 现有存量的硬拆到此为止**，与「硬拆留守核心边际收益最低」一致。

#### 4.11.4 验收

1. 阶段结束时 grep 验证：ai-panel.js 不含 inbox / subCompacts / notices 队列 / sidechat 的实现体（只允许 ctx 转发与薄 case）；
2. 新模块满足「factory + 显式依赖注入、`deps.X` 惰性求值」约定（AGENTS.md 前端侧），测试与源码同目录；
3. §9 的 A1/B2/C2/F1–F3/G1–G3 完成定义包含归宿检查（对照 §4.11.2 表）。

### 4.12 共享信箱与会话间投递（2026-11-14 增补）

> 需求：多个 AI 会话之间收发消息（**不是**主↔子代理通信）。MQTT 类比取其语义（信箱/投递/回执），不取其形（broker/topic/QoS）——做的是「会话间挂号信」，不是消息中间件。范围限**同窗口**内存会话（浮动窗是独立进程，跨窗口需 Go 侧事件总线，违反本方案「不改 Go 侧」，见 §8）。

#### 4.12.1 结论：信箱 = sessionAgentNotices 的正式化，一条管道 N 个发送方

§4.4 的 `sessionAgentNotices`（按会话键控的注入队列 + 三态投递）本身就是「每会话一个信箱」。本节**不新建第二套队列**，而是把它正式化为共享信箱，发送方扩充为三个：子代理结算/提问（B）、支线带回（F2）、会话间投递（H）。注入渲染（app 卡片）、消费点（工具轮边界 / 压缩重试 / 空闲唤醒 `startSessionTurn`）、未读标记全部复用，零新传输层。

| MQTT 概念 | 本方案对应 | 取舍 |
|---|---|---|
| broker | 无中间者：发送方直调 ai-agent-notices API | 不引入 |
| topic/订阅 | 寻址即单播：targetSessionId 精确投递 | 不做 pub/sub、通配符、fan-out |
| QoS/retain | 忙=排队（下轮边界）、闲=唤醒新轮、归档=拒收回执；信箱不持久化 | 内存态，重启即清（与排队消息同 precedence） |
| 回执 | 投递成功返回 `{messageId, targetState}`；不保证回复 | 消息即通道（dsh §3.4.1 同构），无请求-响应配对 |

#### 4.12.2 工具面（模型向）

- `session_list()`：列出本窗口内存会话（id/标题/状态 streaming/compacting/idle/归档标记/工作区，最近活动倒序，上限 50），**默认仅列同工作区会话**（跨工作区标题不进当前上下文，防串味；显式参数才放开）——模型**不知道**其他会话 id，必须先查后投。
- `session_send(targetSessionIds, message, urgent?)`：**单播与组播同一工具**，targetSessionIds 为 1–10 个显式 id（组=显式目标列表，**不做常驻组/topic 注册**——成员生命周期与过期状态是纯负担，工作区分组已覆盖用户侧归堆需求）。守卫矩阵：
  - 逐目标校验：存在且未归档；拒绝自投递；目标数 >10 **整体拒绝**并提示拆分；
  - 信箱深度上限 10 条未消费，满则该目标拒收回执「对方信箱已满」；**部分失败允许**，逐目标回执 `{results:[{targetSessionId, ok, messageId?, reason?}], woke}`；
  - `urgent=true` → 插到各信箱**队首**（下一边界最先消费），**不 AIStop**——会话是平权对等体，打断另一个会话的在飞生成不是模型向模型的权力（对自己子代理才有 agent_send urgent 的 AIStop 权）；用户对会话的打断走既有 composer 插话（Ctrl+Enter）；
  - **sender 身份由运行时从 ctx.session 填充**（id + 标题），模型参数不可伪造；
  - 投递 = 逐目标 `deliverAgentNotice(target, {kind:'session', label:'来自会话「X」', content, sender})`。
- **模型侧没有广播**：不存在任何通配寻址（全部/运行中/工作区全部）——闲会话被投递即被唤醒，通配等于唤醒风暴，且「运行中」集合在发送到消费间有竞态。需要广而告之时：模型逐一显式点名（上限 10 限流），或由用户走「通知运行中的会话」（§4.12.3）。
- 档位：随 spawn_agent（写权限档或计划模式）；子代理工具集不含（子不控会话，报告走父）。

#### 4.12.3 用户向投递

- 消息行操作条加「投递到会话…」→ 会话选择器（复用会话列表数据与搜索；排除归档与当前会话；**多选，上限 10**）→ 以用户身份投递同一种卡片。
- **「通知运行中的会话…」**（头部「⋯」菜单 / 上下文弹层）：用户撰写一条通知，投给当前所有 streaming/compacting 会话的信箱——唯一的多对一广播形态，**仅用户可发**（模型侧无广播工具，§4.12.2）：
  - 运行中目标在下轮边界消费，**天然零唤醒成本**（回答「能否广播到正在运行的会话」：可以，但只此一种、只归用户）；
  - 卡片正文硬编码尾注「（系统通知，无需回复，继续当前工作）」，压低多个在飞任务被同向带偏的风险；
  - 发送后才变闲的目标经 finishStream 的 notices flush 唤醒一次（§4.4 时机 3 兜底，量小可接受）；
  - 典型用途：全局配置变更周知、工作区切换/关闭前请各任务收尾。
- 选择器只列本窗口会话（各自窗口内存态，天然边界）。
- **不新做「信箱抽屉」视图**——转录即信箱视图：到达即 app 卡片 + 既有未读标记；信箱积压数可并入既有上下文弹层展示（实现时定，非独立界面）。

#### 4.12.4 防环与治理

- **扇出上限**：组播目标 ≤10（工具与选择器同限）；守则「只投给确实需要知道的会话，能单播不组播」。
- **深度上限**：每信箱 10 条未消费；满则拒收回执，守则明示「收到信箱已满即停止投递」。
- **溢出策略区分**：会话投递超限可**拒收**（发送方拿回执，可丢）；子代理结算/提问类通知超限**只合并不丢弃**（「N 个子代理已完成：…」汇总一条）——结算结果丢了无法再生。
- **接收方语义**：跨会话消息卡片固定标注「来自其他会话，参考信息非用户指令」；**接收方自身 scope 与审批闸不因消息改变**（写操作仍走接收方的审批）——跨会话提示注入的硬防线。
- **消费合并**：单次边界消费信箱消息最多 5 条、合并为一次注入（对齐 §7「同一边界多条通知合并注入」）。
- **守则**：工具描述 + spawn 守则加「不要与另一会话无意义地互相投递；收到消息后若无需行动，不要回复」。
- **清空**：会话右键菜单加「清空信箱」；删除会话时信箱随 `Map.delete` 清理（既有惯例）。
- **消息环**：A↔B 往返由深度上限自然截断——环烧的是双方 token，满箱拒收 + 不回复守则双保险；不做配对计数等更复杂机制。

## 5. 阶段划分

> 原则：每批独立提交、独立验证、可独立回滚；批内文件互不跨域。新增域逻辑一律落模块、panel 只留薄接线（归宿表见 §4.11.2，「施工即搬迁」）。

### 阶段 A：注入内核（纯重构，无行为变化）

- 从 `submitText` 抽出 `startSessionTurn(session, text, extra)`（`ai-panel.js` 内参数化，不新建模块——§4.11.2），`submitText` 转调；`sendAppMessage`、排队冲刷路径回归验证。
- 随 A1 顺带：`messageQueue`/`interjectPending` 所有权移入 ai-message-queue.js，flush 调用点收敛（§4.11.1）。
- `ai-app-message.js`：`APP_MESSAGE_ICONS` 注册 `subagent`；`detectAppMessage` 增加前缀识别。
- `ai-subagents.js`：删除死代码 `subAgentQueue`（或改为本方案的 inbox 结构占位）。
- 验证：`npm test`（既有 111 用例）+ 手工回归「定时任务注入 / 排队插话 / 后台会话完成通知」。

### 阶段 B：后台派单 + 完成/失败通知（原语 1、7、5）

- `ai-subagents.js`：`runSubAgent` 拆 `startSubAgent`（建记录、入 `subAgents`、启动首轮）与阻塞等待；新增 `subAgentRecords`、`finalizeSubAgent` 改造（终态入 records、done/error 发通知、blocking 模式不发避免双份）；**移除 8000 字符截断**（`AI_SUB_SUMMARY_MAX` 常量与尾注一并删，投递层全量——§4.4 决策）。
- `ai-agent-notices.js`（新）：notices 通道、`deliverAgentNotice`（签名 `(session, {kind,label,content})` 通用形）、`buildSettlementNotice`、消费 fold 与空闲唤醒（§4.11.2）。
- `ai-panel.js`：`handleEvent` 子路由兜底查 records；`spawn_agent` case 支持 mode（薄 case）；`handleToolRound` 工具循环后、`finishStream` 后各接一个 notices 薄调用点。
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

- `ai-tool-defs.js` + `ai-subagents.js`：`wait_agent`（内部复用结算 promise：blocking 模式的 `outcomePromise` 机制泛化为每子一个 `settledPromise`，finalize 时 resolve；wait 按 agentId 或任意竞速）。**等待轮询中检查主回合停止标志（含 stopSubAgentsOf 路径）：用户停止即返回状态快照**——否则停止后最长 600s 才有响应，形同悬挂。
- `ai-panel.js`：spawn/守则系统提示更新；HUD 收尾。
- `CHANGELOG.md`、`README.md` 对应小节。
- 验证：并行 3 子代理 + wait_agent 汇总；全量 `go test ./...`（确认零 Go 改动）+ `npm test` + `vite build` + `wails build`。

### 阶段 F：侧边对话（用户向旁路会话；§4.9）

> F1 无前置依赖，可与阶段 A 并行；F2 依赖 B（注入管道）、F3 依赖 C（收件箱），默认排在 E 后整批落地，也可随依赖就绪穿插。模块归宿：动作域 ai-sidechat.js（新）、列表渲染 ai-session-list.js、agentView 输入行 ai-subagents.js（§4.11.2）。

- F1：`sideOf` 元数据（normalizeSession / buildSessionMeta / 创建者）+ 列表缩进与徽标 + 创建入口（头部菜单 + 消息操作条）+ 引用预填（含单测：sideOf 归一化、组内排序 fold）。
- F2：「带回主对话」（`deliverAgentNotice` 泛化 + 空闲唤醒 / 忙排队注入 + 母会话缺失兜底）。
- F3：agentView 输入行（排队 / 插队 / 冷唤醒入口 / 「用户插话：」前缀区分）（含单测：from 区分与禁用态）。
- F4：「提升为独立会话」、母会话删除兜底、CHANGELOG/README 补记、回归（§6 第 11–13 条）。

### 阶段 G：子代理压缩（§4.10）

> G1 无前置依赖，可与阶段 A 并行；G2 依赖 G1；G3 的 agentView 按钮建议排在 F3 后（同 footer 区域），工具面可与 C2 同批评审。

- G1：抽压缩应用内核（cutoff 计算 + summary 形状 + messages 裁剪，从 `finishCompact` 逐字搬移参数化；磁盘归档/渲染/队列冲刷留在外面）+ 主压缩路径回归（含单测：cutoff 锚定 user 轮、summary 形状）。
- G2：`subCompacts` 注册表 + `handleEvent` 路由分支（先于 subAgents）+ `runSubRound` 轮边界触发 + 连续计数 wrapUp 兜底 + HUD「压缩中」（含单测：阈值触发、防循环收敛、压缩事件不被 handleSubEvent 吞）。
- G3：`agent_compact` 工具（AI_TOOL_DEFS / toolsForScope / 执行 case）+ agentView「压缩」按钮 + steer 降级与停止互斥（含单测）。
- G4：spawn 工具守则补 `agent_compact` 说明；CHANGELOG/README。

### 阶段 H：共享信箱与会话间投递（§4.12）

> 依赖 B（信箱正式化的底座：注入通道 + 唤醒）。H1 可在 B 落地后与 C/D 并行评审。

- H1：`sessionAgentNotices` 正式化为共享信箱（深度上限 / 队首插入 / 回执）+ `session_list` / `session_send`（单播/组播统一、目标数上限、逐目标回执；执行体进 ai-agent-notices.js，panel 薄 case）（含单测：守卫矩阵、部分失败、队首消费顺序、深度与扇出上限）。
- H2：用户「投递到会话…」（多选选择器）与「通知运行中的会话…」动作（ai-session-list.js）+ 卡片 sender 展示。
- H3：防环治理（守则 / 清空入口 / 消费合并上限）+ 验证（§6 第 17–19 条）+ CHANGELOG/README。

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
11. 支线对话：母会话流式中开支线 → 两条流并存互不打断 → 支线正常收发（默认只读档、可带附件）→ 列表缩进/徽标正确 → 重启后支线完整保留（普通持久化会话）。
12. 带回：支线结论「带回主对话」→ 母会话空闲时唤醒新轮（app 卡片「支线结论」）；忙时下轮边界注入；母会话已删除时兜底提示不崩；用户视图不被切走、母会话出未读标记。
13. 子代理视图插话：agentView Enter 排队 / Ctrl+Enter 插队 → 子转录出现「用户插话：」→ 对 done 子代理输入触发冷唤醒（`subId#2-1` 路由正确）→ 失败记录输入禁用并显示原因。
14. 自动压缩：长探索任务使子代理轮边界估算超阈 → HUD「压缩中」→ 完成后上下文出现第二条 system `<conversation_summary>`（抓包/日志确认）→ 后续轮继续 → 连续 2 次后不再压缩、由 wrapUp 收尾。
15. 手动压缩：`agent_compact` 对运行中子代理返回「已请求、下一轮边界执行」；对 done 记录立即压缩并返回前后估算与摘要预览，随后 `agent_send` 冷唤醒以精简上下文续跑；agentView「压缩」按钮同链路；error/stopped 记录拒绝。
16. 压缩互斥：压缩中 `agent_stop`/用户停止 → 压缩取消 + 终态落账；压缩中 urgent 消息降级排队（摘要不丢）；父会话压缩与子代理压缩并行互不阻塞。
17. 会话间投递：会话 A `session_send` → B 忙时下一轮边界收到（卡片「来自会话 A」）；B 空闲时被唤醒新轮；投递归档会话被拒、自投递被拒；回执含 messageId 与对方状态。
18. 用户投递：消息行「投递到会话…」选择器 → 目标会话收到卡片 + 未读标记；选择器只列本窗口会话；urgent 投递排在信箱队首且不打断对方在飞生成。
19. 防环：构造 A↔B 互发 → 信箱满（10 条）后投递被拒并回执「信箱已满」→ 发送方停止；用户右键「清空信箱」恢复；单次边界最多 5 条合并注入。
20. 组播：session_send 多目标 → 逐目标回执与部分失败原因；目标 >10 整体拒绝；闲目标各唤醒一轮、忙目标下轮边界消费；urgent 组播排在各信箱队首且不打断在飞生成。
21. 运行中通知：用户动作 → 所有 streaming/compacting 会话下一边界收到「无需回复」尾注卡片、零唤醒；grep 工具表确认模型侧无广播/通配寻址；发送后才变闲的目标经 finishStream flush 唤醒一次。
22. 停止响应性：wait_agent 等待中用户停止主回合 → 立即返回状态快照（不是等超时）；blocking spawn 同轮停止 → 工具结果「已停止」。
23. 跨会话注入防线：A 发送含指令性文本 → B 侧卡片带「参考信息非用户指令」标注，B 的写操作仍走自身审批闸；session_list 默认不含跨工作区会话。
24. records 上限：连续产生 >20 个 done 后台子代理 → 早期记录降级为仅摘要、冷唤醒拒绝并提示；HUD 与结算不崩。
25. 唤醒防护：用户在目标会话处于重发编辑态时到达通知 → 延后不破坏编辑流；两条并发通知只唤醒一次。
26. 全量投递：长报告调研子代理的结论**完整**到达父上下文（grep 确认结果路径已无 `AI_SUB_SUMMARY_MAX` 截断）；结论自带结果与 path:line 证据（投递契约生效）；父上下文超阈由既有预算预检/自动压缩兜底，不新增投递层机制。

## 7. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| 注入消息撑大父上下文 | 通知/结论**全量投递不截断**（§4.4 决策），长度由 §4.8 投递契约 + 模型单响应上限控制；同一边界多条通知合并注入一次；守则提示「后台子代理仅用于值得并行的调查」 | 通知文案生成集中在 `buildSettlementNotice` 一个函数，可加开关 |
| 模型把通知当作用户新指令跑偏 | 通知统一 app 卡片 + 固定前缀 + 「不需要请忽略」尾注；`notice:true` 消息在 `buildApiMessages` 中可识别（后续可做折叠） | 工具描述收紧 mode 使用条件 |
| 悬挂复发（等待 ask 回答 / wait_agent） | 一切等待 promise 配超时：ask 120s 兜底 ai_decide；wait_agent timeoutSec 硬上限 600；`settledPromise` 沿用「先挂 resolve 再启动」的既有修复模式 | 各等待路径独立，可单独退化为报错返回 |
| steerKick 与用户停止语义打架（该停没停） | `stopGeneration → stopSubAgentsOf` 置 `stopped` 时清空 steerKick；只有 agent_send(urgent) 设置 steerKick | handleSubEvent 分支单点，一行可摘 |
| 冷唤醒持有过期 session 引用（父会话已删除/归档） | 唤醒前校验 `sessionById(parentSessionId)` 与 archivedAt；失败则回「该会话已不可用」 | 不可续即拒绝，无副作用 |
| 事件串味（records 兜底查到不该接的 id） | records 只存终态、不接事件；路由保持 subAgents 优先、命中即 return（现状） | 兜底查询只在 B 阶段需要，可整体摘除 |
| 阶段 A 重构伤及 submitText 主路径 | 抽取为逐字搬移 + 差异最小（session 参数化）；回归清单第 10 条 | 单提交单回滚 |
| 支线结论带回被主代理当新指令跑偏 | 带回是用户主动动作（语义等同用户指令），app 卡片 + label 标明「支线结论」 | 退化为「回填母会话草稿、不自动发送」 |
| 母会话与支线双流并发的速率/成本 | 并发流是既有显式设计（streams 按会话隔离，`ai-panel.js:1502-1504`）；支线默认只读档降低工具开销 | 支线随时可归档/提升，无专属机制需回滚 |
| 母会话删除后 sideOf 悬空 | 渲染兜底按普通会话；「提升为独立会话」清 sideOf | 纯元数据，无副作用 |
| agentView 输入行与简化渲染互相干扰 | 输入行是独立 footer，不触碰消息渲染区 | 摘掉输入行即回 C4 状态 |
| 子代理压缩事件被 handleSubEvent 静默吞掉 | 路由顺序固定：subCompacts 分支先于 subAgents 分支（payload.id 精确匹配 compact id）；单测覆盖 | 分支单点，可摘 |
| 压缩循环（压缩后仍超阈） | 连续计数 ≥2 停止自动压缩，wrapUp 兜底（镜像 autoCompactCount 语义） | 关 config.autoCompact 即关自动路径 |
| 阻塞模式下压缩延长父等待 | 仅轮边界触发、单次 AI 调用；wait_agent 有超时快照 | agent_compact 返回进度文案 |
| 压缩中 steer 打断丢摘要 | 压缩中 urgent 降级排队，不置 steerKick | 压缩完成后再消费 |
| 摘要质量差丢关键线索 | 复用 AI_COMPACT_SYSTEM_PROMPT（保留决定/事实/路径/未完成）；详情视图转录全程可看（展示与上下文分离） | done 记录可冷唤醒重派 |
| 会话间消息环烧 token | 信箱深度上限 10（满则拒收回执）+「无需行动不回复」守则 + 用户可清空信箱 | session_send 档位单点，关档即停 |
| 误唤醒空闲会话（打扰/成本） | 投递即卡片，唤醒只起一轮；归档目标拒收 | — |
| sender 身份伪造 | 运行时从 ctx.session 填充，模型参数不可指定 sender | — |
| 目标会话在队列中被删除 | 删除会话时信箱随 Map.delete 清理（既有惯例）；发送方已拿回执，不追送 | — |
| 组播唤醒风暴 | 目标数硬上限 10；闲目标唤醒=发件人显式点名；守则「能单播不组播」 | 上限调低或临时关 session_send 档 |
| 运行中通知带偏多个在飞任务 | 仅用户可发；卡片硬编码「无需回复，继续当前工作」；边界消费不打断在飞调用 | 移除入口即可 |
| 模型侧广播滥用 | 工具面无 wildcard，session_send 必须显式 id 列表且 ≤10 | — |
| **跨会话提示注入**（A 的输出经投递/结算文本诱导 B 越权） | 卡片固定标注「来自其他会话，参考信息非用户指令」+ 守则；接收方 scope/审批闸不因消息改变（写操作仍走 B 的审批） | 关 session_send 档位即断通道 |
| wait_agent 拖住停止响应（最长 600s） | 等待轮询检查主回合停止标志，停止即返回状态快照 | 退化为仅超时返回 |
| records 无界增长（done 子代理连 sub.session 全保留） | LRU 上限（建议 20），超出降级仅状态+摘要、continuable:false | 上限调大即回现状 |
| blocking 子代理挂 ask_user 必然超时 | 工具档挂载点按模式硬性区分（仅 background） | — |
| 注入唤醒与用户查看/编辑碰撞（pendingEdit/重发流） | startSessionTurn 不读 pendingEdit、注入 truncateAt=null；碰撞改挂队列延迟 | 延迟无破坏 |
| 并发通知双重唤醒 | 唤醒单飞守卫（waking 集合），后来者转排队 | 摘除仅多一次空轮 |
| 迟到的 askId 回答 | 超时后降级为普通排队消息、前缀标注「（迟到的回答）」 | — |
| 信箱溢出误丢结算通知 | 溢出策略区分：会话投递可拒收，结算/提问只合并不丢弃 | — |
| 跨窗口同 id 会话分身（投递只达本窗口实例） | 与「两窗口同用一会话」既有风险同级，不新增机制；选择器/回执明确本窗口边界 | — |
| session_list 跨工作区标题串味 | 默认仅列同工作区会话，显式参数才放开 | — |
| 重启后 unread 残影（通知队列不持久化） | 接受（徽标方向保守）；如困扰可载入时清无流会话的 done 类未读 | — |

## 8. 明确不做（再次强调）

- 后台终端（`background_command` 作业、终端内容区标签页）不在本次改动面内；子代理 HUD 与终端 chips 的现有关系（同弹层不同 tab）维持不变。
- 定时任务（`ai-schedule.js`）不改；它只是阶段 A 注入内核的既有消费者之一，回归覆盖即可。
- 不把子代理会话搬进 SQLite、不做会话索引、不改 `sessionstore*`。
- 支线对话不实时共享母会话上下文（引用/快照制，不做自动同步）；sideOf 不嵌套（不做支线的支线）。
- 不把子代理转录物化为持久会话或塞进会话列表；agentView 输入行不引入第二套持久化。
- 子代理压缩摘要随 `sub.session`/records 内存态保留，不落盘、不进父会话 JSONL；不给压缩加新设置项（复用 `config.autoCompact` / `autoCompactThreshold`）。
- 共享信箱不做跨窗口/跨进程投递（浮动窗与主窗各自内存态；跨窗口需 Go 侧事件总线，超出本方案）；不做 MQTT 式 broker/topic/订阅/QoS/retain；不做常驻组注册（组=显式目标列表）；信箱不持久化（重启即清，与排队消息同 precedence）；不做请求-响应配对与自动回复链（消息即通道）。**模型侧无任何广播/通配寻址**（组播 ≤10 个显式目标）；「通知运行中的会话」仅限用户动作。

## 9. 任务清单

- [ ] A1 抽 `startSessionTurn` 内核 + 队列所有权迁移 + 回归
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
- [ ] F1 支线会话 sideOf 元数据 + 列表呈现 + 创建入口/引用预填（含单测）
- [ ] F2 带回主对话（deliverAgentNotice 泛化 + 唤醒/排队注入 + 兜底）
- [ ] F3 agentView 输入行（排队/插队/冷唤醒入口/from 前缀区分）（含单测）
- [ ] F4 提升为独立会话 + 删除兜底 + 文档与回归
- [ ] G1 抽压缩应用内核 + 主压缩路径回归（含单测）
- [ ] G2 subCompacts + 轮边界 auto-compact + 防循环 + HUD「压缩中」（含单测）
- [ ] G3 agent_compact 工具 + agentView 压缩按钮 + steer/停止互斥（含单测）
- [ ] G4 工具守则 / CHANGELOG / README
- [ ] H1 共享信箱正式化 + session_list / session_send（单播/组播）工具与执行（含单测）
- [ ] H2 用户「投递到会话…」（多选选择器）+「通知运行中的会话」动作
- [ ] H3 防环治理 / 守则 / 清空入口 / 文档与回归
