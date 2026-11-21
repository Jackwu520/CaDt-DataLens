# 中断式交互卡片（ask_user / 审批 / envAsk）跨应用重启的恢复

> 状态：**已结项（2026-11-22）：A 已实施，B 评估后不做**
> **A（已做）**：把重启降级做完整——挂起卡片的工具结果正文整句换成 `ASK_LOST_TEXT` / `APPROVAL_LOST_TEXT` / `ENV_ASK_LOST_TEXT`（答案未知 / 未执行 / 未创建），卡片文案改口径。见 §12 实施记录。
> **B（不做）**：「让 AI 重新问一次」按钮（§5.2-5.4 保留为实施手册，需要时照做）。理由见 §4.2——与横幅「继续回合」是同一条通路，A 之后模型已知道答案未知，脆弱窗口受 ask 超时约束，误判代价只是让用户打一句话。
> 来源：实测提问——「审批过程中程序退出重开就没了」「ask_user 询问过程中重启，AI 不知道用户选没选，用户也不知道 AI 给了哪些卡片」。
> 定位：**只解决中断式卡片的重启续跑**。计划审批（`submit_plan`）经查已经完整持久化，不在问题范围（见 §1.1）。
> **路线变更**：2026-11-21 原定 deepseek 中间路线 A′（ask 恢复成可补答表单）。2026-11-22 复核发现同日 19:42 的 `66aead4` 已交付「中断横幅 + 一键续跑」，A′ 的投递层那一半不再有独占价值，且与四处既有守卫冲突（§4.1）；改选 **B′——卡片保留终态，但把「没收到你的回答」说清楚**。B′ 随后拆成两半：A（正文改写）立即实施，B（重新问一次按钮）同日评估不做（§4.2）。
> 行号以 2026-11-22 工作区实测为准（`ai-panel.js` 19028 行、`ai-tool-cards.js` 1907 行）；本仓库有并行会话在改 `ai-panel.js`，实施时按符号定位，不要按行号跳转。

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 计划审批会丢吗 | **不会**。`activePlan` 随会话落盘，审批卡从它派生，重开即复原（§1.1） |
| 审批 / envAsk 重启后会怎样 | 卡片收敛为取消终态 + **中断横幅 + 「继续回合」一键续跑**（2026-11-21 已交付，§2.4）。双方都能知道「决定没收到、操作未执行」 |
| ask_user 重启后会怎样 | 卡片灰掉、用户没有作答入口；模型侧更糟——读到一条**内容为「等待用户回答…」的完成态工具结果**（模型侧这一半已由 A 修掉；用户侧入口按 §4.2 不做） |
| 根因 | 等待载体是纯内存（`Promise` + `pendingAsks`），进程退出即无 resolve 可接；但卡片数据本身已在磁盘上 |
| 建议 | **拆成两半**：A = 重放时把模型可见正文整句换掉（**已实施**，约 10 行）；B = `expired` 卡片挂「让 AI 重新问一次」按钮（**评估后不做**，见 §4.2） |
| 优先级 | A **必修**（这是「占位正文被当成结果」的错误陈述，不是新功能）；B **不做**（四家竞品都不做卡片复活，且它与横幅续跑功能重叠） |
| 业界对齐 | 四家竞品无一实现「卡片复活 + 原 turn 原地继续」；「补答/重问走新输入」是通行做法（§9） |

## 1. 问题：三类卡片，一个假问题、一个已解决、一个仍缺

### 1.1 计划审批（`submit_plan`）是假问题——已经持久化

证据不变（行号已按当前工作区校正）：

- 提交即落盘：`ai-panel.js` 写 `session.activePlan`（`status:'pending'` + 完整 `markdown` + `ts`），紧跟 `persistSessions()`；
- 会话真源编码：`ai-session-store.js` 的 `planMode` / `activePlan` 都进会话 JSONL；
- 审批卡派生：`ai-takeover.js` 的 `planApprovalMessage()` 从 `session.activePlan` 读，不依赖任何内存态；
- 压缩也不丢：`ai-plan-file.js` 的 `planReferenceBlock` 在压缩后把完整计划回注。

