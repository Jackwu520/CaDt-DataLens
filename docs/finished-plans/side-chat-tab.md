# 支线对话标签页化 + AI 面板视图层抽取（实施计划）

> 状态：**功能已交付并归档**（2026-11-15 调研成文；阶段 0–4 与抽取批次 V3/V4/M1–M5 全部落地，`npm test` 965/965、`vite build` 通过，见 §12 / §13 实施记录）。**未做项**：V1/V5（消息渲染家族 → `ai/ai-session-view.js`）因注入面超 §7.2 红线另立方案；V2 无需搬；审批卡在内容区宽度的真机目视待补。
> 决策依据：作者 2026-11-15 判定「支线对话与分支已无实质区别」，选定「支线进内容区标签页、能力与 UI 均完整、母会话留在 AI 面板、三枚头部 chip 在标签页内降级为顶部悬浮胶囊」；同时要求顺带抽离 `ai-panel.js` 的方法以收敛体积。
> 前置阅读：`docs/unfinished-plans/frontend-split-phase3.md`（拆分纪律与豁免条款）· `docs/finished-plans/session-messaging.md` §4.9（支线原始设计与 §4.12 信箱）· `.cadt/memory/ai-panel-ui-conventions.md`（接管 composer 的固定做法）· `.cadt/memory/frontend-module-refactor-audit.md`（验证方法论）
> 范围：`frontend/src/ai/` 的会话视图层与支线域、`frontend/src/bridge/bridge-sidechat-view.js`（新）、`frontend/src/editor/editor-groups.js` 特判分支、`frontend/src/style.css` 新增块；不改 Go 侧、不改流式协议、不改会话存储格式（仅新增可选字段）。

**关于「缩减体积」的一句话立场**：本方案的第一目标是**职责收敛**——让「会话内容视图」成为可被两个宿主复用的东西；减行数是副产品，不作验收指标。为凑行数把编排核心搬出去（`executeTool` 1092 行最诱人）是负收益，明确禁止。

---

## 1. 背景：三个现状问题

### 1.1 支线与分支已无实质区别

| 维度 | 分支 `branchSessionAt`（`ai-panel.js:9764`） | 支线 `openSideChat`（`ai-sidechat.js:46`） |
| --- | --- | --- |
| 会话类型 | 普通持久化会话 | 普通持久化会话（同） |
| 交互骨架 | `createSessionData` → `push` → `persistSessions` → `switchSession` | 完全相同 |
| 历史 | 深拷贝 `[0..index]` | **不复制**，只预填 8 行 × 240 字引用 |
| 配置 | 继承 scope / profileId / systemPrompt / promptTemplateId / summary | 强制 `scope='read'`，其余全空（走默认） |
| 回送 | 无专门入口 | 「带回主对话」→ `deliverAgentNotice` |
| 列表呈现 | 标题后缀「· 分支」，无关系元数据 | 缩进 + 徽标 + 紧跟母会话 + `sideOf` |

**结论**：分支有上下文、没归属；支线有归属、没上下文。两者差异互相抵消，用户感知为同一件事。「轻关联旁路」在实现上只剩一个元数据字段。

### 1.2 面板是单宿主，且这是硬编码的

`el` 由 `panel.querySelector('#ai-xxx')` 一次性构建（`ai-panel.js:239`），渲染函数直接写 `el.messages`。所有增量渲染路径都带同一条守卫：

```js
// ai-panel.js:7808（refreshToolWrap 首行）
if (!session || !isOpen() || currentSession() !== session) return;
```

同类守卫还出现在 `renderMessagesInner`(2552)、流式状态条(7791)、`refreshWrap`(7748) 等。**这是「支线不能进标签页」的直接原因**：面板显示母会话时，支线的流式与工具卡更新会被静默吞掉。

反面参照：子代理详情已经解决了多宿主——`mountAgentView(root, spec)`（`ai-subagents.js:1025`）把 view 对象（`root`/`head`/`body`/`composer`/`blockNodes`）作为渲染参数，同一子代理可同时挂多处、各自节流。而且 `renderToolMessage(wrap, message)` 已是**容器参数化**的纯渲染。这条路径可复用。

### 1.3 `ai-panel.js` 的拆分豁免已到期

`frontend-split-phase3.md` §1.6 把 `ai-panel.js`(11582) 与 `main.js`、`editor-groups.js` 一并列为**明确豁免**，理由是「拆分只会增加查找成本」；§0 范围行也写着「不动 ai-panel.js（交子代理消息化方案）」。该方案（`session-messaging.md`）已于 2026-11-15 全部落地，豁免的原始理由——「没有第二个消费者，拆了只是搬家」——现在失效：**标签页需要一个可复用的会话视图**，这是 phase3 判据①（混装 ≥2 个可独立冒烟的子域）的正面命中。

当前体积：`ai-panel.js` **12393 行**（phase3 记录的 11582 → 在途增 811）。顶层分区与函数排行见 §7.1。

---

## 2. 目标 / 非目标

**目标**

1. 支线对话以内容区标签页承载，母会话留在 AI 面板，两者同时可见。
2. 支线的能力与 UI 与主对话对齐（消息全类型、工具卡、审批、composer 全家桶、changes 卡、统计行、todos、胶囊）。
3. 支线**必须**与母会话同时在场（§3.1 不变量），不允许出现跨会话错配。
4. 顺带把「会话内容视图」抽成可复用组件，`ai-panel.js` 只留编排与外壳。

**非目标**

- 不做 AI 面板多实例（理由见 §4.1，42 处 `#ai-panel` id 选择器是硬约束）。
- 不做支线的历史实时同步、上下文自动注入（§6）。
- 不动 `executeTool` / 流式对话区 / 会话持久化 / 配置加载（§7.4）。
- 不做支线嵌套（`sideOf` 仍不嵌套）。
- 不改 `sessionstore*` / 不新增 Go 侧接口。

---

## 3. 两条不变量（先立规矩，再谈实现）

### 3.1 支线标签页 ⇄ 母会话在前台

**规则**：`switchSession` 是唯一收口（`ai-panel.js:10012`），目标是支线时一律重定向：

