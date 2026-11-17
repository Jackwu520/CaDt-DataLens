# AI 插话 / Turn Steering 方案

> 状态：**已实施（2026-11-17），存档**（实施记录与偏差见 §13）
> 关联：`frontend/src/ai/ai-message-queue.js`（现有插话实现）、`frontend/src/ai/ai-panel.js`（工具循环与流管理）、`frontend/src/ai/ai-composer.js`（输入区手势）、`internal/aichat/chat.go`（后端流注册表）

## 1. 背景

### 1.1 DataLens 现状

当前「插话」（Ctrl+Enter / 队列行「插话」按钮）的语义是**停掉当前轮 + 开新一轮**：

```
用户按 Ctrl+Enter
  ↓
interjectComposerMessage()                    ai-message-queue.js:144
  ├─ messageQueue.unshift(item)               插到队首
  ├─ interjectPending.add(session.id)         打「有插话待发」标记
  └─ stopGeneration()                         ai-panel.js:11416
       ├─ current.stopped = true
       ├─ backend.AIStop(sessionId)           取消后端流
       ├─ stopSubAgentsOf / cancelClassifierJobs / cancelPendingApprovals
       └─ setTimeout(1200ms) 兜底强制 finishStream
  ↓
finishStream()                                ai-panel.js:10649
  ├─ shouldFlush = hasInterject || (!stopped && done)    ai-panel.js:10676
  └─ flushMessageQueue(session.id)            ai-message-queue.js:173
       └─ submitText(item.text)               开新一轮
```

**问题**：
- 用户只是想「补充一句指示」，但当前轮被彻底停掉，已经完成的工具调用、流式输出全部作废
- 1.2s 兜底定时器让插话有可感知的延迟
- 语义上更接近「抢占」（preempt），而不是「插话」（steer）

### 1.2 DeepSeek harness 的做法

来源：`.agents/notes/archived/feature/2026-07-30-web-queue-steer-action.md`、`packages/api/session-controller/src/commands.ts:483-518`

**核心结构**：Agent inbox 分两个目标
- `next-turn`：排队消息，等当前轮彻底结束后开新轮
- `next-step`：steering 消息，在**当前轮的下一次 model request 边界**注入

**两套合同**：
- **Queue 行的「插话发送」是严格的**：`session.updateQueue(itemId, {kind:'steer'})` 一次同步 RPC。AgentLoop 用 `acceptsNextStep` 判断当前是否还接受 next-step 注入；窗口已关就返回类型化错误 `session/steer-unavailable`，**原 Queue 行保持不变**，消息照走 Queue 路径。UI 把这个竞态静默收敛，不报错（`packages/client/ui-conversation/src/client/input/hub.ts:302`）。
- **Composer 新输入是尽力的**：`session.prompt(mode:'steer')` 错过窗口就自动降级为下一轮的 waking follow-up，也不报失败。

**关键点**：steering **不打断当前工作**，只是「接下来模型下一次请求会看到这条」。已消费的 steering 在 transcript 里渲染成带位置语义的用户气泡（夹在被它打断的助手内容之间）。

### 1.3 ZCode 的做法

来源：`apps/zcode-cli/docs/design/v2/loop/turn-steering.md`、`apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`

**核心结构**：`steerTurn(input)` 把输入放进 active turn 的 `pendingInputs`（内存态，不持久化、resume 不恢复），发 `turn_steer_queued` 事件。

**Drain 边界**（唯一注入点，保证 provider 永远看不到悬空 tool call）：
1. 初始 user input 进 history 后，第一次 model request 前**不** drain
2. 模型返回 tool calls → 先进 history
3. 执行并注入所有 tool results
4. 构造下一次 model request 前，按 FIFO 一次取出全部 pending guide

**no-tool final response 也不结束轮**：如果模型给了最终回复但还有 pending input，本轮继续 drain + 再发一次请求。

**「运行中立即发送」是另一条路**（`turn-steering.md`「运行中立即发送（2026-10-26）」）：抢占 = 取消旧 runtime turn → 等 idle → 新 turn + 普通用户输入，**不带 `user_steer` 标记**。修复原因写得很清楚：之前被抢占的输入也标成 `user_steer`，模型看到「在当前轮继续」的提示，与用户中止旧任务的意图**相反**。

**文案合同**（`user_steer` 模板）：
```text
The user sent a new message while you were working:
{body}

This is how ZCode surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.
```

### 1.4 三者对比

| 维度 | DataLens 插话 | DeepSeek harness steer | ZCode steer | ZCode 立即发送 |
|---|---|---|---|---|
| 停当前轮？ | **停**（stopGeneration + 1.2s 兜底） | 不停 | 不停 | 停（抢占 lease） |
| 注入时机 | 本轮 finishStream 后开新轮 | 当前轮下一次 model request 边界 | tool results 之后的下一次请求边界 | 新轮起点 |
| 模型看到的提示 | 无（普通 user 消息） | 靠 transcript 位置（无外层标签） | `user_steer` 模板 | **无**（普通输入，2026-10-26 修复后） |
| 窗口关闭时 | 不存在这个概念（一定停掉） | 严格路径返回 `steer-unavailable`，降级走 Queue；尽力路径自动降级为下一轮 | 返回 `turn_not_steerable`，调用方改走队列 | 不适用 |
| 队列事实来源 | 前端 `messageQueue` 数组 | Host `queuedMirror` snapshot（`placement: 'queued'\|'steering'`） | Core `pendingInputs` + session events | 同左 |

## 2. 问题

DataLens 现在的插话语义 = 「停掉重来」，和 ZCode 的「立即发送」同类。这带来三个问题：

1. **语义混淆**：用户说「插话」，预期是「补充一句，你继续」，但实际是「停掉，重新开始」
2. **体验损失**：已经完成的工具调用（读文件、搜索、跑命令）全部作废，模型要重新做一遍
3. **延迟可感**：1.2s 兜底定时器 + 等待 `finishStream` 走完，插话不是即时的

## 3. 目标 / 非目标

### 目标

- 提供**真正的 steer**：不打断当前轮，在下一个工具边界注入，模型看到「用户在你工作时发了新消息，继续当前任务时处理它」
- 保留**抢占**语义：用户明确要中止当前任务时，停掉重来
- 两种语义在 UI 上有明确区分（手势 / 按钮）
- 窗口竞态（当前轮已结束）静默降级，不报错
- **数据结构为跨端同步预留**：单一队列 + delivery 标记，将来可整体同步到其他端（手机 / Web 远程控制）