唯一内存态是「继续规划」后收起卡片的标记，重启归零 = 审批卡重新出现，正是期望行为。**无需改动。**

### 1.2 审批 / envAsk：横幅已覆盖（2026-11-21 交付）

`66aead4`（CHANGELOG:283-284）实现：起轮时 `meta.turnInFlight` 落盘（`ai-panel.js:12244`），正常收尾清除（`:12828`）；只有「进程死了没走收尾」才残留。下次读盘在消息流底部挂**中断横幅**（`:4303` 挂载、`:4358` 检测与清除、`:4372` 渲染、`:4401` 续跑），点「继续回合」以 `AI_INTERRUPT_RESUME_PROMPT`（`:4355`，「从中断处继续，不要重复已完成的工作」）起新轮。

所以 pending 审批被杀后重开，用户和模型都拿得到「重启了、决定没收到、别重复」的信息——原方案 §5.2「路径 2」想做的事已经在跑，且比原设计更好（用户显式触发，不在后台自动起轮）。

**只剩一处文案要改**：`ai-panel.js:1774` / `:1795` 的「审批已取消（会话重新加载）」「变量创建已取消（会话重新加载）」改为明确「应用重启时没收到你的决定，该操作未执行」。模型靠这句话判断副作用，值得写死。

### 1.3 ask_user 是真缺口

`ask_user` 发起后暂停本轮等回答。重启后：

- 卡片 `pending → expired`（`ai-panel.js:1779`），标签「已过期」，正文「页面已关闭，问题未回答」（`ai-tool-cards.js:518`），没有任何作答入口；
- 模型侧更糟：工具消息 `status` 被收成 `done`（`:1781`），但正文只在**为空时**才替换（`:1783` 的 `if (!message.content)`）——`runAskQuestion` 早已写入占位正文「等待用户回答…」（`:8706`），于是**模型读到的是一条内容为「等待用户回答…」的已完成工具结果**；
- 用户点横幅「继续回合」后，模型面对这句「等待用户回答…」+「从中断处继续」，最常见的反应是**按最合理的猜测继续跑**，而不是重新问。

即：数据没丢，丢的是「用户的作答权」和「模型对答案来源的诚实」。

## 2. 现状机制（代码级证据）

### 2.1 卡片数据已经落盘

`ai-session-store.js:52-57` 的消息指纹注释处理了「落盘后就地改写」的情形，指纹覆盖 `approval.state/source/remember`、`ask.state/source/answer`、`envAsk.state`——即 `questions/options/approval` 详情随工具消息进 JSONL，重开能读回。所以缺的从来不是数据。

### 2.2 等待回答的执行流是纯内存

| 卡片 | 等待载体 | 位置（当前行号） |
|---|---|---|
| ask_user | `new Promise` + `pendingAsks` Map | `ai-panel.js:866`（表）、`:8712`（Promise）、`:8715`（登记） |
| 写/命令/动作审批 | `pendingApprovals` Map + `resolve` | `ai-panel.js:860`（表）、`:7412`（Promise） |
| envAsk | `pendingEnvCreations` Map | `ai-panel.js:867`（表）、`:8340`（登记）、`:8346`（Promise） |
| 挂起的生成流 | `stream` / `streams` Map | `startSessionTurn` 内核 `:11964` |

`resolve` 与 `stream` 无法序列化，进程退出即永久消失。

### 2.3 重放强制降级（当前行号）

| 行 | 条件 | 重启后动作 |
|---|---|---|
| `:1768-1776` | `approval.state === 'pending'` | → `cancelled`，正文「审批已取消（会话重新加载）」 |
| `:1778-1788` | `ask.state === 'pending'` | → `expired`，正文**仅在为空时**改成「用户未回答（页面已关闭）」 |
| `:1790-1796` | `envAsk.state === 'pending'` | → `cancelled`，正文「变量创建已取消（会话重新加载）」 |
| `:1799-1806` | 工具消息 `running/pending` | → `error` + `interrupted`，正文 `TOOL_INTERRUPTED_TEXT`（`ai-constants.js:14`） |
| `:1821` | 子代理 `running` | → `stopped` |
| `:1839` | 生成任务 `running` | → `failed` |
| `:1861` | assistant `streaming` | → `stopped` |

