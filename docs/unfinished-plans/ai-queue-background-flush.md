# 后台会话的排队消息不会自动续跑（评估稿）

> 状态：**评估稿，未立项未实施**（2026-11-19 成文）
> 来源：排查「`currentSession()` 串会话」时的同源发现——队列消费入口把「UI 代发」当成了唯一通路。
> 性质：只读评估。行号按 2026-11-19 工作区实测；同批只做了一处无争议清理（`ai-subagents.parentSessionOfSub` 的 `currentSession()` 兜底已删，见 §7）。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 现象 | 会话 A 在后台生成、用户切到 B；A 的排队消息（含插话/抢占降级）在 A 本轮结束后**不会发出**，直到用户切回 A |
| 根因 | `flushMessageQueue(sessionId)` 里有 `session.id !== sessionId → return`（`ai-message-queue.js:582-583`），把「只能 UI 代发」写成了唯一通路 |
| 消息会丢吗 | **不会**。队列在内存里，切回该会话时 `switchSession` 的 `setTimeout(() => flushMessageQueue(id), 0)`（`ai-panel.js:13605`）会补发 |
| 真实损失 | 语义承诺落空（"本轮结束后发送"）；用户以为已发出；多条排队积压；抢占降级后没打断 |
| 可行性 | **高**。`startSessionTurn` 已是纯内核（`ai-panel.js:10738`），后台起轮已有成熟先例（`wakeWith`，`ai-agent-notices.js:214`） |
| 建议 | 方案 A：把 flush 的"取项"与"发项"拆开，后台会话走内核起轮。半天 + 测试 |
| 优先级 | 中。不做不丢数据，但会反复收到"消息怎么没发出去"的体感投诉 |

## 1. 现状机制

排队消息的一生分三段：**入队 → 消费 → 早退**。

### 1.1 入队（按会话分区）

| 入口 | 位置 | 说明 |
|---|---|---|
| `enqueueComposerMessage` | `ai-message-queue.js:442` | 生成中按 Enter → 排队 |
| `interjectComposerMessage` | `ai-message-queue.js:459` | Ctrl+Enter 插话；压缩中 / 不可 steer 时**静默降级为排队** |
| `preemptComposerMessage` | `ai-message-queue.js:515` | Ctrl+Shift+Enter 抢占；停止窗口内降级为队首排队 |

条目形状（`ai-composer.js:557` 的 `captureComposerMessage`）：`{id, ts, delivery, sessionId, text, attachments[]}`，存进 `model.forSession(sessionId)` —— **数据本身已经按会话隔离**。

### 1.2 消费：唯一入口是 UI 代发

`flushMessageQueue(sessionId)`（`ai-message-queue.js:580`）是唯一把队列项变成请求的地方，但它做的是"把内容灌回输入区再发"：

```js
// ai-message-queue.js:580-604（现状，节选）
async function flushMessageQueue(sessionId) {
    if (!sessionId || streams.has(sessionId) || compactOf(sessionId)) return;
    const session = currentSession();
    if (!session || session.id !== sessionId || session.archivedAt) return;   // ← 早退闸门
    if (currentPendingAskEntry() || planApprovalMessage(session)) return;
    const item = model.forSession(sessionId)[0];
    if (!item) return;
    if ((el.input && el.input.value.trim()) || getAttachments().length) return; // 保护草稿
    ...
    setAttachments((item.attachments || []).map((att) => ({...att})));          // 写 UI
    if (el.input) el.input.value = item.text || '';                             // 写 UI
    const ok = await submitText(item.text || '', null, {preserveScroll: true}); // 内部又用 currentSession()
    ...
}
```

三重依赖把它绑死在"当前查看的会话"上：`currentSession()` 判定、`el.input` 草稿保护、`submitText` 自己再取一次 `currentSession()`。

### 1.3 调用点盘点

| 位置 | 场景 | 后台会话时的结果 |
|---|---|---|
| `ai-panel.js:11457` `finishStream` 里 `flushMessageQueue(session.id)` | 该会话轮末冲刷**自己的**队列 | **早退（死调用）** |
| `ai-panel.js:11459` 同上，`flushMessageQueue(viewing.id)` | 前台会话轮末顺带冲刷自己的队列 | 正常（与上一行重复，先成功的那个清空后另一个自然 return） |
| `ai-panel.js:14377` `finishCompact` 末尾 | 压缩结束冲刷 | 后台压缩时**早退（死调用）** |
| `ai-panel.js:13605` `switchSession` | 切回该会话 | 正常——**目前唯一有效的补发时机** |
| `ai-message-queue.js:385` 队列卡片「插话」按钮 | 卡片只画当前会话 | 正常 |
| `ai-message-queue.js:478 / 534 / 577` composer 三手势的空闲分支 | 发起者一定是当前会话 | 正常 |

