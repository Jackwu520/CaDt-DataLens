# 文案中立化全量扫描报告

> 扫描对象：CaDt-DataLens 工作区文案
> 扫描范围：`docs/`、根目录 `README.md` / `CHANGELOG.md` / `AGENTS.md`、全部 `*.go`（含 `internal/**`）、`frontend/**`
> 扫描方式：四路并行全量检索 + 逐条读上下文人工判定（非抽样）
> 扫描环境：隔离工作区（从主根 HEAD 0fe8259 干净检出），扫描阶段只读
> 落地状态：**全部建议项已修改完成并回灌主根**（详见文末「六、落地结果」）
> 说明：下列 `path:line` 为扫描时的行号（基于 HEAD 0fe8259）；主根工作树另有未提交改动，实际行号可能不同，以文案内容为准。

---

## 一、判定标准

目标是找出「**客观陈述 / 工具结果 / 状态标签 / 文档说明里，用第二人称主观人称指代用户**」的文案，这类应改为第三人称「用户」（典型：`你已批准` → `用户已批准`）。

**计入（应中立化）**
- 状态标签 / 工具卡片结果：`（你已批准）`、`你跳过了回答`、`你的消息`
- 系统生成的说明 / 注入文案：`等待你填写变量值`、`由你完成`、`来自你`
- 文档（CHANGELOG / README / 方案）叙述中客观描述用户行为：`你还没看`、`都是你主动点击`、`你手点掉了`

**不计入（正常）**
- 系统提示词 / 工具描述里「你」指代 AI 自身：`你是 CaDt-DataLens 桌面应用内的 AI 助手`、`你的工具范围`
- 直接对用户说话的 UI 文案：`输入你的回答`、`AI 需要你的回答`、`将以你的权限执行`（确认框）
- 人设 / 拟人化文案：甜澄「等你点头」「帮你摊平」
- 法律协议的「您」（terms.md 明文定义「您（以下简称'用户'）」，属规范直接称呼）
- 测试 fixture / 断言里的「你好」「轮到你」「来自你」
- 英文 `layout` 中的 `you` 子串、`purpose` 等误命中；CSS 注释；第三方许可证

---

## 二、汇总

| 区域 | 应中立化（行级） | 说明 |
| --- | --- | --- |
| 前端 AI 域（`frontend/src/ai/`） | 19 处（7 明确 + 12 边界） | 涉及 11 个文件 |
| 前端其他域（`frontend/` 除 ai） | 13 行（19 处「你」） | `index.html` 12 行 + `main.js` 1 行注释 |
| Go / internal | 0 | 唯一候选是对话确认框，属正常 |
| 文档方案（docs / README / CHANGELOG） | 29 行（约 38 处短语） | CHANGELOG 10 / README 7 / finished-plans 10 / 其他 2 |
| **合计** | **61 行级命中（约 76 处短语）** | 边界项全部纳入修改 |

---

## 三、分区域明细

### A. 前端 AI 域

#### A1. 明确应改（与同文件相邻文案的中立口径明显冲突）

| 位置 | 原文 | 改后 |
| --- | --- | --- |
| `frontend/src/ai/ai-panel.js:4769` | （你已批准；本会话同类命令已记住） | （用户已批准；本会话同类命令已记住） |
| `frontend/src/ai/ai-panel.js:4771` | （你已批准；已记住本次授权） | （用户已批准；已记住本次授权） |
| `frontend/src/ai/ai-panel.js:4773` | （你已批准） | （用户已批准） ← 用户给出的典型示例，`approvalTraceNote` 工具卡片状态 |
| `frontend/src/ai/ai-panel.js:4639` | 由应用自动注入 · **你发出的消息**，AI 按这条指令执行 | 由应用自动注入 · **用户发出的消息**，AI 按这条指令执行（同组 4637/4642 均为第三人称叙述） |
| `frontend/src/ai/ai-tool-cards.js:471` | `if (ask.state === 'skipped') return '你跳过了回答';` | `'用户跳过了回答'`（同函数 466–472 均为中立叙述） |
| `frontend/src/ai/ai-tool-cards.js:434` | 等待你在下方输入区填写变量值… | 等待**用户**在下方输入区填写变量值…（同语义在 `ai-panel.js:7206` 已写「等待用户填写变量值」，口径不一） |
| `frontend/src/ai/ai-quote.js:79` | `quote.source === 'user' ? '你的消息' : '助手回复'` | `'用户消息'`（对照标签「助手回复」为第三人称） |