**关键事实**：`ask.state = 'expired'` 在全仓只有一个写入点——`:1779`（`:1607` 是合法值白名单，`ai-tool-cards.js:518` 是读文案）。因此 **`expired` 天然等价于「重启遗留」**，B′ 不需要任何新标记。

### 2.4 中断横幅已交付

见 §1.2。与本方案的关系：横幅是**通用的「这轮断了」**，B′ 的按钮是**针对这张 ask 卡的「重新问一次」**；两者并存，点按钮时顺手收掉横幅（`session._interruptNotice = false`，参考 `:4404`）。

## 3. 根因

1. **投递层缺失**：没有「重启后把答案喂回 AI」的通路——原通路是 `settleAsk` 里的 `entry.resolve(result)` 唤醒挂起的流，流没了这条路就断了；
2. **恢复层只能降级**：因为 (1) 无解，重放必须把 pending 打成终态，否则界面出现「永远点不动的卡」。

B′ 的判断：**不重建投递层，改用「让模型重新发起一次提问」这条已有通路**——`startSessionTurn` 起新轮是成熟内核（后台队列、定时任务、会话投递都走它），重问得到的是全新的活卡片，用户自然能答。

## 4. 方案对比

| 方案 | 做法 | 解决痛点 | 改动量 | 风险 | 业界 |
|---|---|---|---|---|---|
| **B′（选定）** | 重放改写模型可见正文 + `expired` 卡挂「让 AI 重新问一次」按钮 → 注入提词起新轮 | ✅ 用户重新获得作答权；模型不再瞎猜 | 小（~250 行含测试） | 低：不碰任何既有 Map / 守卫；代价是多花一轮 | 四家「补答走新轮」的轻量版 |
| A′（11-21 原定） | ask 恢复为可补答表单，补答注入新轮 | ✅ 答案直接落回原卡，不多花一轮 | 中偏大 | 中高：见 §4.1 四条落地障碍 | deepseek `continued` 投影 |
| B（11-21 版） | 退出前结算 pending 卡 + 汇总提示 | ⚠️ 只做到双方知情 | 小 | 低 | codex |
| C | 持久化整个执行流做进程级续跑 | ✅ | 极大 | 高 | 无 |

### 4.1 为什么放弃 A′（四条落地障碍，升级前必须先解决）

1. **模型可见的 tool_result 无处安放**：若保留 `ask.state='pending'` 又「豁免中断标记」，请求组装（`:6026-6051`、`:6090-6099`）只跳过 `status==='running'`，`pending` 会被当成**已完成的工具结果**发给模型，内容仍是「等待用户回答…」。必须像 deepseek 那样把「UI 状态」与「模型可见文本」拆成两层，原方案没写。
2. **`settleAsk` 会回写历史正文**：`:8475-8476` 结算时把 `toolMessage.content` 改成「用户回答：…」。恢复卡补答若复用这条路，等于在用户可能已发过几条新消息之后回头改写历史工具结果，违背横幅那段注释坚持的「JSONL 历史保持追加式真源」，还会和注入消息重复。
3. **`_recoveredPending` 存不下来**：`ai-session-store.js:175` 把 `_` 前缀字段整体跳过；读盘带 `_recovered` 的消息又触发 `_needsRewrite`（`ai-session-disk.js:545`）整份重写，标记随即消失。判定只能派生自 `ask.state`。
4. **`pendingAsks` 一旦被塞进恢复卡，四处守卫同时被钉住**：`maybeAutoCompact`（`:16450`）永不触发、队列冲刷（`ai-message-queue.js:746`）永久卡住、`toolMessageWaiting`（`:4466`）让回合折叠条永远显示「未完成」、用户停止生成时 `cancelPendingAsks`（`:13755`）会把恢复卡一起判死。要绕开只能做「懒注册 + 全链路豁免」，复杂度远超收益。

> 「接回合租约」这条不需要单独做：`startSessionTurn` 在 `:12065` 自己 `AISessionLeaseAcquire`，失败即返回「另一窗口正在运行」（原方案 §5.3 的顾虑是免费的）。