```js
// 伪代码，落在 switchSession 入口（跨工作区软切换判定之后）
const sideOf = aiTextOf(target.sideOf).trim();
if (sideOf) {
    const owner = sessionById(sideOf);
    if (owner) {
        activateSideChatTab(target.id);      // 开/激活内容区标签页
        return switchSession(owner.id);      // 面板落到母会话（owner 不是支线，不再递归）
    }
    // 母会话已删除：转为独立会话（清 sideOf），再按普通会话切换
    target.sideOf = '';
    persistSessions();
}
```

**为什么必须收口在一处**：会破坏约束的入口至少有六条，逐处加判断必漏。

| # | 入口 | 现状 | 收口后的行为 |
| --- | --- | --- | --- |
| 1 | 会话列表点击支线（缩进项） | `switchSession(child)` | 面板切母会话 + 激活支线标签页 |
| 2 | AI 消息操作条「新建支线对话」 | 母会话即当前 | 天然满足 |
| 3 | `deliverMessageToSession` 投递后跳转 | 直接 switch | 同 1 |
| 4 | 重启恢复 `config.activeSessionId` = 支线 | 会在面板内显示支线 | 重定向到母会话；标签页**不持久化**（§5.5） |
| 5 | 模型侧 `session_list` / 投递回执触发的跳转 | 直接 switch | 同 1 |
| 6 | `syncWorkspaceToSession` 返回 `'window'` 的跨工作区软切换 | **先 return，绕过重定向** | 重定向判定放在软切换**之后**；新窗口启动时同样按本规则落地 |

### 3.2 一个会话一个活跃宿主

同一会话不允许同时在面板与标签页渲染。3.1 的重定向已经保证「面板永不显示支线」，因此只需再约束反方向：**支线标签页打开期间，若用户从面板切到别的会话，标签页进入「失联态」而不是销毁**（§5.2）。

---

## 4. 架构：会话视图组件

### 4.1 为什么不是「面板多实例」

`style.css` 里 `#ai-panel` 出现 **42 处**、`#ai-*` id 选择器 **66 处**，全部是 `#ai-panel.xxx .ai-yyy` 形态，且特异性参与了大量覆盖顺序（例如 `#top-row.ai-dock-fill #ai-panel.ai-dock` 三连）。改成 class 作用域会改变特异性、打乱既有级联——这类改动的回归面覆盖整个 AI 面板外观，收益却只是「能开两个面板」，其中第二个面板还要砍掉三形态、拖拽、会话列表。**否决多实例。**

### 4.2 组件边界

新增 `ai/ai-session-view.js`，形态沿用项目既定模式（factory + 显式依赖注入 + deps 延迟求值）：

```js
export function createAISessionView(ctx) { ... }
// 每个宿主实例化一次：
const view = createAISessionView({...});
view.mount(rootElement, sessionId);   // 建骨架
view.attach();                        // 登记到 viewHosts
view.detach();                        // 关标签页/面板隐藏
```

| 归属 | 内容 |
| --- | --- |
| **组件负责** | 消息区（`ai-messages` 语义）、底部堆叠（ctx 横幅 / todos / composer / takeover / 统计行）、滚动钮、搜索条、队列渲染 |
| **宿主负责** | 外层容器与尺寸、标题与身份、胶囊（面板是 `#ai-head` 的 chip，标签页是顶部悬浮条）、菜单入口、三形态与拖拽（仅面板） |
| **共享纯渲染** | `renderMessage` / `renderTurn` / `renderToolMessage(container, msg)` / `enhanceAnswerBody` / `renderPendingApprovalPlaceholder`——签名已是容器参数化，搬进组件后两宿主共用 |

组件**不持有会话状态**：会话对象、`streams`、`pendingApprovals` 等仍在 `ai-panel` 闭包，组件经 ctx 读写。这点与 `mountAgentView` 一致（那里 view 只持有 DOM 节点与节流计时器）。

### 4.3 宿主登记表与守卫替换

```js
const viewHosts = new Map();   // sessionId -> Set<view>
function hostOf(sessionId) { ... }        // 取任一活跃宿主（渲染目标）
function hasHost(sessionId) { ... }
```

守卫改造（唯一会碰热路径的一步）：

| 原守卫 | 新判据 |
| --- | --- |
| `!isOpen() \|\| currentSession() !== session` | `!hasHost(session.id)` |
| `currentSession() !== session`（增量渲染） | `hostOf(session.id) !== thisView` 时才跳过 |
| `el.messages.querySelector(...)` | `host.view.messages.querySelector(...)` |

面板自身也登记为一个宿主（`sessionId = currentSession().id`，随 `switchSession` 迁移），因此面板路径的行为与现在逐字节等价——这是回归的锚点。

> **实测修正（2026-11-15）**：`currentSession() !== session` 这类守卫全仓库只有 **4 处**（`refreshToolWrap` 7824、流式状态条 7807、上下文弹层 4423、结构定位条 6044），已全部替换为 `hasHost()`。但 `renderMessagesInner` / `renderTurn` 等全量渲染入口**根本没有守卫**——它们直接读 `currentSession()` 并写 `el.messages`。所以真正的改造重点是把**渲染目标**参数化，而不是替换守卫；`hasHost` 只解决「增量更新被吞」。阶段 2 的第一件事必须是把 `renderMessages(session, target)` 做出来。

### 4.4 takeover 必须按会话参数化（**安全项**）

`.cadt/memory/ai-panel-ui-conventions.md` 规定：审批与提问一律接管 composer（`#ai-takeover` + `updateComposerTakeover(force)`），优先级 `ask_user > env_create > approval > plan`。查找函数 `currentPendingXxxEntry()` 现在按 **`currentSession()`** 过滤。

多视图后这变成**安全缺陷**：支线标签页里的 takeover 会显示母会话的待审批项，用户可能在 A 会话的视图里批准 B 会话的写操作。必须同步改成 `pendingEntryFor(sessionId)`，所有决议函数（`decideApproval` / `decideEnvCreation` / `decideAsk` / 计划批准）一律以「哪个视图点的」为准，而不是「面板当前是哪个」。

同理，消息流内的占位行 `renderPendingApprovalPlaceholder()` 也要按视图的会话渲染。

### 4.5 单例闭包清单（必须 per-view）