#### A2. 边界项（系统生成标签 / 说明里指代用户，已一并中立化）

| 位置 | 原文 | 改后 |
| --- | --- | --- |
| `frontend/src/ai/ai-agent-notices.js:357` | `'系统通知 · 来自你'` | `'系统通知 · 来自用户'` |
| `frontend/src/ai/ai-agent-notices.js:359` | `('用户消息' + (senderRef ? ' · ' + senderRef : ' · 来自你'))` | `' · 来自用户'` |
| `frontend/src/ai/ai-agent-notices.js:362` | `'［系统通知 · 来自你］'` | `'［系统通知 · 来自用户］'` |
| `frontend/src/ai/ai-agent-notices.js:366` | `'［用户消息 · 来自你］这是用户本人发给你的消息…'` | 头部改 `来自用户`（同句尾部「发给你的消息」的「你」= AI，保留） |
| `frontend/src/ai/ai-app-message.js:72` | `label: '用户消息 · 来自你'` | `label: '用户消息 · 来自用户'` |
| `frontend/src/ai/ai-app-message.js:73` | `label: '系统通知 · 来自你'` | `label: '系统通知 · 来自用户'` |
| `frontend/src/ai/ai-panel.js:11709` | 不再询问，可自由访问你的文件、终端和网络 | …可自由访问**用户**的文件、终端和网络 |
| `frontend/src/ai/ai-panel.js:11772` | 调用你已启用的插件或连接应用 | 调用**用户**已启用的插件或连接应用 |
| `frontend/src/ai/ai-panel.js:8289` | 环境变量键（值由你填写）： | 环境变量键（值由**用户**填写）： |
| `frontend/src/ai/ai-ask-cards.js:85` | 值由你亲自输入，AI 看不到；保存后注入终端与命令桥。 | 值由**用户**亲自输入，AI 看不到；… |
| `frontend/src/ai/ai-settings-dialog.js:1009` | 个性化学习：已开启（学习你在端侧审批卡上的裁定） | （学习**用户**在端侧审批卡上的裁定） |
| `frontend/src/ai/ai-session-list.js:97` | `pending: '待确认：需要你审批或回答'` | `'待确认：需要用户审批或回答'` |

#### A3. 前端 AI 域内判定为正常的类别（约 180 处，不逐一列出）

- 系统提示词 / 工具描述里「你」= AI 自身：`ai-constants.js`、`ai-group-model.js`、`ai-group-runtime.js`、`ai-subagents.js`、`ai-system-context.js`、`ai-tool-defs.js`、`ai-tool-cards.js:1605`、`ai-worktree.js:533`、`ai-panel.js:6775/6782/10054`、`ai-message-queue.js` 等
- 工具返回值中「你」= 调用方 AI：`ai-panel.js:8882/8961/9135/9232`
- 直接对用户说话的 UI：`ai-ask-cards.js:73/269`、`ai-panel.js:5792/6456/7216/7469/8290/10809`、`ai-mcp-settings.js:399`、`ai-slash.js:247/248/261/262`、`ai-takeover.js:737`
- 人设 / 拟人化：`ai-mascot-phrases.js:17/18/19`、`ai-persona.js:19/21`
- 代码注释、非用户可见：`ai-agent-notices.js:354`、`ai-app-message.js:19`、`ai-notify-policy.js:5/26`、`ai-panel.js` 多处、`ai-subagents.js` 多处等
- 正则匹配用户输入：`ai-patch-policy.js:12`（`听你的`）
- 团队树文本中「你」= 读取方代理：`ai-team-model.js:114/145/150/153/162`
- UI 自指标签：`ai-group-model.js:34`（我来主持）、`ai-group-sidebar.js:111`（我主持）
- 误命中：`ai-panel.js:294/8721/...` 的 `onLayout/layout`、`ai-tool-defs.js:847` 的 `purpose`