### 4.2 为什么也不做 B（2026-11-22 定）

1. **和「继续回合」是同一条通路**：两者都走 `startSessionTurn` 起新轮，差别只在注入文本——B 说「把原问题原样重问」，横幅说的是 `AI_INTERRUPT_RESUME_PROMPT`（`ai-panel.js:4372`，「从中断处继续，不要重复已完成的工作」）。A 落地后工具结果已写明「答案未知、不要假定用户选了什么、可用 ask_user 重问」，模型不需要更精确的提词也知道该做什么。
2. **脆弱窗口窄**：ask 有超时（默认 300 秒，只有 `timeoutAction=wait` 才无限期），得「正好在这几分钟里被杀」才落进问题窗口；计划审批那种能挂几小时的场景才值得专门做入口。
3. **误判代价低**：最坏是用户打一句「把刚才的问题再问我一次」——比找按钮更灵活（可以顺手改一句问题）。
4. **长期维护面不划算**：按钮是「起一轮」的入口，与流式 / 压缩 / 归档 / 回合租约 / 防重入纠缠，以后每次动起轮链路都要连带回归它（`submitText` 防重入那次事故就是这么长出来的）。
5. **「卡片看着能点却点不动」已不成立**：A 之后卡片写的是「应用重启，这个问题没收到回答」，读起来是记录而不是坏控件；本应用用户是开发者，「自己打一句话」不构成门槛。

**重新考虑的门槛**：一两个月内真实遇到 ≥2 次「重启后只能重打一遍、还担心模型猜」，再照 §5.2-5.4 落地。

## 5. B′ 详细设计（5.1 已实施；5.2-5.4 未实施，保留为实施手册）

### 5.1 重放：改「模型读到的正文」，不动状态机（✅ 已实施，见 §12）

`ai-panel.js:1778-1788` 的 ask 分支改成：

- 仍收敛 `state = 'expired'` + `status = 'done'`（不新建状态、不复活卡、不进任何 Map）；
- **无条件**把 `message.content` 设为新常量 `ASK_LOST_TEXT`（加在 `ai-constants.js`，与 `TOOL_INTERRUPTED_TEXT` 并列）：

```
应用在等待用户回答这个问题时关闭了，没收到回答（答案未知）。不要假定用户选了什么；
如果这个答案还影响后续步骤，用 ask_user 重新问一次。
```

审批 / 变量填写同理（文案已按语义拆开，不要合并成一句）：

```
应用在等待用户审批这个操作时关闭了，没收到决定，该操作没有执行。需要的话请重新发起。
应用在等待用户填写变量值时关闭了，没收到决定，变量没有创建。需要的话请重新发起。
```

这样即使用户什么都不点，下次发言时模型也知道「答案未知、可以重问」，不再把「等待用户回答…」当成真结果。

同理把 §1.2 里审批 / envAsk 的两句「（会话重新加载）」改成「应用重启时没收到你的决定，该操作未执行」。

### 5.2 卡片：只有 `expired` 挂按钮

`ai-tool-cards.js:522 renderAskCard(wrap, message)` → 改签名接收 `session`（调用点 `:906-909` 已有该参数，只差透传）。当 `ask.state === 'expired'` 时，在 `ai-ask-result` 那一行下方补一个次级按钮：

- 文案「让 AI 重新问一次」，图标走注册表命名图标 `refresh`（`core/icons.js:51`）；
- `dataset.tip`：「按原问题与选项重新发起一次提问」；
- 点击 → `onReaskRecoveredAsk(session, message)`（经 ctx 注入，与 `openPlan` 同一形态）；
- 已点过的卡在内存里置 `message._reaskRequested = true` 并隐藏按钮（不落盘：重开后按钮复现无害，反而给了重试机会）。

`askResultText`（`:518`）的 `expired` 文案从「页面已关闭，问题未回答」改为「应用重启，这个问题没收到回答」——和按钮语义对齐。

### 5.3 投递：复用 `startSessionTurn`

`ai-panel.js` 新增 `reaskRecoveredAsk(session, message)`，骨架与 `resumeInterruptedTurn`（`:4401`）同形：