以下变量/节点当前是面板单例，多视图后逐个变为 per-view（这是「骨架参数化」的实际内容，比 DOM 更麻烦）：

| 项 | 现在 | 之后 |
| --- | --- | --- |
| `stickBottom` | 单个布尔 | per-view（否则一支跟随、一支翻历史会互相劫持滚动） |
| `el.scrollBtn` / `updateScrollButton()` | 单例 | per-view |
| `--ai-sbw`（实测滚动条槽宽，写在 `#ai-panel` 上） | 面板级 | 宿主级（标签页容器自测） |
| ResizeObserver 写 `messages.style.paddingBottom` | 面板级 | 宿主级 |
| `el.dialog` / `el.queue` / `el.ctxBanner` / `el.statsWrap` | 单例 | per-view |
| `chipsPopKind` / `#ai-chips-pop` | 单例 | 面板保留；标签页胶囊另建（§5.3） |

另外：`switchSession` 里「切会话收起头部弹层」（`ai-panel.js:10041`）这类**面板外壳动作**，标签页宿主不参与。

---

## 5. 支线标签页

### 5.1 doc 形态与接线（对齐虚拟文档标签页的既定五处）

新模块 `bridge/bridge-sidechat-view.js`，doc 形态 `doc.sideChat = sessionId`（对应 `doc.browser` / `doc.bgTerm` / `doc.agentView` 的先例）。必改五处（`.cadt/memory` 与 AGENTS.md 均记录过）：

1. `bridge/bridge-sidechat-view.js`：建 doc（`format {id:'sidechat', rawOnly:true}`、`name` 取会话标题、`mode:'sidechat'`）、建 pane、`mount` 组件、`closeDocNow` 卸载。
2. `editor/editor-groups.js`：`createDocEditor` 特判分支 + 标签图标 + `closeDocNow` 卸载钩子。
3. `writing/writing-ui.js`：`viewOptionsFor` 返回 `[]`（不参与视图切换菜单）。
4. `main.js`：穿依赖（`aiPanel.bridgeMountSideChat` / `bridgeUnmountSideChat`）。
5. `bridge/bridge-ui.js`：合并导出。

上限：同时最多 **3 个**支线标签页（对齐 `AGENT_VIEW_MAX = 8` 的收敛思路，但对话比视图重，取更小值）。

### 5.2 三态

| 态 | 触发 | 表现 |
| --- | --- | --- |
| **在位** | 面板当前 = 母会话 | 正常收发；胶囊可点；composer 可用 |
| **失联** | 面板切到别的会话 | 消息只读、composer 禁用、顶部横幅「母会话已不在前台 · 回到「X」」；**正在跑的流式允许跑完**；点横幅 = `switchSession(母)` 并激活回本标签页 |
| **母会话已删除** | `sessionById(sideOf)` 为空 | 横幅「母会话已删除」+ 「转为独立会话」按钮（清 `sideOf`，与既有 `promoteSideChat` 同一动作） |

**失联不销毁**是这套设计的关键：否则用户在面板里新建会话就等于毁掉刚开的支线视图，「新建会话」变成破坏性操作。

### 5.3 胶囊（三项头部 chip 的标签页形态）

面板头部四枚 chip：`#ai-chip-agents` / `#ai-chip-terms` / `#ai-chip-timers` / `#ai-chip-schedules`（`ai-panel.js:242-245`），共用 `#ai-chips-pop` 弹层。标签页里降级为内容区顶部的一条悬浮带（与 `.ai-bottom-stack` 镜像；todos 仍在底部不动）。

**成本比预想低**，因为两个 chip 的落点本来就是「开另一个标签页」：

- 智能体团队每行 → `openAgentView(...)` → 内容区标签页（`ai-subagents.js:534`）
- 后台终端每行 → `openBgTermInContent(entry)` → 内容区标签页（`ai-subagents.js:561`）
- 计时器 → 唯一需要真弹层，且已有**容器参数化钩子** `ctx.renderChipsPopExtra(kind, container)`（`ai-subagents.js:484`）

改造点：`renderChipsPop(kind)` → `renderChipsPop(kind, host)`；`positionChipsPop(chip)` 里的 `panel.getBoundingClientRect()` → 宿主 rect。面板传入 `el.chipsPop` 保持原样，标签页传自己的下拉容器（absolute 挂在胶囊下方，`overflow` 由宿主保证）。

胶囊内容：运行中子代理数 / 后台作业数 / 计时器倒计时角标；空态显示灰点，不占位。

### 5.4 深拷贝与 `<side_chat>`

- 数据：与分支一致的深拷贝。有 `index` 时拷贝 `[0..index]`（沿 `branchSessionAt:9779-9801` 的处理：剔除 `changes-summary`、`streaming` 归 `done`）；无 `index`（从列表/头部创建）时拷贝**全部历史 + 当前 `summary`**。
- **补齐既有遗漏**：`branchSessionAt` 只拷了 scope/profileId/systemPrompt/promptTemplateId/summary/workspace/messages，**漏了 `approvedPaths` / `readRoots`**。两个入口一并补——否则深拷贝出来的会话第一次写文件要全部重新审批，母会话刚批过的路径不算数。
- 配置继承：支线不再强制 `scope='read'`，继承母会话档位（用户可在标签页内按现有四档自行调整）。
- 提示词：**不写身份宣告**，写 `<side_chat>` 约束块，与 `<plan_mode>` / `<workspace_rules>` 同级（组装处：`ai-system-context.js`），只写三件事：
  1. 你的历史是母会话在某时刻的快照，之后的进展你看不到；
  2. 结论要送回母会话，走会话投递（`session_send`）或「带回主对话」；
  3. 不要再开新的支线。
- 标签页头标注快照时刻（`自 HH:mm 的快照`），避免误解为实时同步。

### 5.5 转正与关闭语义

- **转正**：标签页右键「转为独立会话」→ 清 `sideOf`（复用 `promoteSideChat`）→ 标题去掉「支线」前缀 → `<side_chat>` 块随之消失 → **标签页保留**（标签页是视图，会话是数据，脱钩无副作用）。
- **关闭**：关标签页 = 关视图（会话仍在会话列表，带「曾在标签页打开」无状态标记即可）；删除会话 = 真删（走既有回收站删除）。两者不能混。
- **不持久化标签页**：重启后只留会话列表项，避免一排支线标签页把代码标签页挤掉。`config.activeSessionId` 若为支线，按 §3.1 重定向到母会话。