---

### B. 前端其他域（几乎全部集中在 `frontend/index.html`）

| 位置 | 原文片段 | 改后 |
| --- | --- | --- |
| `frontend/index.html:733` | data-tip「服务器命令在本机执行，等同于你自己运行它」 | 等同于**用户**自己运行它 |
| `frontend/index.html:739` | set-desc「环境变量值与工具授权仍由你完成」 | 仍由**用户**完成 |
| `frontend/index.html:970` | data-tip「审批 / 失败 / 提问在「你看的不是这条会话」时」；「AI 也能用 notify_send 工具给你发消息」 | 「**用户查看**的不是这条会话」时；工具**给用户**发消息 |
| `frontend/index.html:970` | set-desc「审批 / 失败 / 提问：不是你正看的会话时右下角弹」 | 不是**用户正查看**的会话时右下角弹 |
| `frontend/index.html:1001` | data-tip「等你点「批准」时提醒你…只有你「正看着这个会话且软件在前台」时不打扰」 | 等**用户点**「批准」时**提醒用户**…只有**用户**「正看着…」时不打扰 |
| `frontend/index.html:1017` | data-tip「工具执行 / 等待你回答期间不会误杀」 | **等待用户回答**期间 |
| `frontend/index.html:1083` | set-desc「助手名、对你的称呼、长期指令、人设正文属于个人内容」 | **对用户的称呼** |
| `frontend/index.html:1102` | set-title「对你的称呼」；set-desc「助手怎么称呼你；留空则不臆造称呼」 | **对用户的称呼**；助手怎么**称呼用户** |
| `frontend/index.html:1104` | aria-label「助手对你的称呼」 | 助手**对用户的称呼** |
| `frontend/index.html:1501` | data-tip「你在审批卡上的允许 / 拒绝才作为裁决信号回流…你的裁定解决「谁对谁错」」；set-desc「结论一致时你的操作不学习」 | **用户在**审批卡上的…；**用户的裁定**…；结论一致时**用户操作**不学习 |
| `frontend/index.html:1693` | data-tip「env_create 由 AI 提供名称与描述、值由你在弹窗中亲自填写」 | 值**由用户在弹窗中填写** |
| `frontend/index.html:1733` | set-desc「插件代码以与应用相同的权限运行…仅安装你信任的来源」 | 仅安装**用户信任**的来源 |
| `frontend/src/main.js:2695` | 注释「消息中心投递回调：notify_send 工具与「需要你处理」的通知都走这里」 | 「**需要用户处理**」的通知 |

**前端其他域判定为正常（部分）**：`settings-pane-plugins.js:143/549`「仅安装你信任的来源」在确认对话框中，直接对用户说话；`terminal/run-ui.js:74`「将以你的 Windows 账户权限…只运行你自己写的」为确认弹窗；`dev/mock-backend.js` 的「我来…」为 AI 第一人称模拟；`style.css:8410` 注释；`test/ai/*.test.mjs` 的测试 fixture。

---

### C. Go / internal

**应中立化：0 处。**

唯一实质候选 `internal/runproject/runproject.go:127`「命令以你的 Windows 账户权限执行」是运行项目确认弹窗文案（前端展示给用户请求确认），属直接对用户说话，判定为正常。

其余命中均为测试 fixture（`你好`）、代码注释里指代开发者 / 应用自身的「我们 / 本人」、以及 `layout` / `purpose` 子串误命中，全部正常。

---

### D. 文档方案

#### D1. CHANGELOG.md（10 行）