### 非目标

- 不实现后端侧的 drain 边界（DataLens 工具循环在前端，后端只负责一次 HTTP 流式请求）
- 不实现跨端同步的传输层（第一版只做本地单进程，但数据结构要为跨端同步预留）
- 不实现 steer 输入的编辑 / 重排 / 删除（第一版只支持入队 + 自动消费）
- 不修改现有排队消息（`delivery: 'queue'`）的行为
- **steer 消息内容第一版只支持文字 + 引用 markup + 图片/视频附件**；带文件（`kind: 'file'`）附件的输入在生成中一律走排队（见 §4.5），避免在轮中重复组装 `<attachments>` 环境块

## 4. 方案设计

### 4.1 双轨制：steer + preempt

推荐**双轨制**：同一个「生成中按 Enter 系列键」的入口，按修饰键分出两种语义：

| 手势（生成中） | 语义 | 行为 |
|---|---|---|
| **Enter** | queue | 排队，等当前轮彻底结束后开新轮（现状不变） |
| **Ctrl+Enter / Ctrl+点击发送** | steer | 不打断当前轮，条目以 `delivery: 'steer'` 留在 `messageQueue`，在下一个工具边界注入，请求里带 `user_steer` 模板 |
| **Ctrl+Shift+Enter** | preempt | 停掉当前轮，消息作为普通用户消息开新一轮（原「插话」语义） |
| **Shift+Enter** | 换行 | **保持现状**（现状在生成中显式放行换行，见 `ai-composer.js:513`；不改成抢占，避免误触） |
| **队列行「插话」按钮** | steer / 普通发送 | 当前轮活着 → 该条改投 `delivery: 'steer'`；已结束 → 普通发送（现状） |

空闲时（没有 active turn）：**完全遵循现有 `aiSendKey` 设置**（默认 Enter 发送、Shift+Enter 换行；设成 `ctrl-enter` 时 Enter 换行、Ctrl+Enter 发送），不引入 preempt。

> 为什么抢占用 Ctrl+Shift+Enter：Shift+Enter 是 input 里最常用的换行手势，改成「停掉当前回复」会误伤；Ctrl+Shift+Enter 与「Ctrl+Enter 的加强版」语义顺承，且不冲突任何现有绑定。

### 4.2 前端状态

**采用 ZCode 路线**：改造现有 `messageQueue`，加 `delivery` 字段区分投递车道（单队列 + delivery 标记，为跨端同步预留单一同步单元）：

```js
// item 形状（在现有 captureComposerMessage 的基础上扩 delivery / roundId 两个字段，
// 并把 id 从自增数字换成字符串——跨端合并按 id 去重）
// 现有：{ id: ++queueSeq, sessionId, text, attachments, ts }   ai-composer.js:541
const item = {
    id: 'q_<ts>_<rand>',      // 字符串 id：跨端合并按 id 去重
    sessionId,
    text,
    attachments,              // composer 附件原样保存
    delivery: 'queue',        // 'queue' | 'steer'
    ts,                       // 入队时间（沿用现有字段名）
    roundId: '',              // 可选：入队时所属轮次（仅用于诊断，不参与过滤）
};
```

**为什么选单队列 + delivery 标记**（而不是双队列物理分开）：
1. **跨端同步友好**：单一队列整体同步，item 自带 `delivery` 字段，合并时按 id 去重即可，避免两队列错位
2. **支持动态改投**：steer 窗口关闭时可降级为 queue（改 delivery 字段即可），跨端场景下是刚需
3. **UI 渲染统一**：`renderMessageQueue` 一处搞定，按 delivery 分支显示
4. **与 ZCode 架构对齐**：将来如果做跨端同步，可以直接抄 ZCode 的设计（`turn_steer_queued` / `drained` / `discarded` 事件）

**状态机抽成纯模型**：队列数组与全部增删改逻辑收进 `createQueueModel()`（纯函数，无 DOM / flash 依赖），`createAIMessageQueue(ctx)` 只保留渲染与手势接线，内部持有模型实例。模型直接从 `ai-message-queue.js` 导出（参照 `ai-timer.js` 导出纯函数的惯例），单测不需要假 DOM，跨端同步的快照也直接落在模型上。

### 4.3 注入时机：`startRound` 的下一次请求边界

DataLens 的工具循环在前端（`ai-panel.js:10400` 的 `startRound` → `backend.AISendChat`），「下一次 model request 边界」就在 `startRound` 里。

**关键点：steer 消息要落进 `session.messages`，不能只拼进 `apiMessages`**——否则会话 JSONL 里查不到「模型实际看到了什么」，重放 / 导出 / 追溯全部失真（本仓库的 JSONL 是唯一真源）。

做法：

1. 两条续轮路径都会**先创建新的 assistant 占位**，再调 `startRound`：
   - 工具轮：`handleToolRound` 末尾（`ai-panel.js:10880-10890`）
   - 纯文本收尾：`ai-done` 的 stop + pending steer 分支（见 §5.4）也要按同样方式新建 assistant，**绝不能复用已完成的 assistant 继续写**（那会把新一轮正文追加进上一条消息）
2. `startRound` 在 `s.roundNo += 1` 之后、`buildApiMessages` 之前 drain：
   - 第一次请求（roundNo === 1）不 drain
   - 第 2 次及以后：取出该会话全部 `delivery: 'steer'` 的 item，按 FIFO 生成 user 消息 `{role: 'user', content: item.text, steer: true, images, videos, ts}`，**splice 到新 assistant 之前**，`persistSessions()`
3. `buildApiMessages` 遇到 `message.steer === true` 时，在**请求里**把 content 包成 `formatSteerMessage(...)`；落盘与会话气泡仍是用户原文
4. 模板包裹只存在于请求组装，不写回 session.messages（避免重放后越包越多）

**Drain 边界**（与 ZCode 对齐）：
1. 初始 user input 进 history 后，第一次 model request 前**不** drain（`startRound` 的第一次调用）
2. 模型返回 tool calls → `handleToolRound` 执行工具 → 工具结果进 `session.messages`
3. 下一次 `startRound`（新 assistant 占位已就位）→ drain 全部 pending steer

**no-tool final response 也不结束轮**：如果模型给了 `finishReason: 'stop'` 但队列里还有 `delivery: 'steer'` 的 item，不调 `finishStream`，而是新建 assistant 占位 + `startRound`（drain + 再发一次请求）。