1. **守卫**：`streamOf(session.id) || compactOf(session.id) || compactStarting` 直接 return（同 `:4403`）；`session.archivedAt` 时给现有归档提示，不静默失败；
2. `session._interruptNotice = false`，收起横幅；
3. 置 `message._reaskRequested = true`，重渲染该卡（按钮隐藏，防连点）；
4. `startSessionTurn(session, reaskPrompt(message), {preserveScroll: true})`；
5. 失败按 `flashTurnStartFailure`（`:2790`）出提示，并**回滚** `_reaskRequested`（否则按钮消失但什么都没发生）。

**幂等 / 多窗口**：连点由 `_reaskRequested` + 流守卫挡住；跨窗口由 `startSessionTurn` 内建的回合租约挡住（第二个窗口得到「另一窗口正在运行」）。不需要新增登记表。

### 5.4 注入提词（纯函数，可单测）

新模块 `frontend/src/ai/ai-recovered-card.js`：

- `canReask(message)`：`role === 'tool' && ask.state === 'expired' && questions.length > 0`；
- `reaskPrompt(message)`：

```
（应用在这次提问等待回答时重启了，这个问题没收到回答。原问题如下：）

1. <问题正文>　　选项：A / B / C（可多选）
2. ...

请用 ask_user 把上面的问题重新提一次，问题与选项保持原样，不要自行假设答案继续；
如果这些答案对当前任务已经不再必要，直接说明原因并继续。
```

选项要带 `multiSelect` 标记与 `detail` 摘要（截断到 200 字），否则模型重问时会把多选改成单选、把重要背景丢掉。

**可见性**：这条消息按普通 user 消息落盘并显示（用户点了按钮，看得到自己「说了什么」更诚实）。不进 `silent`（`isSilentInjection` 只认 `task_todos_check`，天然不会误判）、不加 `app` 元数据。

### 5.5 不纳入范围

- 审批 / envAsk 的可交互恢复：横幅 + 文案已够，不做；
- 已落终态的其它卡片（answered / timeout / cancelled）：保持只读历史；
- 子代理 inbox 里的 ask（`ai-subagents.js:2175`）：子代理本身不跨重启，随其父一起收敛；
- 生成任务 / 后台命令 / 子代理的重启收敛：沿用现状；
- 计划审批：已完整持久化，不动。

## 6. 实施步骤

> 第 1、2 步已实施（= A）；第 3-6 步属 B，**已决定不做**（步骤保留，将来照做即可）。

| # | 落点 | 内容 | 预算 |
|---|---|---|---|
| 1 | `ai-constants.js` | 新增 `ASK_LOST_TEXT` | 3 行 |
| 2 | `ai-panel.js:1778-1788` | ask 分支无条件改写正文；`:1774`/`:1795` 审批与 envAsk 文案改「没收到决定，操作未执行」 | ~10 行 |
| 3 | `ai-recovered-card.js`（新建） | `canReask` + `reaskPrompt` 纯函数 | ~80 行 |
| 4 | `ai-panel.js`（`resumeInterruptedTurn` 旁） | `reaskRecoveredAsk` 守卫 + 起轮 + 失败回滚，挂进 ctx | ~40 行 |
| 5 | `ai-tool-cards.js:522 / :906` | `renderAskCard` 透传 session、`expired` 挂按钮、`:518` 文案 | ~25 行 |
| 6 | `frontend/test/ai/ai-recovered-card.test.mjs` | 纯函数用例，登记进 `npm test` 清单 | ~80 行 |

不新增 Go 方法 → `dev/mock-backend.js` 无需改动。

## 7. 验证

**单测**：`canReask` 判别（expired 命中；answered / timeout / cancelled 不命中；无 questions 不命中）；`reaskPrompt` 输出含全部问题、选项、多选标记、`detail` 截断、无选项时的降级文案。

**手工验收（关键）**：

