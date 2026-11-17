# app_control 集成会话重命名（ai_rename_session）（实施记录）

> 状态：**已完成**（2026-11-17 实施；`npm test` 891 项全绿、`ai-app-actions.test.mjs` 三方对账守卫通过。跨会话改名与重启保留待手动验收，见 §5）
> 决策依据：参考 DSH（deepseek-harness）的 `session.rename` RPC 端点设计——DSH 把会话重命名做成**正式的 RPC 业务命令**（`@Remote('rename')`），UI 与客户端统一走它；CaDt-DataLens 现有 `app_control` 已有 `ai_new_session` / `ai_switch_session` 两个会话动作（走 `aiPanel.bridgeXxx` 桥接），重命名可完全照此模式接入，成本约 25 行
> 范围：`app_control` 新增 `ai_rename_session` 动作；`ai-panel.js` 新增 `bridgeRenameSession` 桥接；复用现有 `renameSession` 语义（改 `session.title` + 持久化 + 渲染）

## 0. 与方案的偏离（实施时发现）

1. **懒加载 stub 会话先补正文再改名（方案没有，实施补上）**：改名后 `queueLogSave` 会把 md 日志写盘，对 `_stub` 会话（正文未载入、`messages` 恒为空数组）直接写盘会把「空内容」当真源写出去——`switchSession` / `exportSession` / 清空会话都已有同款护栏。`bridgeRenameSession` 照 `bridgeSwitchSession` 先例：`target._stub` 时先 `ensureSessionLoaded`，失败抛错不落盘。
2. **目标 §2.4 在方案成文时即已存在**：`bridgeGetState` 返回的 `session` 对象早已含 `id`，`get_ai` 无需补字段；实施时只把 cadt-ui 技能表 `get_ai` 行的文案补上 id（`会话信息（id/标题/…）`），让模型知道从哪拿 id。
3. **动作表位置**：方案 §3.3 写的 `docs/skills/cadt-ui/SKILL.md` 已迁入 `ai-constants.js` 的 cadt-ui 技能「动作表」段（三方对账守卫 `frontend/test/ai/ai-app-actions.test.mjs` 自动核对）。方案内其余行号均为评估日快照，以实施日代码为准。
4. **无新增单测**：桥接是闭包内函数（依赖 `sessions`/`persistSessions` 等闭包状态），与 `bridgeNewSession` / `bridgeSwitchSession` 先例一致不做单测；登记一致性由三方对账守卫覆盖，行为靠 §5 手动验收。
5. **`id` 可省略，缺省改调用者自己的会话（2026-11-17 当日演进 + 修正）**：最常见的用法是 AI 改自己所在会话的标题，不必先 `get_ai` 拿 id。`executeTool` 的 app_control 分支把调用者自己的会话 id 作为 `runAppAction` 第 4 参注入（`ctx.session.id`），桥接的目标解析优先级为「**显式 id > 调用者自己的会话 > 面板当前查看的会话（兜底）**」——后台会话（用户已切到别的会话）改自己标题不会误改前台会话。同步修正 `get_ai`：`bridgeGetState(callerSessionId)` 返回 `callerSessionId` / `viewingSessionId` / `callerIsBackground`，`session` 块明确标注为「面板当前查看的会话」，调用者不在前台时模型据 `callerIsBackground` 辨识、要改自己标题用 `callerSessionId`。动作表签名改为 `{title,id?}`，`get_ai` 与 `ai_rename_session` 两行文案同步标明该语义；`get_state` 的会话列表同步返回 `caller` 标记（`active` 只是面板当前查看的会话），其动作表文案同样注明。**刻意不做每轮 `<workspace_context>` 会话 id 注入**（同期评估后移除）：模型不需要自己的 id——改自己靠宿主动注入（`runAppAction` 第 4 参），改别人要用别人的 id，面板/自己的消歧由 `get_ai` 的 caller 字段按需完成；每轮注入是纯冗余 token（随用户消息落盘、长会话历史累积）。

## 1. 背景与现状（代码事实）

- **应用已有重命名功能，但仅用户手动可触发**：
  - 右键会话列表项 → 「重命名会话…」（`frontend/src/ai/ai-session-list.js:519`）
  - 标题栏菜单 → 「重命名会话…」（`frontend/src/ai/ai-panel.js:10716`）
  - 实现：`renameSession(target)`（`frontend/src/ai/ai-panel.js:11428`）——弹命名对话框（`showNameDialog` 或 `window.prompt` 兜底），改 `session.title`（截断 60 字符）→ `persistSessions()` → `renderSessionList()` → `queueLogSave(session)`。