**预算检查**：drain 后把 steer 消息计入 `estimateApiMessagesTokens(apiMessages)`，超过窗口 90% 时把本批 steer 改回 `delivery: 'queue'` 并 `flash` 说明（不中断本轮，也不强塞超限请求）。

### 4.4 提示词模板

参考 ZCode 的 `user_steer` 模板，但简化（DataLens 不需要区分 coordinator / peer / task notification）：

```js
function formatSteerMessage(text) {
    return `The user sent a new message while you were working:\n${text}\n\n` +
           `This is a mid-turn message. Address it as you continue your current task, ` +
           `rather than treating it as a separate conversation turn.`;
}
```

**抢占（preempt）不带这个模板**——它就是普通用户消息，模型看不到「在当前轮继续」的提示。

### 4.5 窗口竞态处理

**严格路径**（队列行「插话」按钮）：
- 点击时检查 `streams.has(session.id)`（当前轮是否还活着）
- 如果活着 → `model.setDelivery(item, 'steer')`（改投，不重排队）
- 如果已结束 → 该条照走 `flushMessageQueue`（普通发送）
- **不报错**，UI 静默降级

**尽力路径**（Ctrl+Enter）：
- 生成中 → 入队为 `delivery: 'steer'`
- 空闲 → 普通发送
- **不报错**，UI 静默降级

**轮末兜底**：`finishStream` 收尾时若还有残留 steer（例如用户恰好在本轮结束的瞬间按了 Ctrl+Enter）：
- 本轮是**停止/抢占** → 全部丢弃（`clearSteerInputs`，reason `turn_cancelled`；与「用户放弃当前任务」一致）
- 本轮是**自然结束** → 降级为 `delivery: 'queue'`，由现有 `shouldFlush` 冲刷（不会丢消息，也不需要额外的续轮路径）

**内容限制**：生成中 Ctrl+Enter 的消息若带 `kind: 'file'` 附件，直接按排队处理并 `flash`「文件附件将随下一轮发送」——steer 的第一版不做轮中 `<attachments>` 环境块重组。

### 4.6 UI 渲染

**输入区提示**（两处都要改：`ai-panel.js:9981` / `ai-panel.js:9989`，以及 `ai-message-queue.js:121-125` 的队列模块版本）：
```js
'生成中 · Enter 排队 · Ctrl+Enter 插话（不打断）· Ctrl+Shift+Enter 抢占（停掉重来）'
```

**队列行**（`ai-message-queue.js:89` 的「插话」按钮）：
- badge 按 delivery 显示：「排队」/「插话」
- `delivery: 'queue'`：按钮文字「插话」，tooltip「在当前轮的下一个工具边界注入，不打断当前工作」
- `delivery: 'steer'`：按钮文字「排队」，tooltip「撤回插话，改回当前轮结束后发送」（降级，不重排队）
- ~~不新增「抢占」按钮（行内已有编辑 / 插话 / 删除三个动作，再加会挤）；抢占只在输入框手势上提供~~ → 实施后按用户要求补了**图标抢占按钮**（⚡，`iconSvg('zap')` + tooltip「抢占：停止当前回复并立即发送这条消息」）：队列行已有三个文字动作，再加文字会挤，所以用图标；仅当前轮活着（含停止收尾窗口）时显示。
- **拖动排序**（实施后追加）：行首加 3×3 点阵拖动手柄（`iconSvg('grip')`，`draggable` 只挂在手柄上，行内按钮照常可点），拖到另一行上/下半区决定插入位置，落点用 inset 阴影提示；`model.reorderSession(sessionId, orderedIds)` 只重排该会话的槽位，其它会话位置不动（flush / drain 都按队列顺序消费，重排即生效）。

**消息气泡**：
- Steer 消息在 transcript 里渲染成普通用户气泡（第 1 版不加徽章；位置在工具结果之后、下一段助手回复之前，语义已足够，与 DeepSeek harness 后来移除徽章的做法一致）
- 会话列表 / 导出 / 搜索都按用户原文处理（`steer` 只是内部标记，不进入标题与摘要）

### 4.7 后端改动

**无需改动**。`AISendChat` 已经支持任意 `messages` 数组，前端把 steer 消息插进 `session.messages` / `apiMessages` 即可。

三套协议的兼容性已核对：
- **OpenAI 兼容**：tool 消息之后跟 user 消息合法
- **Anthropic**：`aiAppendAnthropicTurn`（`internal/aitransport/http.go:874`）会把连续同角色 turn 合并，steer 文本并入上一条 `tool_result` 的 user turn
- **Responses**：user 消息是独立 input item，追加合法

**唯一需要注意**：steer 会增加请求体积，需要 §4.3 的 90% 窗口检查（现有 `over_budget` 只在起轮时检查，轮中不复查）。

## 5. 实现细节

### 5.1 `ai-message-queue.js`：纯状态机 + DOM 壳

```js
// 纯状态机（无 DOM 依赖，直接导出供测试与跨端快照使用）
export function createQueueModel() {
    let items = [];
    let seq = 0;
    return {
        enqueue({sessionId, text, attachments, delivery = 'queue', roundId = ''}) {
            const item = {
                id: 'q_' + Date.now() + '_' + (++seq),
                sessionId, text, attachments: attachments || [],
                delivery, ts: Date.now(), roundId,
            };
            items.push(item);
            return item;
        },
        all: () => items.slice(),
        forSession: (sessionId) => items.filter((it) => it.sessionId === sessionId),
        hasSteer: (sessionId) => items.some((it) => it.sessionId === sessionId && it.delivery === 'steer'),
        setDelivery(item, delivery) {
            const target = items.find((it) => it.id === item.id);
            if (!target || target.delivery === delivery) return false;
            target.delivery = delivery;
            return true;
        },
        // FIFO 取出该会话全部 steer；roundId 只用于诊断，不参与过滤
        drainSteer(sessionId) {
            const taken = items.filter((it) => it.sessionId === sessionId && it.delivery === 'steer');
            items = items.filter((it) => !taken.includes(it));
            return taken;
        },
        fallbackSteerToQueue(sessionId) {
            for (const it of items) if (it.sessionId === sessionId && it.delivery === 'steer') it.delivery = 'queue';
        },
        clearSteer(sessionId) {
            const dropped = items.filter((it) => it.sessionId === sessionId && it.delivery === 'steer');
            items = items.filter((it) => !dropped.includes(it));
            return dropped;
        },
        snapshot: (sessionId) => ({
            sessionId,
            items: items.filter((it) => it.sessionId === sessionId).map((it) => ({...it})),
        }),
    };
}
```