| 位置 | 原文片段 | 改后 |
| --- | --- | --- |
| `CHANGELOG.md:168` | 别的会话可掐掉你的计时器 | 掐掉**用户的**计时器（客观描述旧 bug） |
| `CHANGELOG.md:227` | 卡片标注「用户消息 · 来自你」 | 来自**用户** |
| `CHANGELOG.md:229` | 卡片「来自你」两例 | 来自**用户** |
| `CHANGELOG.md:339` | 「这一轮跑完了、你还没看」这件事 | 用户还没看 |
| `CHANGELOG.md:608` | 设定它对你的称呼；人设框非空则以你写的为准 | 对**用户的**称呼；以**用户写的**为准 |
| `CHANGELOG.md:685` | 端侧审批卡上你的显式批准 / 拒绝回流样本 | **用户的**显式批准 / 拒绝 |
| `CHANGELOG.md:819` | 提示「以你的权限在本机执行代码」 | 以**用户的权限** |
| `CHANGELOG.md:918` | 或「你已批准」 | 「**用户已批准**」 |
| `CHANGELOG.md:927` | 暂停跟随（保留你看的位置） | 保留**用户看的位置** |
| `CHANGELOG.md:945` | 带「你 / AI」来源标记 | 「**用户 / AI**」 |

#### D2. README.md（7 行）

| 位置 | 原文片段 | 改后 |
| --- | --- | --- |
| `README.md:59` | 都是你主动点击、走确认弹窗 | 都是**用户**主动点击 |
| `README.md:99` | 由你决定是否发送 | 由**用户**决定 |
| `README.md:109` | 不动你自己的权限 | 不动**用户自己的**权限 |
| `README.md:120` | 或你在对话里点名、已授权目录下的图片 | 或**用户在**对话里点名 |
| `README.md:130` | 不切走你正在看的会话 | 不切走**用户**正在看的会话 |
| `README.md:131` | 或「你已批准」 | 「**用户已批准**」 |
| `README.md:133` | 设定它对你的称呼 | 对**用户的**称呼 |

#### D3. docs/finished-plans（10 行）

| 位置 | 原文片段 | 改后 |
| --- | --- | --- |
| `docs/finished-plans/ai-panel.md:33` | 每条带来源标记（你 / AI） | （用户 / AI） |
| `docs/finished-plans/ai-panel.md:322` | 或 `你已批准`（含…后缀） | `用户已批准` |
| `docs/finished-plans/ai-patch-approval.md:28` | 让 AI 帮你应用 | 让 AI 帮**用户**应用 |
| `docs/finished-plans/ai-patch-approval.md:251` | 你选了 3 个文件…为了让你在发起请求前划清范围…让系统替你悄悄缩小范围 | 全部改「用户」 |
| `docs/finished-plans/ai-patch-approval.md:552` | 而不是让你先手动按保存 | 让**用户**先手动按保存 |
| `docs/finished-plans/ai-patch-approval.md:689` | 消灭了你担心的场景…预览时你看到位置 A…让你重新看一遍 | 全部改「用户」 |
| `docs/finished-plans/ai-patch-approval.md:706` | 应用后你又手工改过 | 应用后**用户**又手工改过 |
| `docs/finished-plans/ai-patch-approval.md:884` | 提示「…你的未保存内容基于旧版本」 | **用户的**未保存内容 |
| `docs/finished-plans/run-code.md:263` | 「将以你的权限在本机执行该文件，仅运行你信任的代码」 | 以**用户的权限**…**用户信任的**代码 |
| `docs/finished-plans/mcp-client.md:644` | 「该命令会在本机执行，等同于你自己运行它」 | 等同于**用户**自己运行它 |

#### D4. docs 其他（2 行）

| 位置 | 原文片段 | 改后 |
| --- | --- | --- |
| `docs/mcp-samples/README.md:22` | 等同于你自己运行它 | 等同于**用户**自己运行它 |
| `docs/reports/feature-verification.md:237` | 实际是你手点掉了几个胶囊把计数降了下来 | 实际是**用户**手点掉了几个胶囊 |

#### D5. 文档内判定为正常的类别（约 100+ 处，不逐一列出）