### 5.6 无内容区形态的降级

`float`（独立悬浮窗）与 `fullscreen` 两种形态没有内容区标签页。沿用 `openAgentView` 的既有裁决（`ai-subagents.js:1069`：非浮窗才开标签页，否则退回面板内覆盖层）：支线在这两种形态下**退回面板内覆盖层**（复用 `#ai-agent-view` 那条挂载路径），并在胶囊位置给出「回到主窗口可并排查看」提示。不做静默失败。

---

## 6. 主副共享：共享通道，不共享历史

**该做**

| 项 | 说明 | 成本 |
| --- | --- | --- |
| 反向投递（母 → 支线） | 现在只有支线 → 母（`bringBackToParent`）。母会话的补充指令、后续进展也应能投给支线：走同一 `deliverAgentNotice`，新增 `kind: 'parent-note'` | 1 个菜单项 + 1 个 kind |
| 权限凭据快照 | `approvedPaths` / `readRoots` 随深拷贝继承（§5.4） | 2 行 |
| 带回附结构化摘要 | `bringBackToParent` 现在只丢一段文本；支线若动过文件，附上它的 `changes` 文件列表，让母会话知道「支线改了什么」 | 小 |

**明确不做**

- 历史实时同步 / 上下文自动注入：分叉的意义就是各自演化，同步等于把它变回同一会话，且会让 context 计数、压缩、摘要全部错乱。需要什么就引用什么（既有 `<quote>` 机制）。
- 改动汇总合并：两边都改文件会串味，母会话的 changes 卡不收支线的改动。用「带回附摘要」告知即可。
- 流中断联动：停母会话不该停支线（`streams` 本就按会话隔离）。

---

## 7. `ai-panel.js` 体积净账

### 7.1 现状测量（2026-11-15）

`ai-panel.js` **12393 行**。顶层分区 33 处（`// ---------- xxx ----------`），最大函数：

| 函数 | 行数 | 归属 |
| --- | --- | --- |
| `executeTool` | 1092 | 编排核心（**不搬**） |
| `agentToolHandler` | 371 | 编排核心（不搬） |
| `logActivity` | 245 | 旁路（不搬） |
| `handleEvent` | 202 | 流事件路由（不搬） |
| `updateEntryButtons` | 193 | 视图（可搬） |
| `showModelPicker` | 182 | 视图（可搬） |
| `bindPanelInteractions` | 176 | 事件绑定（**拆两半**） |
| `renderTurn` | 142 | 视图（可搬） |
| `renderMessage` | 122 | 视图（可搬） |
| `renderMessagesInner` | 72 | 视图（可搬） |

### 7.2 判据（沿用 phase3 + 注入面）

phase3 的四条判据照用：① 混装 ≥2 个可独立冒烟的子域；② ≥900 行或单域逼近 1000 红线；③ 拆分后每块 <1000 行；④ 不与其他批次碰同一文件。

追加一条本方案特有的**注入面**判据（来自 `session-messaging.md:389` 的教训：`startSessionTurn` 「注入面大于收益」故留在 panel）：

| 档 | 判据 | 处置 |
| --- | --- | --- |
| 低 | 需注入 ≤8 项，且不写外部状态 | 可搬 |
| 中 | 9–15 项，或写 1–2 个闭包变量 | 可搬，需 mock ctx 冒烟 |
| 高 | >15 项，或读写 streams/config/回合流程 | **不搬** |

### 7.3 视图层批次（V1–V5，本方案的主体）

| 批次 | 内容 | 行号约 | 行数 | 注入面 | 去向 |
| --- | --- | --- | --- | --- | --- |
| V1 | 消息渲染家族（`emptyState`/`renderWindowState`/`renderArchivedSummaryCard`/`renderMessages`/`renderMessagesInner`/turn 分组与渲染/think/图片预览与灯箱挂载） | 2323–3600 | ~1270 | 中 | `ai/ai-session-view.js` |
| V2 | 工具卡按钮态与审批交互（`updateEntryButtons` 及其依赖） | 1946–2139 | ~193 | 中 | `ai/ai-session-view.js` |
| V3 | 本轮用量浮层 + composer 统计行/上下文弹层 | 3600–3723、4141–4443 | ~425 | 低–中 | `ai/ai-usage-ui.js` |
| V4 | 行 diff 与写审批渲染 | 5030–5273 | ~243 | 中 | `ai/ai-diff-view.js` |
| V5 | 会话区事件绑定（从 `bindPanelInteractions` 切出会话内容部分；外壳部分留守） | 11386–11654 | ~150 | 中 | `ai/ai-session-view.js` |

**小计 ≈ 2280 行**。

### 7.4 顺手批（M1–M5，与视图抽取解耦，可独立提交）

| 批次 | 内容 | 行号约 | 行数 | 注入面 | 去向 |
| --- | --- | --- | --- | --- | --- |
| M1 | 双层级模型选择器（搜索 + 账号分组 + 推理档） | 9042–9526 | ~484 | 低 | `ai/ai-model-picker.js`（新） |
| M2 | 输入框右键编辑菜单（撤销/重做/剪贴/全选） | 9546–9940 | ~394 | 低 | `ai/ai-composer.js`（既有） |
| M3 | 对话日志自动落盘 | 10319–10581 | ~262 | 低–中 | `ai/ai-session-disk.js`（既有） |
| M4 | 管理对话框残留（提示词/记忆/技能） | 10581–11046 | ~465 | 中 | `ai/ai-manage-dialogs.js`（既有） |
| M5 | 结构面板的「会话结构」定位条 | 3723–3886 | ~163 | 低 | `ai/session-outline.js`（既有） |

**小计 ≈ 1768 行**。

### 7.5 明确不搬（附理由）