- **AI 无法触发它**：`renameSession` 在 `createAIPanel` 返回对象里（`ai-panel.js:2361`），但没有桥接到 `app_control` 的动作表（`main.js:437-446` 的 `APP_ACTIONS` 无重命名动作）；`app_control` 不模拟鼠标点击，右键菜单项无法触发。
- **现有会话动作模式**（照抄即可）：
  - `ai_new_session` / `ai_switch_session` 在 `main.js:957-967` 的 `runHostAppAction` case 里，通过 `aiPanel.bridgeNewSession` / `aiPanel.bridgeSwitchSession` 调用面板内部函数。
  - 桥接实现：`ai-panel.js:13739-13764`（`bridgeNewSession` / `bridgeSwitchSession`），都是「查会话 → 改状态 → 持久化 → 渲染 → 返回 `{id, title}`」。
- **DSH 参考实现**（`D:\OraSkyC\Project\OpenSource\deepseek-harness`）：
  - 服务端：`SessionCommandController.rename`（`packages/api/session-controller/src/commands.ts`）→ `SessionTitleService.rename`（`packages/session/session-title/src/index.ts`），追加 `session/title` 日志事件（`source: {kind:'user'}`，pin 住自动生成）。
  - RPC 端点：`@Remote('rename')`（`packages/api/session-controller/src/index.ts`）。
  - 客户端：`ISession.rename(title)`（`packages/api/session-controller/src/client/contract/session.ts`）；UI 触发链：右键会话 → `session/rename` 端点权限 → `requestSessionRename(sessionId, displayTitle)` → `SessionRenameDialog` → `session.rename(title)`（`packages/client/ui-workspace/src/client/index.ts`）。
  - 归一化：`normalizeSessionTitle`（去控制字符/折叠空白/UTF-8 截断）；空标题拒绝（`SessionTitleInvalidError` → RPC `session/title-invalid`）。

## 2. 目标与非目标

### 目标

1. `app_control` 新增 `ai_rename_session {title, id?}` 动作：AI 可直接重命名会话标题（id 可省略，缺省改调用者自己的会话，见 §0.5）。
2. 复用现有 `renameSession` 的语义（改 `session.title`、截断 60 字符、持久化、渲染、写盘），不引入新存储结构。
3. 参数校验与 DSH 对齐：`id` 必须命中现有会话；`title` 非空、截断 60 字符。
4. **`get_ai` 返回会话 id**（用户决策 2026-11-16）：~~AI 调用 `ai_rename_session` 前需要会话 id 定位目标——`get_ai` 现有返回含标题/消息数/轮次/工作区，**需补会话 id 字段**~~。**实施核对：`bridgeGetState` 的 `session` 对象早已含 `id`，无需补字段**；只把技能表 `get_ai` 行文案补上 id（见 §0.2）。
5. **同步 `ai_new_session` 空会话复用重命名**（用户决策 2026-11-16）：现有 `bridgeNewSession` 在空会话复用时已隐式改标题（`ai-panel.js:13747`），与 `bridgeRenameSession` 语义一致，确认无需改动。

### 非目标

- **不改标题存储结构**：CaDt-DataLens 的会话标题是 `session.title` 字段（JSONL 会话文件），不是 DSH 的 `session/title` 日志事件——本方案不迁移到事件模型（成本高、收益低，现有持久化已足够）。
- **不做自动标题生成**：DSH 有 LLM 自动生成标题（`session-title-llm`），CaDt-DataLens 标题来自首条消息，本方案不引入自动生成。
- **不做权限控制**：DSH 的 `session/rename` 有 `remoteAccess` 端点权限；CaDt-DataLens 的 `app_control` 已由「AI 工具权限」开关统一控制（`appControlOn()`），不细粒度到单个动作。
- **不做标题归一化的控制字符清洗**：DSH 的 `normalizeSessionTitle` 去 ANSI 转义/控制字符；CaDt-DataLens 现有 `slice(0,60)` 已够用，标题是用户/AI 输入的普通文本，风险低。

## 3. 设计（实施注记：动作表现驻 `ai-constants.js` 的 cadt-ui 技能「动作表」段；下文行号为 2026-11-16 评估快照）

### 3.1 桥接方法（`ai-panel.js`）

照 `bridgeSwitchSession`（`ai-panel.js:13754`）模式，在 `createAIPanel` 返回对象里新增：