DOM 壳保留现有所有权 API（`items/itemsForSession/hasItems/enqueueItem/indexOfItem/removeItem/...`；实现时把 `pushItem/unshiftItem` 收成 `enqueueItem`，全仓无其它消费方，见 §13），内部改为转发模型方法；`clearQueueForSession` 同时清 `interjectPending`。返回对象新增 `hasSteer / drainSteer / restoreItems / setDelivery / fallbackSteerToQueue / clearSteer / snapshot`，供 panel 与后续跨端同步使用。

### 5.2 `ai-message-queue.js`：手势与队列行接线

- `interjectComposerMessage()`（`ai-message-queue.js:144`）：生成中改为 `model.enqueue({...item, delivery: 'steer'})`，**删掉** `unshift + interjectPending.add + stopGeneration` 三行；压缩中（`compactOf`）仍走排队（压缩完成后才能发）。
- 队列行「插话」按钮（`ai-message-queue.js:89-107`）：生成中 → `model.setDelivery(item, 'steer')` + `renderMessageQueue()` + `flash('已改为插话：将在下一个工具边界生效')`；空闲 → 现有 `flushMessageQueue`。按钮文字按 delivery 切换（steer 条目显示「排队」可降回，见 §4.6）。
- `interjectPending` 集合并**保留**，但只服务 preempt 的「停后立即冲刷」（`finishStream` 的 `shouldFlush`）。

### 5.3 `ai-panel.js`：`startRound` drain

```js
function startRound(target) {
    // ... 现有逻辑（s.roundNo += 1 之后、buildApiMessages 之前）...

    // 第一次请求不 drain；之后每次请求前注入 pending steer（落盘原文 + 请求里包模板）
    if (s.roundNo > 1 && queueMod.hasSteer(s.sessionId)) {
        const steerItems = queueMod.drainSteer(s.sessionId);
        if (steerItems.length) {
            const msgs = steerItems.map((it) => ({
                role: 'user',
                content: it.text,
                steer: true,
                images: (it.attachments || []).filter((a) => a.kind === 'image').map(aiNormalizeImage).filter(Boolean),
                videos: (it.attachments || []).filter((a) => a.kind === 'video').map(aiNormalizeVideo).filter(Boolean),
                ts: Date.now(),
            }));
            const insertAt = session.messages.indexOf(s.assistant);
            session.messages.splice(insertAt, 0, ...msgs);
            persistSessions();
            if (isOpen() && currentSession() === session) renderMessages(true);
            // 预算检查：超窗口 90% 时把这批消息从 session.messages 移除、改回 queue 并提示
            ...
        }
    }

    const index = session.messages.indexOf(s.assistant);   // drain 之后再取索引
    const apiMessages = buildApiMessages(session, index, s.systemPrompt);
    // ... 现有逻辑（backend.AISendChat）...
}
```

`buildApiMessages` 的 user 分支补一处：`message.steer` 为真时 `content = formatSteerMessage(content)`（只作用于请求）。

### 5.4 `ai-panel.js`：`ai-done` 续轮 + `finishStream` 兜底

`ai-done`（`ai-panel.js:11299`）在 tool 分支与空回复兜底之间插入：

```js
// no-tool final response 但还有 pending steer：不结束轮，新建 assistant 占位后续一轮
if (payload.finishReason === 'stop' && !calls.length && queueMod.hasSteer(current.sessionId)) {
    current.assistant.status = 'done';
    const session = sessionById(current.sessionId);
    const assistant = newAssistantMessage(profileOf(session), entryOf(session));
    session.messages.push(assistant);
    current.assistant = assistant;
    if (isOpen() && currentSession() === session) { renderMessages(true); setStreamingUI(); }
    startRound(current);
    return;
}
```

`finishStream`（`ai-panel.js:10649`）在计算 `shouldFlush` 之前补兜底：

```js
// 轮已结束：steer 窗口关闭。抢占/停止丢弃；自然结束降级为排队（由 shouldFlush 冲刷）
if (current.stopped) queueMod.clearSteer(current.sessionId);
else queueMod.fallbackSteerToQueue(current.sessionId);
```

`stopGeneration`（`ai-panel.js:11416`）在 `current.stopped = true` 后追加 `queueMod.clearSteer(sessionId)` + `renderMessageQueue()`（抢占 = 放弃当前任务，挂着的 steer 一并作废；排队消息照旧保留）。

### 5.5 `ai-composer.js`：手势

`ai-composer.js:511-527` 的生成中分支改为：

```js
if (syncStreamView() || compactOf((currentSession() || {}).id)) {
    if (e.altKey) return;                    // Alt+Enter 保持换行
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.shiftKey) preemptComposerMessage();   // Ctrl+Shift+Enter 抢占
    else if (ctrl) interjectComposerMessage();          // Ctrl+Enter 插话（不打断）
    else if (e.shiftKey) return;                        // Shift+Enter 换行（现状）
    else enqueueComposerMessage();                      // Enter 排队
    return;
}
```

`preemptComposerMessage()` 放在 `ai-message-queue.js`（与 `interjectComposerMessage` 同域）：停止当前轮 + `interjectPending.add` + 条目 `unshift`，复用现有 `stopGeneration`。

### 5.6 持久化

**pending 态不持久化**（与 ZCode 对齐）：
- `messageQueue` 是内存态，进程重启后丢失（包括 `delivery: 'steer'` 和 `delivery: 'queue'` 的 item）
- **已 drain 的 steer 消息**是普通 user 消息（带 `steer: true` 标记），进 `session.messages` 随会话持久化——模型实际看到的内容必须在真源里可查
- 未消费的 steer 在进程崩溃后丢弃（用户重新输入即可）

**理由**：steer 是「当前轮的补充指示」，当前轮结束后就没有意义了。持久化 pending 队列会让 resume 后的会话出现「幽灵 steer」（ZCode 的 `turn_steer_discarded` 事件就是为了清理这种幽灵）。

## 6. 测试要求

### 6.1 纯模型单测（新增 `frontend/test/ai/ai-message-queue.test.mjs`，并登记 `package.json` 的 `npm test` 清单）