注意 `finishStream` 那段还写了另一半：

```js
if (shouldFlush) {
    if (session) flushMessageQueue(session.id);                                  // 意图：发后台会话自己的
    const viewing = currentSession();
    if (viewing && (!session || viewing.id !== session.id)) flushMessageQueue(viewing.id); // 意图：顺带发前台的
}
```

第一行的注释与意图都很明确（作者想让后台会话续跑），实现却被守卫挡掉——**这是"意图对、实现死"的典型**，不是设计取舍。

## 2. 为什么一直没被当 bug

1. 切回会话会补发（`13605`），用户看到的是"慢半拍"而不是"丢了"；
2. 会话列表有未读角标（`finishStream` 的 `setSessionUnread`），至少不会完全无感；
3. 单会话单任务的使用习惯下几乎不触发——要有"切走 + 留了排队消息 + 后台跑完"三个条件叠加。

## 3. 真正的损失（按严重度）

1. **语义破坏**：排队 = "本轮结束后自动发"。后台会话本轮结束了却不动，这个承诺失效；抢占降级更糟——用户以为打断了，实际只是排到了队首。
2. **体感故障**：用户按 Enter 后切去做别的事，回来发现在队列里躺着，且没有任何提示说"没发出去"。
3. **积压放大**：现有设计一次只发一条（每轮 `finishStream` 一次），后台不冲刷 → N 条排队要切回后连续触发 N 轮才发完。
4. 不涉及跨窗口：队列只在发起窗口的内存里（`model` 是模块级 Map），多实例不会互相看到对方的队列。

## 4. 方案

### 4.1 方案 A：后台走内核起轮（推荐）

把 `flushMessageQueue` 拆成"取项"与"发项"两步，发项按会话分两条路：

```js
// 取项：只做守卫，不碰 UI
function takeQueuedItem(sessionId) {
    if (!sessionId || streams.has(sessionId) || compactOf(sessionId)) return null;
    const session = sessionById(sessionId);
    if (!session || session.archivedAt) return null;
    if (currentPendingAskEntry(sessionId) || planApprovalMessage(session)) return null;
    const item = model.forSession(sessionId)[0];
    if (!item) return null;
    // 输入区草稿保护只对"当前会话"有意义（后台会话没有输入区）
    if (session.id === currentSession()?.id &&
        ((el.input && el.input.value.trim()) || getAttachments().length)) return null;
    model.remove(item);
    renderMessageQueue();
    return item;
}

// 发项：当前会话走 UI（看得见地发），后台会话走内核（不碰 UI）
async function dispatchQueuedItem(session, item) {
    if (session.id === currentSession()?.id) {
        setAttachments((item.attachments || []).map((att) => ({...att})));
        if (el.input) el.input.value = item.text || '';
        const ok = await submitText(item.text || '', null, {preserveScroll: true});
        if (!ok) restoreItemAtHead(session, item);   // 现有回退逻辑搬过来
        return;
    }
    const result = await startSessionTurn(session, item.text || '', {
        attachments: mapQueueAttachments(item.attachments),   // 与 submitText 同一口径（images / videos / texts）
        allowPendingEdit: false,
        truncateAt: null,
        preserveScroll: true,
    });
    if (!result.ok) restoreItemAtHead(session, item);          // 失败不丢：放回队首 + 未读 + 桌面通知
}
```

失败回退直接照抄 `wakeWith` 的成熟分支（`ai-agent-notices.js:228-245`）：回队首、`setSessionUnread(session, 'done')`、`notifyDesktop({kind:'error', …})`，并把 `over_budget` 单独给人话（"上下文已超阈，排队消息暂存在队列"）。

**为什么这是低风险**：`startSessionTurn` 已经是纯内核（`session` 参数一路用到底，预算预检 / 租约 / 权限档 / 计划模式全在内部），后台起轮有 `wakeWith` 这个跑了很久的先例；差别只是内容来自队列而不是信箱。

### 4.2 方案 B：彻底解耦

把 `dispatchQueuedItem` 做成队列模块的对外 API，UI 与后台共用；`flushMessageQueue` 退化为薄壳。改动面更大（队列模块要注入 `submitText` / `startSessionTurn` / 会话查询，4 个调用点全要跟着改），收益是"以后加第三条发送路径不用再拆一次"。