| 区块 | 行号约 | 行数 | 理由 |
| --- | --- | --- | --- |
| `executeTool` + `agentToolHandler` | — | ~1460 | 工具分发是全应用最热路径，引用 20+ 闭包状态；注入面「高」 |
| 流式对话区（`startRound`/`handleEvent`/`attachStream`/`finishStream`） | 7672–8688 | ~1016 | 回合流程核心，与 `streams`/`oneShot` 深度耦合 |
| 配置与会话持久化（normalize/load/persist/标题队列） | 566–1936 | ~1370 | 全模块的读取中心，搬走会形成循环依赖 |
| `session_history` | 6426–7672 | ~1246 | 工具执行体，依赖消息窗口与压缩状态 |
| 初始化与面板几何/三形态 | 11046–12393 | ~1350 | 面板外壳专属，标签页不需要 |

### 7.6 终态预估

| 时点 | `ai-panel.js` | 说明 |
| --- | --- | --- |
| 现状 | 12393 | — |
| 视图抽取后（V1–V5） | ~10100 | 组件成为第二消费者，这是本方案的前提 |
| 顺手批后（M1–M5） | **~8350** | 净减约 4000 行 |

`ai-session-view.js` 自身约 1500–1800 行（含两宿主共用骨架），仍在 1000 红线以上——若继续膨胀，按「消息区 / 底部堆叠 / 滚动与搜索」三段再切，与 phase3 的 A 系列同法。

---

## 8. 阶段划分

### 阶段 0：多宿主内核（**唯一碰热路径**，必须先做且单独提交）— **已完成 2026-11-15**

1. `viewHosts` 登记表 + `hostOf`/`hasHost`。
2. 守卫替换（§4.3 三行表），面板自身登记为宿主，保证行为等价。
3. takeover 按会话参数化（§4.4，**安全项，不可延后**）。
4. 单例闭包 per-view 化（§4.5）。

> **实际做法（比原计划保守）**：只落了 `hasHost(sessionId)` 一个函数，实现为 `isOpen() && id === currentSession().id`——与旧守卫逐字节等价，**暂不建 `viewHosts` 表**（只有一个宿主时建表只是空转，且登记/注销点漏掉反而制造 bug）。真正的登记表与 `hostOf` 随阶段 2 的第二个宿主一起加，届时只改 `hasHost` 的实现，调用点不动。§4.5 的单例 per-view 化同样推迟到阶段 2（无第二宿主时改动没有可观测行为，纯风险）。
> 验收：`npm test` 506/506、`vite build` 通过。

### 阶段 1：规则先跑起来（低风险切片）— **数据层已完成**

1. `switchSession` 重定向（§3.1）+ 六入口过一遍。
2. 三态骨架（§5.2）——先在面板内用一个临时横幅验证，不接标签页。
3. 深拷贝补齐 `approvedPaths`/`readRoots`（§5.4，顺带修分支的既有遗漏）。

> **实际做法**：第 3 项先落地（纯数据层、无 UI 依赖），并抽出 `ai/ai-session-fork.js` 供分支与支线共用；**第 1、2 项推迟到阶段 2**——重定向的落点就是标签页，先做会出现「切到母会话但支线无处可看」的中间态，比不做更差。详见 §12。

验收：无论怎么点，面板都不会显示支线；支线不会与错误的母会话配对。此阶段可独立上线，用户可见变化只有「点支线会连带切到母会话」。

### 阶段 2：支线标签页（能力完整）

1. `ai-session-view.js` 抽取消息骨架（V1）。
2. `bridge-sidechat-view.js` + 五处接线（§5.1）。
3. 输入行（发送/停止/排队/插队/附件/审批）+ 三态接入。
4. 深拷贝 + `<side_chat>` + 转正 + 关闭语义。

验收：支线标签页能完整跑一轮带写文件的任务（审批在标签页内完成）。

> **第一批已落地（2026-11-15，只读渲染）**：
> - `ai-panel.js` 新增**渲染目标**机制：`renderTarget` + `msgHost()` / `renderSessionOf()` / `withRenderTarget(target, fn)`；`renderMessagesInner` 的全部写入点改走 `msgHost()`，面板单例 UI（todos / 改动汇总 / 统计行 / 接管区 / 滚动钮 / 结构面板 / 表针 ticker）在外渲染时跳过，滚动交给宿主。
> - 新增 `bridgeRenderSideChat(root, sessionId)` 并作为 `aiPanel.bridgeRenderSideChat` 导出。
> - 新模块 `bridge/bridge-sidechat-view.js`（`openSideChatTab` / `createSideChatView`，上限 3），六处接线：`bridge-ui`（import/构造/展开）、`main.js`（解构 + `createAIPanel` 传 `openSideChatTab` + editor deps `createSideChatView`）、`editor-groups`（图标 / `createDocEditor` 分支 / `closeDocNow` 卸载）、`writing-ui`（`viewOptionsFor` / `viewLabel`）、`icons.js`（登记 `sidechat`）。
> - **行为改变**：`openSideChat` 不再 `switchSession(child.id)`——有内容区时开标签页、面板留在主对话；无内容区（悬浮窗）退回旧行为。
> - `npm test` 515/515、`vite build` 通过（含 `module-scope` 扫描）。
>
> **阶段 2 已落地（2026-11-15）**：
> - **渲染目标**：`ai-panel.js` 新增 `renderTarget` + `msgHost()` / `renderSessionOf()` / `withRenderTarget()`；`renderMessagesInner` 全部写入点走 `msgHost()`，外渲染时跳过面板单例 UI（todos / 改动汇总 / 统计行 / 接管区 / 滚动钮 / 结构面板 / 表针 ticker），滚动交给宿主。面板自身不设 renderTarget，行为等价。
> - **标签页**：`bridge/bridge-sidechat-view.js`（`openSideChatTab` 上限 3 / `createSideChatView`）——标题条（主对话名 + 快照时刻）、胶囊条、三态横幅、消息区、接管区、输入行。
> - **接线**：`bridge-ui`（import/构造/展开）、`main.js`（解构 + `createAIPanel` 传 `openSideChatTab` + editor deps `createSideChatView`）、`editor-groups`（`sideChatTabIcon` / `createDocEditor` 分支 / `closeDocNow` 卸载）、`writing-ui`（`viewOptionsFor` / `viewLabel`）、`icons.js`（登记 `sidechat`）。
> - **不变量**：`switchSession` 收口重定向（支线 → 切母会话 + 激活标签页），**且只在有标签页出口时生效**——否则悬浮窗里会切回母会话、支线再也看不到；跨工作区软切换判定在 `syncWorkspaceToSession` 之后。母会话已删除时清 `sideOf` 按普通会话继续。`bridgeOnSessionSwitch` 通知各标签页重判状态。
> - **三态**：在位（可收发）/ 失联（只读 + 「回到主对话」横幅，流式允许跑完）/ 母会话已删除（「转为独立会话」）。转正后 `sideOf` 清空 ⇒ `inPlace` 视为真，横幅消失。
> - **输入行**：Enter 发送 / Shift+Enter 换行；流式中显示「停止」；发送走 `startSessionTurn`（会话参数化，不读 currentSession）；流式期间 400ms 轮询整段重绘（增量路径都指向面板，标签页不抢）。
> - **胶囊**：智能体团队 / 后台终端 / 计时器三枚，角标计数，点击 `ensureOpen()` + `toggleChipsPop` 回到面板对应弹层——不复制 `#ai-chips-pop`。
> - **标签页内审批**：`updateComposerTakeover(force, sessionOverride, takeoverHost)` 参数化，渲染时临时替换 `el.takeover` 引用（try/finally 复位），外部宿主不碰 composer 类名与浮层定位；消息区点击经 `handleMessageClick(e, sessionOverride)` 代理，**只放行审批 / 环境变量 / 用量徽标**，其余动作不响应以免误改母会话。
> - **深拷贝**：`openSideChat` 改用 `forkMessages`（`opts.index` 缺省 = 全量），支线不再是「只带一句引用」的弱化版。
> - `npm test` 515/515、`vite build` 通过（含 `module-scope` 扫描）。
>
> **仍未做**：标签页内的分支/重试/编辑等消息动作（只放行了审批类）；`viewHosts` 真表与单例 per-view 化（当前靠 `hasHost` + renderTarget 等价实现）；带回附 `changes` 摘要。**未实机验证**：`.ai-messages` 的 overlay 滚动条槽宽 `--ai-sbw` 只在面板测过，标签页里需要真机看一眼；审批卡的 `.takeover-*` 样式在内容区宽度下的排版也需目视。