1. 发 ask_user（带选项）→ 卡片出现 → 强杀应用 → 重开：卡片显示「应用重启，这个问题没收到回答」+ 按钮；点按钮 → AI 用 ask_user 重新提出同样的问题与选项 → 作答 → 原任务继续；
2. 同上但**不点按钮**，直接发一句新消息 → 模型不应假装知道答案（读到的正文是 `ASK_LOST_TEXT`），需要时主动重问；
3. ask 的 deadline 早已过期 → 卡片与按钮都正常（`expired` 分支本来就不渲染倒计时，回归确认）；
4. 写审批 pending → 重启 → 卡片取消 + 横幅；点横幅「继续回合」→ AI 不冒充「已执行」，不重复已完成的工作；
5. 双击按钮 / 两窗口同时点 → 只起一轮；
6. 归档会话、压缩中的会话 → 点按钮有明确提示，不静默丢弃；
7. 计划审批、已回答卡片、超时卡片行为不回归。

## 8. 风险与边界

- **模型不听话**：提词要求「不要自行假设答案」，长上下文里仍可能直接继续。缓解：`ASK_LOST_TEXT` 已写进工具结果，模型至少知道答案未知；重问不成功时用户还能直接手打答案。
- **多花一轮**：重问 = 一次额外模型往返（含工具调用）。比 A′ 的「答案直接落回原卡」贵，这是 B′ 换取「零守卫风险」的代价。
- **卡片堆积**：重放会把 `expired` 写回磁盘并长期保留（`_needsRewrite`），会话里会攒灰色卡。可接受——它们现在是可操作入口，不是死卡；将来若觉得吵，可加「超过 N 天的 expired 卡折叠」。
- **注入文本长度**：问题多、选项长时提词会偏长（每问 detail 上限 200 字）；`startSessionTurn` 已有 90% 发送门禁兜底。
- **文案分工**：`ASK_LOST_TEXT` 与 `TOOL_INTERRUPTED_TEXT` 语义不同（一个是「答案未知，可重问」，一个是「副作用未知，需确认」），不要合并。

## 9. 业界调研（2026-11-21，四家竞品）

结论：**没有一家实现「进程重启后恢复可交互卡片 + 原 turn 原地继续」**；主流是「交互请求不持久化 / 降级 + 新 turn 注入输入」。B′ 站在这一共识的**最轻一端**：连「把答案注入」都不做，只把「重新提问」交回模型。

| 维度 | Codex | opencode | deepseek-harness | ZCode |
|---|---|---|---|---|
| 提问工具 | `request_user_input`（阻塞）+ async 版 | `question` 插件（Deferred 阻塞） | `ask_user_question`（legacy 阻塞 / timed 限时） | `AskUserQuestion`（反向 RPC + pending interaction） |
| 请求是否落盘 | **否**，policy 显式丢弃 | **否**，ephemeral 事件 | 作为 Session 事件日志落盘，状态由投影折叠 | 问题正文不落盘，仅 deadline / receipt |
| 重启后请求 | 消失，turn 标 `Interrupted` | 优雅关→reject/cancel；崩溃→丢内存 | timed 提问投影为 `continued`（**仍可回答**）；阻塞类只留「结果未知」 | reannounce 重发协议请求（依赖 UI 存活）；中断工具补 error result |
| 补答如何回注 | `Op::UserInputAnswer` 重新 submit | synthetic 消息 + `execution.resume` 重跑 turn | `agent.steer(user-question-reply)` 新 turn | `plan_approval_feedback` / pending input 注入真实 user message |

关键证据（保留出处，将来升级 A′ 时复看）：

- **deepseek**：`ask_user_question` timed 模式超时返回 `{pending:true, callId}`、agent 继续工作，迟到回答经 `agent.steer()` 作为 `user-question-reply` 注入新 turn（`packages/interaction/user-questions/src/index.ts:187-232`）；`interruptedTurnClosers` 给未结算工具补 `TOOL_OUTCOME_UNKNOWN`（`core/session/src/repair.ts:18,209`），投影把该结果视同 pending → `continued`（`projection.ts:238-306,260-266`）。**这正是 §5.1「模型可见文本与 UI 状态分离」的原型**，也是 A′ 升级要补的那一层。
- **opencode**：`CONTINUE_AFTER_SERVER_RESTART` + `execution.resume` 重跑 turn（`core/src/session/execution/restart.ts:23-26,90-106`）——本应用 `66aead4` 的横幅续跑与它同源。
- **Codex / ZCode**：均为「重启即丢待处理态，回答/决定作为新输入重新提交」，佐证 B′ 的轻量路线不越界。

