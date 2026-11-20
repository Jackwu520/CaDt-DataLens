# 用户消息原地编辑（正文 + 附件就地增删）

> 状态：**已实施**（2026-11-19 立项当日落地）
> 一句话：点消息上的「编辑」，气泡就地变成编辑区（正文 + 附件 chips），不再把内容灌回底部输入框；保存 = 截断这条及之后并重新发送。

## 1. 需求与决策（作者拍板）

| 问题 | 决策 |
|---|---|
| 保存后怎么处理后续对话 | **截断这条及其之后并重新发送**（与既有「编辑重发」同一语义，不会出现「正文变了但模型基于旧正文回答」的错位） |
| 允许编辑哪些消息 | **任意一条用户亲手键入的消息**；非最后一条保存前二次确认「将丢弃后面 N 条对话」 |
| 附件编辑范围 | 图片 / 视频 / 引用可删可加；**文件类附件从本次改动起可完整编辑**（新增落盘快照），历史消息里的文件附件已固化进 `<attachments>` 环境块，只能加不能改，并显示说明 |

## 2. 交互

- 入口：用户消息悬停操作栏的「编辑」（`ai-panel.js` 的 `appendActions`），由「仅最后一条」放开到任意一条。
- 编辑态（`.ai-msg.user.editing`）：占满整行（解除气泡的收缩宽度），`textarea` 自动高度（88–520px，首帧用 rAF 再量一次，避免挂载时宽度未定算不出换行）＋ 附件 chips（每个带 ×，图片可点开大图）＋「＋ 添加」＋「取消 / 发送」。
- 附件输入：`＋ 添加` 走文件对话框；`Ctrl+V` 直接粘贴图片 / 视频（复用输入区的 `attachmentsFromDataTransfer`：源准入整批校验 + 降采样 / 视频校验），纯文本粘贴不拦截。
- `Esc` 取消、`Enter` 发送、`Shift+Enter`（或 `Alt+Enter`）换行；中文输入法组词中的回车不算发送（与输入区同一判定）。含 `Ctrl/Cmd+Enter` 在内的其它 Enter 组合也发送。
- 非末条保存的「将丢弃后面 N 条对话」确认框：`Enter` / 单击发送照旧弹出；`Ctrl/Cmd+Enter` 或 `Ctrl/Cmd+单击`发送则跳过确认、直接编辑重发（作者裁定，省去「我已确定要丢弃」的重复点击）。
- 互斥：会话生成 / 压缩中不给入口；同时只有一条消息处于编辑态；整面重画（`renderMessages`）与切换会话都会退出编辑态（切换时 flash 一次）。
- 保存失败（超阈 / busy / 图片超限 / 视频协议 / 租约）：编辑态与内容原样保留，改完可再试。

## 3. 数据格式

用户消息新增 `message.attachments` 快照（只存文本类附件）：

```js
message.attachments = [
  {kind: 'file',      label: 'a.js', path: 'D:/w/a.js', content: '…'},
  {kind: 'skill',     label: 'code-review', content: '…'},
  {kind: 'selection', label: 'src/x.js 10-20', path: '…', content: '…'},
]
```

- **图片 / 视频不进快照**：继续用 `message.images` / `message.videos`（落盘时已外置成 `images/`、`videos/` 文件引用）。
- **引用不进快照**：继续从 `content` 的 `<quote>` 前缀解析（旧消息也认，`splitQuotePrefix`）。
- **content 照存**：编辑保存时原样重建，不做隐式重新读盘（文件可能已改 / 已删 / 无权限）。代价是这条消息的环境块与快照各存一份，上限受现有文本附件约束（单文件 64 KB、单条 256 KB）。
- 落盘：`serializeSessionMessage` 是通用白名单（`_` 前缀之外全透传），新字段**自动进 JSONL，无需改序列化**；`normalizeMessage` 是显式白名单，加了 `normalizeMessageAttachments` 回填（kind 白名单 / 长度截断 / 数量封顶 40）。

## 4. 实现落点

| 文件 | 内容 |
|---|---|
| `frontend/src/ai/ai-inline-edit.js`（新） | 纯数据层：`normalizeMessageAttachments` / `inlineEditPayload` / `snapshotFromAttachments` + 常量 |
| `frontend/src/ai/ai-composer.js` | 抽出并导出 `renderAttachmentChips(container, items, handlers)`（`renderAttachments` 改为调用它）；把三个 `attachXxxPath` 拆成「构造」+「入输入区」，导出 `pickAttachmentFiles()` 供编辑区复用同一条附件链 |
| `frontend/src/ai/ai-panel.js` | `canInlineEdit` / `inlineAttachmentsOf` / `beginInlineEdit` / `endInlineEdit` / `renderInlineEditor` / `renderInlineAttachments` / `addInlineAttachments` / `saveInlineEdit` / `doSaveInlineEdit`；`appendActions` 放开入口；`normalizeMessage` 回填快照；`startSessionTurn` 落消息时写快照；`renderMessages` / `switchSession` 退出编辑态 |
| `frontend/src/style.css` | `.ai-edit` 系列（主题变量 + 复用 `.ai-attach` / `.ai-chip`） |

**不动**：`pendingEdit` 与输入区编辑链路（toolbar 的「编辑重发」、支线标签页、队列编辑仍用它）；`buildApiMessages` / `ai-context-slim` 的请求组装（快照只是渲染与重发的数据源，不进请求）。

## 5. 验证

- `frontend/test/ai/ai-inline-edit.test.mjs`：快照归一（白名单 / 截断 / 封顶 / range）、保存载荷（引用→正文前缀、媒体分组、文本附件过滤）、快照往返稳定。
- `frontend/test/ai/ai-inline-edit-wiring.test.mjs`：入口放开、保存传 `truncateAt` 且不回调 `submitText`、非末条二次确认、Esc/Ctrl+Enter、重画/切会话退出、发送写快照与重放回填、chip 渲染单一来源。
- 手测：末条改正文/删图/加图/加文件 → 截断重发；非末条确认；Esc 取消；生成中不可编辑；切会话退出；重启后图片/视频/引用 chip 完好、文件类显示说明。