### 阶段 3：UI 补齐 + 胶囊

V2–V5 + 胶囊（§5.3）+ changes 卡 + 统计行 + slash/搜索。按块提交，每块可单独 revert。

### 阶段 4：顺手批（M1–M5）与文档收尾

与功能无关，纯拆分，按 phase3 纪律执行（逐字搬移、mock ctx 冒烟、每批独立 revert）。

---

## 9. 回归清单

**A 组：面板独立使用（阶段 0 必须逐项与改动前一致）**

1. 新建/切换/重命名/归档/删除会话；重启恢复。
2. 流式收发、停止、重试、编辑重发、回退、分支。
3. 工具卡各形态（读/写/diff/命令/浏览器/diff 展开）。
4. 审批四类（写文件/命令/ask/env_create）+ 计划批准，含优先级链。
5. 底部堆叠：ctx 横幅、todos、composer、统计行；滚动条槽宽与遮挡。
6. 头部四 chip 与弹层；changes 弹层；turn 用量浮层。
7. 三形态（dock/fullscreen/float）与拖拽、左右互换、编辑区收起。

**B 组：支线（阶段 2 起）**

8. 母会话流式中开支线 → 两条流并存互不打断 → 支线在标签页正常收发。
9. 列表点支线 → 面板切母会话 + 标签页激活；杀掉标签页再点仍能重建。
10. 面板切到别的会话 → 支线进入失联态（只读 + 横幅）；点横幅回位；流式跑完不受影响。
11. 母会话删除 → 支线横幅变「已删除」+ 转独立会话可点；重启后从列表正常打开。
12. 转正 → 标题去前缀、`<side_chat>` 消失、标签页保留。
13. 跨工作区支线：新窗口启动时落到母会话，标签页可开。
14. float / fullscreen 形态点支线 → 退回面板内覆盖层，不静默失败。
15. 同一支线不开两个标签页；最多 3 个；关标签页不删会话。

**C 组：共享**

16. 支线「带回主对话」→ 母会话忙时注入、闲时唤醒；附 changes 文件列表。
17. 母 → 支线投递（`parent-note`）能唤醒并在标签页显示。

**D 组：工程**

18. `npm test`（新增 `.test.mjs` 必须手动加进 `frontend/package.json` 的 test 清单，否则不会执行）。
19. `vite build` 通过；三类扫描（AGENTS/memory 记录的拆分验证法）无遗漏注入。
20. 静态复现页核对胶囊与失联横幅（`browser_evaluate` 在本项目有 bug，起 `python -m http.server` 看渲染）。

---

## 10. 风险与兜底

| 风险 | 兜底 |
| --- | --- |
| 守卫替换导致面板渲染漏更新（最热路径） | 面板自身登记为宿主、行为等价；阶段 0 不做任何新 UI，A 组回归作为唯一验收 |
| 支线视图里批准了母会话的写操作（**安全**） | §4.4 takeover 全部按 session 参数化，作为阶段 0 硬门槛；回归第 4 项加「两个视图同时有待审批」用例 |
| `stickBottom` / `--ai-sbw` 仍残留单例 → 滚动互相劫持 | §4.5 清单逐项过；任一未 per-view 化就不得进入阶段 2 |
| 标签页与面板同时持有同一会话 | 3.1 重定向保证面板不显示支线；再加 `hostOf` 断言（开发期 console 报警） |
| 胶囊遮挡消息顶部 | 胶囊条高度作为消息区 `padding-top`（与 bottom-stack 同一套 ResizeObserver 逻辑） |
| 跨工作区软切换绕过重定向 | 重定向判定放在 `syncWorkspaceToSession` 之后；回归第 13 项专门覆盖 |
| `ai-session-view.js` 自身超红线 | 按「消息区 / 底部堆叠 / 滚动搜索」三段再切（§7.6） |
| 深拷贝体积（大历史分支） | 沿用既有 `JSON.parse(JSON.stringify(...))` 与失败提示；不引入新持久化 |