- 对 AI 智能体说话的系统提示词：`docs/finished-plans/ai-group-chat.md`、`session-messaging.md`、`subagent-sandbox.md`、`ai-panel.md:457`、`ai-panel-v2.md:165`、`ai-turn-steering.md`（英文 while you were working）、`mcp-client.md:844`、`side-chat-tab.md:221`
- 甜澄人设：`docs/finished-plans/ai-personalization.md:182/184`
- 技能文件对 AI 说话 / 英文 you-your：`docs/skills/**`
- 教程式直接指令 / FAQ：`docs/skills/README.md:25`、`chinese-formal-document-format/**`
- 测试计划里对执行者的直接称呼：`docs/reports/session-messaging-test-plan.md`、`session-messaging-manual-checklist.md`
- 法律合同「您」：`docs/legal/privacy.md`、`terms.md`
- 引述的现成 UI / 系统字符串：`docs/packaging.md:205`、`ai-assistant-review.md:159`、`CHANGELOG.md:289`
- UI 功能名 / 字段标签：「仅你可见」「我来主持」「对你的称呼」（字段名，与 CHANGELOG/README 的叙述性描述不同）
- 占位符 / 示例代码 / 用户原话举例：`docs/plugins/**`、`docs/samples/**`、patch 方案中的用户 utterances

---

## 四、联动提醒（改一处必须同步，否则失配）

1. **「来自你」是「生成 + 识别 + 测试」三件套**
   - 生成：`ai-agent-notices.js:357/359/362/366`
   - 识别：`ai-app-message.js:72/73` 的正则 `/^［用户消息 · 来自你］/`、`/^［系统通知 · 来自你］/`
   - 测试 fixture：`frontend/test/ai/ai-app-message.test.mjs:44/45`、`ai-agent-notices.test.mjs`、`ai-session-send.js` 注释
   - 若改生成侧文案，**识别正则和测试 fixture 必须一起改**，否则卡片类型检测失效、测试失去意义。

2. **「你已批准」跨代码与文档**
   - 生成侧：`ai-panel.js:4769/4771/4773`
   - 引用侧：`CHANGELOG.md:918`、`README.md:131`、`docs/finished-plans/ai-panel.md:322`
   - 需保持一致口径。

3. **同义口径统一**
   - `ai-tool-cards.js:434`、`ai-panel.js:8289`、`ai-ask-cards.js:85` 改后与既有的「等待用户填写变量值」「值由用户填写」（`ai-panel.js:9232`、`ai-tool-defs.js:830`）对齐。

4. **「对你的称呼」区分对待**
   - 叙述性描述（`index.html:1083`、`CHANGELOG.md:608/133` 等）已中立化为「对用户的称呼」；
   - 作为设置项**字段名 / 标题**的 `index.html:1102/1104` 也一并改了（字段名文案，未涉及存储键 `ai-persona-user-label`）。

---

## 五、统计口径说明

- 行级命中合计 **61 行**；按短语计约 **76 处**（部分行含 2–3 个需改短语，如 `ai-patch-approval.md:251/689`、`run-code.md:263`、`CHANGELOG.md:608`）。
- 边界项（A2 全部 + `main.js:2695` + `ai-session-list.js:97`）全部纳入修改。
- 明确应改的「硬命中」约 **49 行**，其中 A1 的 3 处「你已批准」与用户给出的示例完全对应。
- 判定为正常、明确排除的命中约 **280+ 处**，涵盖系统提示词、直接对话 UI、人设、法律协议、测试 fixture、误命中。

---

## 六、落地结果

- **修改文件 22 个**：14 个通过补丁回灌主根（docs 类 + `ai-quote.js` / `ai-ask-cards.js` / `ai-session-list.js` / `ai-session-send.js` / `ai-settings-dialog.js` + 3 份测试 fixture）；8 个因主根存在大量未提交改动、补丁上下文冲突，按用户选择「手动合并」逐个 `edit_file` 精确应用（`CHANGELOG.md`、`README.md`、`index.html`、`ai-panel.js`、`ai-agent-notices.js`、`ai-app-message.js`、`ai-tool-cards.js`、`main.js`），未覆盖任何已有改动。
- **验证**：改动相关测试 68 项全过（含「来自你」识别正则与测试 fixture 的联动守卫）；全局复查旧文案零残留，58 处新文案到位。
- **未改动**：`frontend/dist/` 构建产物仍含旧文案，需重新构建 exe 才会更新（遵循「构建产物由构建工具写」的约定）。
- **隔离区**：验证收尾后已 discard；主根所有改动保留在工作树，未提交。