- `enqueue` 默认 `delivery: 'queue'`，显式 `'steer'` 生效；id 唯一
- `drainSteer` 只取该会话的 steer、按 FIFO、取后从队列移除；不碰 queue 条目
- `hasSteer` / `fallbackSteerToQueue` / `clearSteer` / `setDelivery` 的边界（空队列、重复改投、跨会话隔离）
- `snapshot` 只含目标会话、深拷贝（改快照不影响队列）
- `clearQueueForSession` 同时清 steer 与 `interjectPending`

### 6.2 源码护栏（新增 `frontend/test/ai/ai-turn-steer-wiring.test.mjs`，同样登记 `npm test` 清单）

- `ai-composer.js` 的生成中分支：Ctrl+Enter → `interjectComposerMessage`，Ctrl+Shift+Enter → `preemptComposerMessage`，Shift+Enter 仍 return（换行）
- `interjectComposerMessage` 不再调用 `stopGeneration` / `interjectPending.add`
- `startRound` 在 `buildApiMessages` 之前 drain，且条件含 `roundNo > 1`
- `ai-done` 的 stop 分支会新建 assistant 后再 `startRound`（不许直接复用已完成消息）
- `finishStream` / `stopGeneration` 分别调用 fallback / clear
- `buildApiMessages` 对 `steer` 消息包模板
- `formatSteerMessage` 文案含 `while you were working` 与 `mid-turn`（改文案要同步测试）

### 6.3 E2E 测试（手动）

- 生成中 Ctrl+Enter 补充指示 → 本轮不停，下一个工具边界后模型看到 steer 并继续
- 生成中 Ctrl+Shift+Enter → 当前轮停掉，新轮开始，请求里**没有** `user_steer` 模板
- 生成中 Shift+Enter → 换行（不发送）
- 队列行「插话」→ 生成中改投 steer，已结束则普通发送；steer 条目可点「排队」降回
- 纯文本回复中 Ctrl+Enter → 回复结束后自动续一轮处理 steer（不停轮、不丢消息）
- 带文件附件的消息在生成中 Ctrl+Enter → 降级排队 + 提示
- 关掉窗口 / 结束会话后重启 → 队列与 pending steer 均丢失；已注入的 steer 仍能在会话记录里看到

## 7. 迁移与兼容

### 7.1 现有插话行为变更

**Ctrl+Enter 语义变更**：
- 旧：停掉当前轮 + 开新一轮
- 新：不打断当前轮，在下一个工具边界注入
- 「停掉重来」迁到 **Ctrl+Shift+Enter**

**用户教育**：
- 输入区提示明确区分「插话（不打断）」和「抢占（停掉重来）」
- 首次使用时弹一次 toast 说明新语义（可选）

### 7.2 队列行「插话」按钮

**行为变更**：
- 旧：停掉当前轮 + 开新一轮
- 新：当前轮活着时改投 steer，已结束时普通发送
- 想「停掉重来」的用户改用 Ctrl+Shift+Enter，或点队列行的 ⚡ 图标（抢占按钮；见 §4.6 实施修订）

### 7.3 `aiSendKey` 设置的交互

- 空闲时语义完全不变（`aiSendKey` 决定 Enter / Ctrl+Enter 哪个是发送）
- 生成中 Ctrl+Enter 固定为 steer、Ctrl+Shift+Enter 固定为 preempt，与 `aiSendKey` 无关
- 设置页文案补一句：生成中 Ctrl+Enter 始终是「插话」，不随发送键设置变化

### 7.4 配置项（可选，非第一版）

- `steerGesture`: `'ctrl-enter'`（默认）/ `'disabled'`
- `preemptGesture`: `'ctrl-shift-enter'`（默认）/ `'disabled'`

允许用户关闭其中一个；第一版可不做。

## 8. 跨端同步预留（第二期）

虽然第一版只做本地单进程，但数据结构已经为跨端同步预留（单队列 + delivery 标记）。

### 8.1 同步单元

**单一队列整体同步**：
- `messageQueue` 是唯一的同步单元，item 自带 `delivery` 字段（`'queue'` | `'steer'`）
- 快照结构：`{ sessionId, items: [{ id, text, attachments, delivery, ts, roundId }] }`
- 合并逻辑：按 item id 去重（字符串 id 保证跨端不撞），冲突时以时间戳新的为准

### 8.2 事件合同（参考 ZCode）

| 事件 | 时机 | UI 语义 |
|---|---|---|
| `steer_queued` | 输入被接受并进入 pending 队列（`delivery: 'steer'`） | 把用户消息标记为 queued |
| `steer_drained` | pending input 已注入 `session.messages`，下一次 model request 会看到 | 把 queued 标记移除或改为 sent |
| `steer_rejected` | 输入未被接受（如 `turn_not_steerable`） | 恢复输入或显示拒绝原因 |
| `steer_discarded` | pending input 因 turn 失败、取消或恢复策略被丢弃 | 从队列投影移除并显示丢弃原因 |

### 8.3 跨端竞态处理

**场景 1**：A 端（桌面）steer，B 端（手机）收到快照时当前轮已结束
- B 端调用 `fallbackSteerToQueue(sessionId)`，把 `delivery: 'steer'` 改成 `'queue'`
- 静默降级，不报错

**场景 2**：A 端 steer，B 端同时 preempt（停掉当前轮）
- B 端 preempt 时，调用 `clearSteer(sessionId)`，丢弃所有 pending steer inputs
- 发 `steer_discarded` 事件，reason: `'turn_cancelled'`

**场景 3**：会话 resume（进程重启 / 跨端接管）
- 所有 pending steer inputs 丢弃（不持久化）
- 发 `steer_discarded` 事件，reason: `'session_resumed'`

### 8.4 传输层（第二期实现）

第一版不实现传输层，模型先提供 `snapshot(sessionId)`；第二期补 `applySnapshot(sessionId, snapshot)`（按 id 去重合并）与变更监听。DOM 壳在每次模型变更后调 `renderMessageQueue()`，第二期在这里挂推送回调。

传输层可以是：
- WebSocket（实时同步）
- 轮询（简单但延迟高）
- WebRTC DataChannel（P2P，低延迟）

## 9. 已定决策（原开放问题）