---

## 11. 待确认项

1. **阶段顺序**：是否接受「先阶段 0+1（规则跑通、用户可见变化很小）再动 UI」？我认为这是唯一能压住回归的顺序。
2. **胶囊范围**：第一版胶囊是否接受「agents/terms 直接开目标标签页、只有计时器带下拉」？（面板那套 `#ai-chips-pop` 不复制到标签页，成本差一个数量级）
3. **支线里的分支**：建议**保留**（分支是独立会话、无 `sideOf`，不构成嵌套风险）；真正要禁的只是「支线开支线」。确认？
4. **标签页上限 3** 是否够用；是否需要「固定钉住不被自动挤掉」。
5. **顺手批 M1–M5** 是并入本方案一起做，还是按 phase3 的批次单独排期（我建议后者，避免一次提交过大）。

---

## 12. 实施记录（2026-11-15）

### 12.1 已完成

| 改动 | 文件 | 说明 |
| --- | --- | --- |
| 宿主判定收敛 | `ai-panel.js` | 新增 `hasHost(sessionId)`；4 处 `currentSession() !== session` 守卫全部替换（`refreshToolWrap`、流式状态条、上下文弹层、结构定位条）。实现为 `isOpen() && id === currentSession().id`，与旧守卫逐字节等价 |
| takeover 按会话查找 | `ai-panel.js` | `currentPendingAskEntry` / `EnvEntry` / `ApprovalEntry` 增加可选 `sessionId`，新增 `pendingSessionOf`；无参调用行为不变 |
| 分叉纯函数 | `ai/ai-session-fork.js`（新）+ `.test.mjs`（新 9 例） | `forkMessages`（`[0..index]` / 全量、深拷贝、剔除 changes-summary、streaming 归 done）、`forkSettings`（档位/模型/人设/模板/摘要/**授权凭据**） |
| 分支修复 | `ai-panel.js` `branchSessionAt` | 改用 fork 模块；补上原本漏掉的 `modelId` / `approvedPaths` / `readRoots` |
| 支线配置继承 | `ai-sidechat.js` | 用 `forkSettings` 替换硬编码 `scope='read'`；继承档位/模型/人设/模板/授权；`workspace` 为空时保留 `createSessionData` 的默认值（不覆盖成空串） |
| 系统提示词 | `ai-system-context.js` + `ai-panel.js` | 新增 `sideChatBlock()` 生成 `<side_chat>`，紧跟 base、仅 `sideOf` 非空时注入；面板 ctx 补 `sessionById` getter 供其取母会话标题 |

验证：`npm test` **515/515**（原 506 + 新增 9）、`npm run build` 通过（3.84s）。新测试已登记进 `frontend/package.json` 的硬编码 test 清单；`package.json.md5` 按项目约定未动。
**未提交**：工作树有作者在途改动（`git status` 显示 40+ 文件已修改），本次只做精确插入，不与在途改动混提交。

### 12.2 实施中的发现（比方案预想的更绕）

`renderMessagesInner` 等**全量渲染入口没有** `currentSession() !== session` 这层守卫——它们直接读 `currentSession()` 并写 `el.messages`。所以多宿主的障碍不是守卫（仅 4 处，已全部收口），而是**全量渲染的目标本身是隐式的**。阶段 2 必须把渲染目标参数化（`renderMessages(session, target)`），光靠 `hasHost` 解决不了。这修正了 §4.3 里"守卫替换即可"的乐观估计。

### 12.3 下一步（阶段 2 第一批）

1. `renderMessages` 家族参数化（渲染目标 + 会话），`renderToolMessage` 已是容器参数化可直接复用。
2. `viewHosts` 登记表与 `hostOf`；`hasHost` 改为查表（调用点不动）。
3. `bridge/bridge-sidechat-view.js` + 五处接线。
4. `switchSession` 重定向（§3.1）+ 三态（§5.2）。

第 4 项必须与第 3 项同批交付——重定向的落点就是标签页，单独上线会出现「切到母会话但支线无处可看」的中间态。

---

## 13. 实施记录（2026-11-17 · 阶段 2 遗留收口 + 阶段 3/4）

### 13.1 功能遗留（§5.2/§5.4/§6 的「仍未做」清单）

| 项 | 落点 | 说明 |
| --- | --- | --- |
| 标签页消息动作全放行 | `ai-panel.js` `sideChatClick` / `handleMessageClick` | 复制 / 分支 / 重试 / 回退 / 新建支线 / 带回 / 投递全部可用；审批类过滤保留。`regenerateLast(sessionOverride)` 会话参数化（不碰面板 composer，媒体附件随轮带给 `startSessionTurn`） |
| 标签页「编辑重发」 | `beginSideChatEdit` + `sendSideChatMessage(id, text, {editIndex})` + `bridge-sidechat-view.js` 输入框回填 | 截断延后到发送（`startSessionTurn` 的 `truncateAt`，与面板 pendingEdit 同语义）；原消息图片/视频暂存 `sideChatEditMedia`，发送时自动带回；待发送提示与 slash 提示走 `setHint` 粘滞（不被下一次 paintState 冲掉） |
| 带回主对话附 changes 摘要 | `ai-sidechat.js` `bringBackToParent` | 按 relPath 聚合支线 `.changes`，最多列 12 个文件（超出折叠计数），随 notice 正文带给母会话 |
| viewHosts 真表 | `ai-panel.js` 宿主登记（`sideChatHosts` / `sideChatHostsOf` / `hostContainer` / `stickHostScroll`） | 面板伪宿主（isPanel）随 `switchSession` 迁移、不进表；标签页宿主 `{root, body, refresh}` 由 `bridge-sidechat-view.js` 在 refresh 中登记、卸载时注销 |
| 增量路径宿主化 | `appendToolCard` / `refreshToolWrap` / `updateAskCountdown` | 落点由 `hostContainer(sessionId)` 决定：面板在前，否则第一个标签页容器；面板路径的滚动/结构通知保持原行为，标签页走近底跟随（80px） |
| 会话数据改动主动通知 | `notifySideChatHosts` | 回退确认 / 清空会话 / 压缩收尾三处触发宿主 `refresh`（`clearCurrentSession` 新增可选 session 参数，面板无参行为不变） |
| 标签页统计行 | `sideChatStatsOf` + `bridgeSideChatStats` + `.sidechat-stats` | 与面板底部统计行同口径：`sessionUsageTotals`（已搬进 ai-usage-ui.js）+ `estimateCurrentTokens(sessionOverride)`（附件只属于面板输入框，按会话估算时不计入） |
| 标签页 slash 子集 | `sideChatSlash` + `.sidechat-slash` | 只放行会话域命令 `/compact` `/clear` `/context` `/help`；模型/技能/计划等面板外壳命令给出明确提示。`startCompact` 新增 `flashNotify`（提示走 toast 而不是写进面板消息区） |
| 压缩中轮询 | `sideChatState.compacting` + bridge 轮询条件 | `streaming || compacting` 期间 400ms 重绘，压缩收尾由 `notifySideChatHosts` 补一次主动刷新 |

**A3（`--ai-sbw` 标签页实测）结论**：`--ai-sbw` 的全部消费者（style.css 5522/5527/5552/6732/9113/9122）都是 `#ai-panel` 作用域或面板堆叠区；标签页是 `.sidechat-root` 纵向 flex（composer 不覆盖消息区滚动条），**无消费者、无需按宿主实测**。审批卡在内容区宽度的排版仍需真机目视（headless 无法验收）。

### 13.2 抽取批次（阶段 3 V3/V4 + 阶段 4 M1–M5）

| 批次 | 去向 | 内容 |
| --- | --- | --- |
| V3 | `ai/ai-usage-ui.js`（新） | 本轮用量浮层 + 统计行弹层（会话/tokens）；`sessionUsageTotals`、`turnUsageTotal`、格式化三件套收编为唯一来源；ctx 弹层正文（`renderCtxPopover`）依赖过深留面板、经 ctx 注入。测试 `ai-usage-ui.test.mjs` 6 例 |
| V4 | `ai/ai-diff-view.js`（新） | LCS 行 diff / ± 统计 / 审批卡预览裁剪（`diffLinesOf` / `computeLineDiff` / `diffStats` / `buildDiffPreview`），调用点与 ai-tool-cards 的 ctx 注入零改动。测试 `ai-diff-view.test.mjs` 7 例 |
| M1 | `ai/ai-model-picker.js`（新） | 双层级模型选择器（搜索 / 账号分组 / 行内思考等级 / 会话上下文上限）；档位计算直接复用 `ai-config-model.js` 纯函数；面板保留 hoisted 转发（sessionListMod 构造期即引用）。搜索框走 `createInput`（表单控件基线守卫） |
| M2 | `ai/ai-composer.js`（既有） | 输入框右键编辑菜单（撤销/重做/剪切/复制/粘贴/全选）+ 剪贴板图片回读；composer ctx 增 `backend` |
| M3 | `ai/ai-session-disk.js`（既有） | `createAIConversationLog`：Markdown 构建（工具/ask/图片附件）+ 图片归档 + 400ms 防抖按会话串行排队；目录定位与配置经 ctx 注入；`queueLogSave` 在面板保持函数声明（sessionListMod 构造期传引用，const 箭头会 TDZ） |
| M4 | `ai/ai-manage-dialogs.js`（既有） | 对话框基建四件（`openAIDialog` / `closeAIDialog` / `dialogNode` / `dialogButton`）+ 浮窗顶层挂载（`attachDialogTop` / `detachDialogTop`）；浮窗折叠状态经 ctx 访问器；顺带删掉 openAIDialog 里重复的 attach/detach 两行（幂等重复，行为不变） |
| M5 | `ai/session-outline.js`（既有） | `createSessionOutlineController`：快照 / 视口吸附 / 跳转 / 高位通知；消息窗口（`renderWindows`）与重绘由宿主注入 |

验证：`npm test` **965/965**、`vite build` 通过（含 module-scope / 表单控件基线 / 测试清单守卫）；新增两个测试文件均已登记 `frontend/package.json`。

### 13.3 未做（附实测理由）

- **V1 / V5（消息渲染家族 → `ai/ai-session-view.js`）**：实测渲染家族在 `ai-panel.js` 内约 1700 行（emptyState / renderWindowState / renderMessagesInner / groupTurns / renderTurn / renderMessage / renderAppMessage / appendActions / renderPendingApprovalPlaceholder 等），外部依赖 30+ 项（跨 5 个模块 + 面板 10+ 项状态：streams / stickBottom / renderWindows / userFoldExpanded / appMsgExpanded / 面板单例 UI 等）。**超出 §7.2 自定的「>15 项 = 不搬」红线**；且 `turn-fold-redesign` 正在同域在途（轮折叠渲染正是本批要搬的核心），此时搬移会与之正面冲突。按 §7.6 的兜底：另立「消息区 / 底部堆叠 / 滚动与搜索」三段切分方案。V5 的落点即 V1 的模块，同批推迟。
- **V2（工具卡按钮态与审批交互）**：计划目标已在先前批次由 `ai-tool-cards.js`（工具卡渲染 / updateAssistantElement / ask 文案）与 `ai-takeover.js`（审批/提问接管区）收编；面板侧同名 `updateEntryButtons` 只剩 9 行面板按钮激活态，无 V2 语义，**无需再搬**。
- **实机验证**：审批卡 `.takeover-*` 在内容区宽度下的排版、标签页滚动行为需真机目视（见 13.1 A3 结论）。

### 13.4 本批文件面

新增：`ai/ai-usage-ui.js`、`ai/ai-diff-view.js`、`ai/ai-model-picker.js`、`test/ai/ai-usage-ui.test.mjs`、`test/ai/ai-diff-view.test.mjs`。
修改：`ai/ai-panel.js`（宿主登记 / 消息动作 / 统计 / slash / 抽取接线）、`ai/ai-sidechat.js`、`bridge/bridge-sidechat-view.js`、`ai/ai-composer.js`、`ai/ai-manage-dialogs.js`、`ai/ai-session-disk.js`、`ai/session-outline.js`、`style.css`（`.sidechat-stats` / `.sidechat-slash` / root 定位）、`frontend/package.json`（测试清单）。