```js
bridgeRenameSession: async (id, title, callerSessionId) => {
    if (typeof renameSession !== 'function') throw new Error('会话桥不可用');
    const wanted = String(id || '').trim();
    const caller = String(callerSessionId || '').trim();
    // 目标优先级：显式 id > 调用者自己的会话 > 面板当前查看的会话（兜底，见 §0.5）
    const target = wanted
        ? sessions.find((s) => s.id === wanted)
        : (caller ? sessions.find((s) => s.id === caller) : null) || currentSession();
    if (!target) throw new Error(wanted ? '找不到会话：' + wanted : '当前没有可重命名的会话');
    const next = String(title || '').trim();
    if (!next) throw new Error('会话名称不能为空');
    target.title = next.slice(0, 60);
    persistSessions();
    renderSessionList();
    queueLogSave(target);
    return {id: target.id, title: target.title};
},
```

- 直接改 `session.title`，**不弹命名对话框**（AI 调用无 UI 交互，`renameSession` 的对话框路径不适用）。
- `queueLogSave` 触发会话落盘（与 `renameSession` 一致）。
- 返回 `{id, title}`，与 `bridgeSwitchSession` 返回形态一致。

### 3.2 动作表与分派（`main.js`）

- `APP_ACTIONS`（`main.js:437`）新增 `'ai_rename_session'`。
- `runHostAppAction` 新增 case（照 `ai_switch_session`，`main.js:962-967`）：

```js
case 'ai_rename_session': {
    if (!aiPanel || !aiPanel.bridgeRenameSession) throw new Error('AI 面板未初始化');
    // callerSessionId 由 runAppAction 第 4 参统一注入（来自 executeTool 的 ctx.session）
    return {renamed: await aiPanel.bridgeRenameSession(p.id, p.title, callerSessionId)};
}
```

- 参数：`p.title`（新标题，必填非空）、`p.id`（会话 id，**可选**；省略时改调用者自己的会话，见 §0.5）。

### 3.3 技能文档（`cadt-ui`）

> 实施注记：动作表已从 `docs/skills/cadt-ui/SKILL.md` 迁至 `frontend/src/ai/ai-constants.js` 的 cadt-ui 技能「动作表」段，实际落点为该处。

动作表补一行（实际实施文案略详，见 `ai-constants.js`）：

```
- ai_rename_session {title,id?}：重命名 AI 会话标题（不传 id 改调用者自己所在的会话；title 非空、截断 60 字符）。
```

## 4. 工作量与体量估算

| 位置 | 内容 | 估算 |
| --- | --- | --- |
| ai-panel.js | `bridgeRenameSession` 桥接（约 12 行） | ~12 行 |
| main.js | `APP_ACTIONS` 加一项 + `runHostAppAction` case（约 6 行） | ~8 行 |
| main.js | `get_ai` 补会话 id 字段（目标 §2.4） | ~5 行 |
| cadt-ui/SKILL.md | 动作表补一行 | ~3 行 |
| 测试 | 桥接的会话查找/空标题/截断边界（表驱动） | ~40 行 |

合计约 68 行，零新依赖。

## 5. 测试与验收

- 纯逻辑：`bridgeRenameSession` 的会话查找（命中/未命中）、空标题拒绝、60 字符截断、持久化与渲染调用。
- 手动验收：`app_control ai_rename_session {id, title}` 后，会话列表标题更新、重启后标题保留（JSONL 已落盘）。
- 手动验收：**不传 id** 调 `ai_rename_session {title}` → 改名的是调用者自己的会话；用户切到其他会话后由后台会话调用 → 改的仍是后台会话自己，不误改前台（§0.5）。
- 手动验收：`get_ai` 返回 `callerSessionId` / `viewingSessionId` / `callerIsBackground`；后台调用时 `callerIsBackground=true`，前端会话的 `session` 块是面板当前查看的会话。
- 手动验收：`app_control get_ai` 返回的会话信息含 `id` 字段（目标 §2.4）。
- 回归：现有 `ai_new_session` / `ai_switch_session` 不受影响。

## 6. 未决项与后续

1. ~~**是否需要 `get_ai` 返回会话 id**~~：已纳入目标 §2.4（用户决策 2026-11-16）。
2. ~~**是否同步 `ai_new_session` 空会话复用重命名**~~：已确认无需改动（用户决策 2026-11-16），纳入目标 §2.5。
3. **DSH 的 `session/title` 事件模型**（留作后续实现）：当前 CaDt-DataLens 标题是普通字段，事件模型能获得「可回放/pin 自动生成」能力，但成本高（会话存储迁移），且无自动生成需求——**暂不引入，留作长期演进观察**。若未来引入，需评估：会话存储从 JSONL 字段迁移到事件模型、自动标题生成 provider、`session/title` 投影折叠。**本方案实施时仅记录此后续项，不阻塞当前 `ai_rename_session` 落地。**