1. **纯文本流式中如何注入？** 不在 HTTP 流内注入。等本轮以 `stop` 结束且有 pending steer 时，新建 assistant 占位 + 再发一次请求（§5.4）；不中断当前流，也不把纯文本流降级成抢占。
2. **steer 消息的 UI 位置？** 在 drain 时落进 `session.messages`，位于工具结果之后、新一轮 assistant 之前；纯文本收尾场景位于上一段回复之后、续轮回复之前。第 1 版不加徽章。
3. **多个 steer 如何注入？** FIFO 一次全部取出，每条独立生成一条 user 消息（与 ZCode 一致），不合并；单条请求消息更利于逐条追溯。
4. **steer 与 plan mode？** steer 只是本轮补充指示，不改变 `session.planMode`；工具集在 `startRound` 按当时的 planMode 重新计算，所以 steer 无法绕过写操作限制。
5. **steer 与子代理？** 只发给主代理；子代理的收件箱与开关不受影响（与现有 `stopSubAgentsOf` 的归属逻辑对齐）。

## 10. 其他开源 harness 深挖（2026-11-18）

> 浅克隆到 `D:\OraSkyC\Project\OpenSource\` 的 4 个项目，均为 2026-11-17 最新提交。
> 结论先行：**四者都有真正的 steer（不打断当前轮、在下一个 model request 边界注入），没有一个是纯排队**。
> 这进一步印证了本方案的 ZCode 路线（单队列 + delivery 标记）是业界主流。

### 10.1 四者横向对比

| 维度 | opencode | codex (Rust) | cline | pi |
|---|---|---|---|---|
| 队列结构 | durable `session_inbox` 表，delivery 字段 | turn-local `TurnInputQueue`（双层：提交队列 + pending） | 内存 `pendingPrompts[]`，delivery 字段 | 两个独立队列 `steeringQueue` / `followUpQueue` |
| delivery 语义 | `steer`/`queue`，**默认 steer** | 不分层，steer 直接进 pending | `steer`/`queue`（steer unshift / queue push） | `steer`/`followUp`（无 queue 概念） |
| 注入边界 | 每个 step 前 `advanceToStep`（不做内存 tool loop） | 两次 sampling 之间 `get_pending_input` | `prepareModelRequest` 里 `consumePendingUserMessage` | tool-call 批次完成后、下一请求前 |
| 流式输出中触发 | step 边界自然生效 | 入 pending，下轮 sampling 消费 | **abort 当前 model 请求**（tool 照常跑完） | 等当前批次 tool 全跑完再注入 |
| 持久化 | ✅ durable（pending-only 表 + 事件投影） | ❌ 内存（进程内） | ❌ 内存 | ❌ 内存（Pi Durable 另做持久化） |
| 跨端 | durable event log + move control（执行仍单进程） | expected_turn_id 乐观锁 + 客户端重试 | Hub state 快照 + stateVersion/epoch | Pi Durable 实验包支持多人 steer |
| 不可 steer 场景 | control item（compaction/move）当栅栏 | Review / Compact 显式拒绝 | aborting 状态 | streaming 时不带 behavior 直接报错 |
| 手势 | Mod+Enter steer | TUI Enter | CLI 空 Enter = steer 队首；VS Code 仅 queue | Enter=steer，Alt+Enter=followUp |

### 10.2 opencode：durable inbox + 边界提升（跨端最值得参考）

来源：`D:\OraSkyC\Project\OpenSource\opencode`

- **durable pending-only inbox**：`packages/core/src/database/migration/20260812181746_session_inbox.ts:9-24` 建 `session_inbox` 表，只存未消费工作；deliver 时同事务删行 + 插可见消息（`packages/core/src/session/inbox.ts:352-376`）。排序键 `enqueued_seq` 直接取 durable event 的 `durable.seq`（`projector.ts:1040`），`(session_id, enqueued_seq)` 唯一索引防重。
- **默认 steer**：`packages/core/src/session/session.ts:166` 等所有 admission 入口都是 `delivery: input.delivery ?? "steer"`。
- **两种边界范围**（`inbox.ts:53-57`）：`Promotable = "input" | "steer"`——step 边界只提升 steer，idle 边界 steer 优先、无 steer 才拉一个 queue。
- **注入点**：`packages/core/src/session/runner/llm.ts:81-214` 的 `advanceToStep`，每个 step 前重新查 inbox 并 promote；`AGENTS.md:218` 明确「每个 step 是一次显式 llm.stream，不做内存 tool loop」——这是插话能在边界注入的根本前提。
- **优先级栅栏**（`inbox.ts:561-625`）：steer 批量提升（止于 control），queue 单个提升；compaction/move 作为 control 栅栏，steered compaction 在 move 边界内提到最前，保证插话文本不被压缩进摘要。
- **改投/取消**（`inbox.ts:251-289`）：`InboxCancelled` / `InboxDeliveryChanged` durable event，per-session `KeyedMutex` 串行化（`inbox.ts:66-68`）。
- **跨端**：`move` item 携带 `Location.Ref + projectID` 实现会话跨 Location 迁移且插话不丢（`session-inbox.ts:37-42`、`llm.ts:107-116`）；doorbell 合并 wake 避免竞态（`run-coordinator.ts:139-146`）。

### 10.3 codex：乐观并发 + 不可 steer 分类（竞态处理最值得参考）

来源：`D:\OraSkyC\Project\OpenSource\codex`

- **协议**：`codex-rs/app-server-protocol/src/protocol/v2/turn.rs:323-363` 定义 `TurnSteerParams`（必填 `expected_turn_id` 乐观并发前置条件）与 `TurnSteerResponse`（返回既有 turn_id，不新建 turn）。
- **原子准入**（`codex-rs/core/src/session/turn_input.rs:985-1105`）：持 `active_turn` 锁完成「检查活跃 → 校验 expected_turn_id → 入队」，不匹配时把 actual id 回给客户端（`turn_processor.rs:1192-1198`），TUI 解析后**重同步重试一次**（`tui/.../user_message_submission.rs:254-260`）。
- **注入边界**（`codex-rs/core/src/session/turn.rs:535-560`）：入 pending 队列，两次 sampling 之间 `get_pending_input` 原子取出，落盘后 `clone_history()` 构造下一次请求（`:647-651`）。`needs_follow_up = model_needs_follow_up || has_pending_input`（`:718`）——pending 非空就继续下一轮。
- **不可 steer 分类**（`core/src/session/turn_input.rs:1041-1053`）：Review（独立子会话）与 Compact（重写上下文）显式返回 `ActiveTurnNotSteerable`，UI 收到后**排队到下一 turn 而非丢弃**。
- **条件中断**（`core/src/session/extension_interruption.rs:62-97`）：`InterruptIfNoPendingInput`——有 pending steer 时不误中断，体现「steer 优先于中断」。
- **上下文失效**：`analytics/src/facts.rs:219-230` 注释「steering can invalidate a root」——steer 带来的新元数据会让 turn 的因果 root 变模糊，解法是事件构造时**实时读取**元数据而非配置时快照。

### 10.4 cline：只 abort 模型请求 + 原子 promote（工具原子性最值得参考）

来源：`D:\OraSkyC\Project\OpenSource\cline`（SDK 化版本）

- **只中止当前 model 请求**：`sdk/packages/agents/src/agent-runtime.ts:645-648` 的 `notifyPendingUserMessage()` 调 `modelSteerController.abort()`——注释明确「Interrupt only the current model request; running tools finish normally」。比 abort 整轮更细腻：正在跑的 tool 正常完成，下一个 request 才带新指令，避免半截 tool call。
- **注入点**：`agent-runtime.ts:1702-1710`（`prepareModelRequest` 内）`consumePendingUserMessage()`，天然覆盖重试/continuation/tool 后下一请求。测试 `agent-runtime.test.ts:2285-2357` 断言消息序 `user, assistant, tool, user, assistant`。
- **队列**：`sdk/packages/core/src/runtime/turn-queue/pending-prompt-service.ts:14-26`，steer `unshift` 队首、queue `push` 队尾（`:155-171`）；纯内存不持久化（`:1103-1104`）。
- **原子 promote**：`pending-prompt-service.ts:216-225` 的 `steerFirst` 在一次同步 core 操作内「选队首 + 改 delivery」，避免多客户端基于过期快照提升错消息（`sdk/ARCHITECTURE.md:1306-1312`）。
- **abort 差异化语义**（`local-runtime-host.ts:1369-1398`）：用户停止「当前轮」→ 队列保留，稍后 drain；停止「队列消费中的轮」→ 丢弃剩余队列（否则每次 Escape 都会吃掉一条队列项）。
- **UI 暴露不对称**：VS Code webview 只做 queue（`sdk-followup-coordinator.ts:155-162` 硬编码 `"queue"`），显式 steer 手势在 CLI（空 Enter）与 Desktop（`steerFirst`）。

### 10.5 pi：tool 边界原子性 + Pi Durable 跨端（极简但完整）

来源：`D:\OraSkyC\Project\OpenSource\pi`

- **双队列**：`packages/agent/src/agent.ts:308-315` 的 `steer()` / `followUp()`，语义见 `types.ts:282-306`——steer 在「当前 assistant 消息的 tool call 全部执行完后」注入，**不跳过任何 tool**（v0.58.4 修正，`CHANGELOG.md:531`）。
- **取舍哲学**：工具执行原子性 > 插话即时性（`agent-loop.ts:272-287, 295-307`）；streaming 时 `prompt()` 不带 `streamingBehavior` 直接报错，不猜意图（`agent-session.ts:2241-2247`）。
- **drain 模式**：`one-at-a-time`（默认）/ `all`（`agent.ts:149-174`），补轮询要防一轮送两条（`agent-loop.ts:210-215`）。
- **UI 镜像 + 撤回**：`_steeringMessages` / `_followUpMessages` 仅用于显示，`clearQueue()` 把排队文本还原到输入框（`agent-session.ts:425-430, 2584-2592`）；键位 Enter=steer、Alt+Enter(Win: Ctrl+Q)=followUp、Alt+Up 撤回。
- **Pi Durable**（实验包 `packages/durable/`，博客 https://earendil.com/posts/pi-durable/）：durable inbox 是对话的持久化文档（`inbox.ts:12-30`），`applyBoundary(postTools/final)` + `requestId` exactly-once + `whenBusy/whenIdle` 四态（`:74-105`、`README.md:634-660`），支持「多人 steer 同一 run」——**这是目前最完整的跨端/持久化 steer 开源参考**。

### 10.6 对本方案的修订建议

综合四者，本方案（ZCode 路线）整体成立，但建议吸收以下设计：

1. **注入边界对齐 pi / cline**：明确「一个 tool batch 的 `Promise.all` 完成后、下一轮 `startRound` 前 drain」（本方案 §4.3 已是此语义，补充「不跳过正在执行的 tool」的契约）。
2. **不可 steer 场景显式化**（借鉴 codex）：plan mode 提交、compact、review 等原子操作期间，`delivery: 'steer'` 自动降级为 `'queue'`（本方案 §4.5 的静默降级已覆盖，补充一份「不可 steer 状态清单」）。
3. **原子 promote**（借鉴 cline `steerFirst`）：队列行「插话」按钮改为「把该条 item 的 delivery 改成 steer」，在一次同步操作内完成，避免多窗口/异步竞态。
4. **abort 差异化**（借鉴 cline）：用户按停止时区分「停当前轮（保留 pending steer）」与「停队列消费（丢弃 pending）」——本方案 preempt 手势要定义清楚对 pending steer 的处理。
5. **跨端第二期直接参考 opencode / Pi Durable**：durable pending-only inbox + 事件投影 + 幂等 id + boundary 选择，比本方案 §8 的朴素快照更成熟，第二期设计时应优先对标。

## 11. 参考资料

- DeepSeek harness: `.agents/notes/archived/feature/2026-07-30-web-queue-steer-action.md`
- DeepSeek harness: `packages/api/session-controller/src/commands.ts:483-518`
- ZCode: `apps/zcode-cli/docs/design/v2/loop/turn-steering.md`
- ZCode: `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`
- DataLens 现有实现: `frontend/src/ai/ai-message-queue.js:144`（`interjectComposerMessage`）、`ai-message-queue.js:89`（队列行按钮）、`ai-message-queue.js:173`（`flushMessageQueue`）
- DataLens 工具循环: `frontend/src/ai/ai-panel.js:10400`（`startRound`）、`ai-panel.js:10729`（`handleToolRound`）、`ai-panel.js:11299`（`ai-done`）、`ai-panel.js:10649`（`finishStream`）、`ai-panel.js:11416`（`stopGeneration`）
- DataLens 输入区: `frontend/src/ai/ai-composer.js:511`（生成中键处理）、`ai-composer.js:534`（`captureComposerMessage`，item 形状）
- 后端协议适配: `internal/aitransport/http.go:874`（Anthropic 连续同角色合并）
- opencode（本地浅克隆）: `D:\OraSkyC\Project\OpenSource\opencode\AGENTS.md:214-222`、`packages/core/src/session/inbox.ts:561-625`、`packages/core/src/session/runner/llm.ts:81-214`、`packages/schema/src/session-inbox.ts:11`
- codex（本地浅克隆）: `D:\OraSkyC\Project\OpenSource\codex\codex-rs\app-server-protocol\src\protocol\v2\turn.rs:323-363`、`codex-rs\core\src\session\turn_input.rs:985-1105`、`codex-rs\core\src\session\turn.rs:535-560`
- cline（本地浅克隆）: `D:\OraSkyC\Project\OpenSource\cline\sdk\packages\agents\src\agent-runtime.ts:645-648,1702-1710`、`sdk\packages\core\src\runtime\turn-queue\pending-prompt-service.ts:14-26,216-225`
- pi（本地浅克隆）: `D:\OraSkyC\Project\OpenSource\pi\packages\agent\src\agent.ts:308-315`、`packages\agent\src\types.ts:282-306`、`packages\durable\src\harness\inbox.ts:12-30,74-105`

## 12. 实施步骤

1. **队列模型**：抽出 `createQueueModel()` 并让 DOM 壳转发；补 6.1 单测并登记 `npm test`
2. **手势**：`ai-composer.js` 生成中分支改为三手势；`ai-message-queue.js` 的 `interjectComposerMessage` 改为 steer；新增 `preemptComposerMessage`
3. **注入**：`startRound` drain（落盘 + 模板 + 预算降级）；`buildApiMessages` 包模板
4. **续轮与兜底**：`ai-done` stop + pending steer 新建 assistant 续轮；`finishStream` fallback / clear；`stopGeneration` clear
5. **UI**：队列行改投「插话 / 排队」与 badge；输入区提示三处同步
6. **回归**：现有排队（Enter）与 preempt（Ctrl+Shift+Enter）行为不变；跑改动面测试 + `npm run build`

验收标准：E2E 六条全部通过；`npm test` 与 `npm run build` 退出码为 0；会话 JSONL 里能看到带 `steer: true` 的用户消息。

## 13. 实施记录（2026-11-17）

按 §12 全部落地：`createQueueModel()`（纯模型，字符串 id）+ DOM 壳；`ai-composer.js` 三手势；`startRound` 第 2 次及以后请求前 drain（原文落盘 + 请求包 `user_steer` 模板 + 90% 窗口回滚）；`ai-done` 新建 assistant 续轮；`finishStream` fallback / `stopGeneration` clear；队列行按 delivery 改投与 badge；输入区提示、按钮 tooltip 与设置页「发送快捷键」文案同步。前端全量测试（1130 例）与 `npm run build` 均通过。

与方案正文的偏差 / 补充（实现时确认的细节）：

1. **Ctrl+Shift+点击发送也映射抢占**（正文只写了键盘手势）：与 Ctrl+Shift+Enter 同路，避免用户按住 Ctrl+Shift 点按钮时误走插话。
2. **ai-done 续轮分支放在空回复兜底之后**（正文写「之间」）：空回复重试本身会调 `startRound`，也会 drain pending steer；放在兜底之后避免把空 assistant 留在历史里。
3. **drain 回滚用模型 `restoreItems(list, 'queue')`**：drain 已把条目移出队列，回滚按**入队时间顺序**放回同会话队列项之间（保持 FIFO，不插队），并改投 queue。
4. **附件白名单按 `kind` 判定**：除 `image` / `video` / `message_quote`（常量取自 `ai-quote.js`）外的附件（`file` / `skill` / `selection`）都降级排队——引用 markup 在 drain 时用 `quoteMarkupFromAttachments` 拼进 content，与 `submitText` 同一口径。纯图片 / 纯视频插话补正文占位「（附图）」，否则模板会被跳过。
5. **`steer` 标记不进轮次口径**：`buildApiMessages` 的「保留最近 2 轮原文」、`turnStartAt`、`lastUserIndex`（重新生成 / 编辑重发）、`isTurnBoundaryMessage`（回合分组 / 列表排序键 / 渲染窗口）、上下文统计的轮数、`ai-usage-ui` 的轮数、结构面板的轮号全部跳过 steer，避免补充指示被当成用户发起的新回合。
6. **重放一致性**：`normalizeMessage` 保留 `raw.steer === true`——否则重启 / 懒加载补正文后历史 steer 不再包模板，且后续 truncate 重写会把磁盘标记抹掉。
7. **停止 / 收尾窗口降级**：`stopGeneration` 后最多 1.2s 内 `streams` 仍登记着已停止的流，此时插话会被 `finishStream` 的 `clearSteer` 丢弃。插话手势与队列行按钮都先看 `liveSteerableStream()`（`stopped` / `finished` 即视为窗口关闭），降级为排队并登记 `interjectPending`，由收尾冲刷；抢占手势在已停止时不再重复 `stopGeneration`。
8. **视频插话复用发送预检**：含 `kind: 'video'` 的插话必须通过 `modelVideoInputEnabled(profile, entry)`（与 `startSessionTurn` 的 `video_protocol` 同源），否则降级排队——避免在历史里留下一条每轮请求都被拒收的视频消息。
9. **队列行重绘**：drain 与预算回滚后各调一次 `renderMessageQueue()`（方案 §8.4 的「模型变更后重绘」），否则界面残留幽灵「插话」行。
10. **所有权 API 收敛**：`pushItem/unshiftItem` 合并为 `enqueueItem`（全仓无其它消费方），`snapshot` 用 `structuredClone` 做完整深拷贝（含附件嵌套对象）。
11. **护栏**：`test/ai/ai-message-queue.test.mjs`（模型边界 / 壳清理 / 深拷贝）与 `test/ai/ai-turn-steer-wiring.test.mjs`（源码接线 + 文案合同 + 运行时导出检查）；两者均登记进 `npm test`。
12. **队列行 ⚡ 抢占按钮（2026-11-18 按用户要求补）**：原方案 §4.6 说不加抢占按钮，但实际使用中队列行没有点击抢占的入口。现补 `preemptQueuedItem(item)`：改投 queue → 移到队首 → `interjectPending` → `stopGeneration()`（停止收尾窗口内不再重复停轮，直接等 `finishStream` 冲刷）；仅当前轮活着时显示，避免空闲队列出现误导性按钮。
13. **队列行拖动排序（2026-11-18 按用户要求补）**：行首 3×3 点阵手柄（新增 `grip` 图标）+ HTML5 DnD；`reorderSession` 按给定 id 顺序只重排目标会话的槽位，未知 id 忽略、漏掉的条目按原顺序补末尾（不丢消息）；落点用 `drop-before` / `drop-after` 内阴影提示，拖动中源行半透明。