## 10. 附：A′ 升级路径（将来想「答案直接落回原卡」再看）

前置条件（缺一不可，对应 §4.1）：

1. 把 ask 的「UI 状态」与「模型可见 tool_result」拆成两层（deepseek 投影式）：重放时模型侧固定 `TOOL_OUTCOME_UNKNOWN` 语义；
2. `settleAsk` 增加恢复分支：只更新 `ask.state/answers`（界面态），**不改历史正文**；
3. 恢复卡不进 `pendingAsks`，改为用户点「补答」时**懒注册**条目，取消/切走即注销且不回写终态；
4. 对 `maybeAutoCompact` / `takeQueuedItem` / `toolMessageWaiting` / `cancelPendingAsks` 四处逐一确认豁免口径，并补护栏测试；
5. 恢复时 `deadline = 0`（不重建计时器；`armAskTimer` 只有新建路径，硬撑「新窗口」会渲染出 0:00）。

## 11. 相对 2026-11-21 版的差异

| 项 | 11-21 版 | 本版 |
|---|---|---|
| 路线 | A′（ask 可补答表单 + 审批注入续跑消息） | **B′**（ask 卡片重问按钮 + 正文改写） |
| 审批/envAsk 投递 | 新增「重放时注入合成续跑消息」 | **删除**：`66aead4` 的横幅 + 一键续跑已覆盖，只留文案修正 |
| 新建登记表 | `recoveredAsks` | **删除**：`expired` 是重放专属终态，天然判别 |
| 回合租约 | 「务必接」 | **无需新做**：`startSessionTurn` 内建 |
| 超时处理 | 「给一个全新的作答窗口」 | **置 `deadline = 0`**（「新窗口」没有重建计时器的路径） |
| 模型可见正文 | 未定义（只提「豁免中断标记」） | **新增** `ASK_LOST_TEXT` 无条件改写（原实现会漏出「等待用户回答…」） |
| 优先级 | 中 | **中低**（横幅已兜住「断轮」） |

## 12. 实施记录（A，2026-11-22）

- `ai-constants.js`：新增 `ASK_LOST_TEXT` / `APPROVAL_LOST_TEXT` / `ENV_ASK_LOST_TEXT`，注释写明「ask 是答案未知可重问、审批与变量是没执行需重提，不要合并」。
- `ai-panel.js` 重放段（`role === 'tool'` 分支）：三类挂起卡片的正文改为**无条件**整句替换。顺带修掉一处漏网——审批分支原先只匹配「等待用户审批…」这一个变体，命令审批的「等待用户审批命令…」（`:8149`）与分类器的「等待 AI 分类器判定…」（`:7833`）会原样漏给模型。
- `ai-tool-cards.js`：`askResultText` 的 `expired` 文案「页面已关闭，问题未回答」→「应用重启，这个问题没收到回答」。
- 同段还有一处同类漏点：`raw.ask` 存在但数据不完整（`normalizeAsk` 丢弃）时，原来也只在正文为空时才写「问题数据无效」，现在固定写成「数据不完整，已取消（答案未知）」，不再让占位漏给模型。
- 测试：新增 `frontend/test/ai/ai-replay-recovery-guard.test.mjs`（源码护栏：三类必须走 `*_LOST_TEXT`、旧文案不得复现），已登记 `npm test`；`ai-constants.test.mjs` 增一例（不得沿用注册占位、必须说清「没收到」、三者不得合并）。
- 验证：`npm test` 2294 通过 0 失败，`npm run build` 通过。
- **未做真机手工验收**：需要一次「发 ask_user → 强杀 → 重开 → 确认模型不再假定答案」（§7 第 1-3 条）。
- B 的三处落点（卡片按钮 / 注入提词 / 投递函数）保持原样，代码里没有为 B 预留任何开关。
- **结项**：B 于同日评估后不做（§4.2），本方案整体关闭并归档到 `finished-plans/`；§5.2-5.4 作为「真要恢复卡片交互时怎么改」的实施手册保留。