### 4.3 方案 C：不做，只加可见性

- 会话列表给"有待发消息"的会话加徽标（`model.hasItems(sessionId)` 已有现成 API，`ai-session-list.js` 只需读它）；
- 后台 `finishStream` 且 `hasItems` 时打一条未读 + 一条消息中心记录（"排队消息未发出：切回后继续"）。

成本约 0.1 天，语义问题不解决，但把"静默"变成"可见"。

### 4.4 对比

| 维度 | A | B | C |
|---|---|---|---|
| 解决语义 | 是 | 是 | 否 |
| 改动面 | `ai-message-queue.js` 一个函数拆两段 + 两处死调用变活 | 队列模块 API + 4 调用点 | 列表 UI + 一条通知 |
| 风险 | 低（复用 `wakeWith` 模式） | 中（跨模块依赖注入） | 极低 |
| 估计 | 0.5 天 + 测试 | 1–1.5 天 | 0.1 天 |
| 建议 | **先做 A**；B 作为后续重构，等第三条发送路径出现时再提 | | C 可与 A 叠加（徽标本身有用） |

## 5. 风险与不变量

| 项 | 处理 |
|---|---|
| 后台自动发送 = 真烧 token | 排队本来就是用户按了发送；与 `wakeWith` 同性质。可选加设置项（§6-1） |
| 上下文超阈 | `startSessionTurn` 的预算预检会返回 `over_budget`；**必须**回队首而不是丢弃，并给可见提示 |
| 权限档 / 计划模式 | 全部由 `startSessionTurn` 按 `session.scope` / `session.planMode` 处理，与手动发送一致；不做任何"后台降档" |
| 待回答 / 计划待批准 | `takeQueuedItem` 保留 `currentPendingAskEntry(sessionId)` 与 `planApprovalMessage(session)` 守卫，有卡就不发 |
| 跨窗口写权 | `startSessionTurn` 内部取租约，失败返回 `lease_failed` / `other_window`；按普通失败回队，等下次轮末再试 |
| 顺序 | 维持"一轮一条"：一次 `finishStream` 只发队首一条，下一条等这一轮结束。不要在 flush 里循环（会与 `anyStreaming` 打架） |
| steer 残留 | `finishStream` 已做 `fallbackSteerToQueue`，残留项以 `delivery:'queue'` 正常发出 |
| 滚动位置 | 后台路径必须 `preserveScroll: true`，且任何 `renderMessages` / `setStreamingUI` 调用都要 `isViewed` 守卫（不要在后台路径刷前台 UI——与 2026-11-19 计划模式串台同一类错误） |

## 6. 开放问题

1. **要不要开关**？"后台会话的排队消息自动发送"（默认开 / 默认关）。默认关会让 A 方案退化成 C。
2. **多条排队要不要连发**？现在"一轮一条"，3 条排队 = 3 轮往返。连发需要在 `finishStream` 后循环 dispatch，与自动压缩 / notice 唤醒会抢同一会话，得排优先级。
3. **后台发出后要不要提示**？建议 `notifyDesktop` 一条轻量记录（`kind:'success'`，`completion:true` 不刷消息中心），或只在会话行显示"已发 N 条"。

## 7. 同批已清理（无争议）

`ai-subagents.parentSessionOfSub`（`ai-subagents.js:602`）原本在父会话与根会话都查不到时兜底 `currentSession()`，会把子代理的结算/记录挂到用户正看着的另一个对话上。父与根都没了，这条子代理也没有归宿，改为返回 `null`（三处调用点只把它喂给 `profileOf` / `entryOf`，二者对 `null` 安全，回落窗口默认模型）。

## 8. 测试建议

- **纯函数**：`takeQueuedItem` 的守卫矩阵（busy / compacting / archived / ask / plan / 非当前会话带草稿）各一条。
- **源码守卫**：`finishStream` 的 `flushMessageQueue(session.id)` 不得再是死调用——断言 `flushMessageQueue` 内不存在"目标不是当前会话就 return"的唯一通路，或断言存在后台分支（本仓库惯例：接线用源码断言兜住静默退化，见 `ai-tool-wiring.test.mjs`）。
- **手测**：A 会话长任务运行中切到 B，在 B 里给 A 留 2 条排队消息 → A 结束后逐条发出（切回 A 可见两条用户消息与两条 AI 回复），B 的输入框与滚动不受影响。
