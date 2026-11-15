# 功能验证报告：内置新功能端到端校验

> 验证日期：2026-11-14
> 应用版本：v1.1.0（`app.go:35`）
> 环境：Windows 10/11 + WebView2（`go:embed` 打包版），主题 `idea-dark` / `light` 各走一遍
> 方法：**真实文件 + 真实链路**（不走 mock 后端），在应用窗口内逐项操作并截图核对；能用工具的项直接经 AI 工具调用走完整后端路径
> 状态：① Mermaid 已验（1 个缺陷已修，2 个待办）；② 计时器已验（1 个 P0 已修待重建复验，1 个 P1 待决策）；③ `ask_user` 超时语义已修（待重建复核）；④ 任务提醒已验（1 个口径缺陷待决策）

---

## 总览

| 验证项 | 用例 | 通过 | 缺陷 | 结论 |
|---|---|---|---|---|
| ① Mermaid 代码块渲染 | 17 | 14 | 3（1 已修 / 2 待办） | 渲染本身可靠；主题重绘与 AI 面板接线有缺口 |
| ② 计时器 `start_timer` / `stop_timer` | 10 | 8 | 2（1 P0 已修待复验 / 1 P1 待决策） | 计时、上限、胶囊、停止都正常；**到点自动唤醒此前 100% 失效**，已修 |
| ③ `ask_user` 提问面板超时语义 | 4 | 3 | 1（已修待复核） | `timeoutAction=wait` 会静默忽略 `timeoutSec`，面板既无倒计时也无提示 |
| ④ 任务提醒 `reminder_*` | 14 | 13 | 1（待决策） | 标题 / 简述 / 注入 / 持久化都正常；上限计数口径与报错文案、徽标不一致 |

> 两个已修的缺陷都属同一类：**重构后残留/漏声明的标识符 + 空 catch 吞错**，症状都是"操作看起来成功了，但关键动作静默没发生"。建议把"域模块拆出裸标识符"列为下次重构的检查项。

---

# 第 1 项 · Mermaid 代码块渲染

## 1.1 渲染链

```text
markdown-it fence 规则            frontend/src/markdown.js:72
  └─ info === 'mermaid' → 占位 div .md-mermaid[data-src=base64]
                                   frontend/src/writing-ui.js:1858
       └─ 懒加载 /vendor/mermaid/mermaid.min.js（2.57 MB）
                                   frontend/src/writing-ui.js:1864 ensureMermaidScript
       └─ renderMermaidBlocks：base64 解码 → mermaid.render → DOMPurify(SVG 档)
                                   frontend/src/writing-ui.js:1892
            └─ 插入预览容器

调用点：预览与分屏共用 renderMarkdownPreview → frontend/src/editor-split-preview.js:48
主题映射：/dark|darcula/ → 'dark'，其余 → 'neutral'（frontend/src/writing-ui.js:1887）
```

关键约束（已验证成立）：

- **源码必须 base64**：DOMPurify 3.4.x 会整体丢弃属性值含换行的属性，明文 `data-src` 会被静默剥掉、图表永远空白。编解码在 `frontend/src/markdown.js:15` / `:22`，有单测（`markdown.test.mjs`）。
- **二次消毒保留 `style` / `foreignObject`**：否则图表样式全丢。
  - **2026-11-15 修正**：仅保留标签还不够——`foreignObject` 不在任何 `USE_PROFILES` 白名单里，`widget.js` 那道清洗会把它整体删掉；且 mermaid 的节点文字在 `foreignObject` 内的 `div`/`span` 中，缺 `HTML_INTEGRATION_POINTS: {foreignobject: true}` 时会被当成非法 SVG 元素剥掉，表现为「形状与配色都在、文字全无」。配置现收敛到 `frontend/src/core/visual-spec.js` 的 `svgSanitizeConfig()`，三处消费方共用。
- **`securityLevel: 'strict'`**：mermaid 侧自净化 + DOMPurify 兜底，双层。

## 1.2 用例矩阵（实测）

| 用例 | 结果 | 备注 |
|---|---|---|
| `flowchart TD`（中文标签、多分支） | ✅ | |
| `sequenceDiagram` | ✅ | |
| `pie` | ✅ | 百分比与图例正确 |
| `xychart-beta`（英文 title + 引号类别） | ✅ | |
| `xychart-beta`（中文 title + 引号类别） | ✅ | |
| `xychart-beta`（中文类别**不加引号**） | ⚠️ | 词法错误，mermaid 语法约束，非应用缺陷 |
| `mindmap` | ✅ | |
| `classDiagram` | ✅ | |
| `stateDiagram-v2` | ✅ | |
| `gantt` | ✅ | 小窗口下字号偏小（见 §1.4.2） |
| 非法语法 | ✅ | 红色提示，不崩、不吞内容 |
| 空 ```mermaid 围栏 | ✅ | 静默跳过，不留空白块 |
| 普通 ```js 围栏 | ✅ | 正常高亮，未被 mermaid 抢走 |
| 分屏（源码 + 预览） | ✅ | 预览侧同样渲染 |
| 深色 / 浅色主题各渲染一次 | ✅ | `dark` / `neutral` 配色正确 |
| **preview 下切换主题** | ❌ | 抛 `ReferenceError`，重绘被掐掉（已修） |
| **分屏下切换主题** | ❌ | 图表不重绘，配色与界面脱节（待办） |
| **AI 面板内 ```mermaid 围栏** | ❌ | 占位无人渲染 = 图直接消失（待办） |

验证文件（保留作回归样例，位于 `.cadt/`，可随时删除）：

| 文件 | 覆盖内容 |
|---|---|
| `.cadt/tmp-mermaid-check.md` | flowchart / sequence / pie / xychart / mindmap / class / state / 非法语法，中文标签 |
| `.cadt/tmp-mermaid-check-2.md` | classDiagram / stateDiagram-v2 / gantt |
| `.cadt/tmp-mermaid-check-3.md` | xychart 三种写法（英文 title、中文 title + 引号、中文 title + 无引号） |
| `.cadt/tmp-mermaid-check-4.md` | 无引号类别复现、非法语法、空围栏、普通 `js` 围栏 |

其他观察：

1. 中文标签、中文 legend、中文轴标题全部正常，无方框/乱码。
2. `xychart-beta` 的 `x-axis` 类别**必须加引号**；`x-axis [一月, 二月, 三月]` 会报 `Lexical error on line 3. Unrecognized text.`，报错文案已如实透出。
3. 空围栏（只有 ` ```mermaid ` 一行）不产生可见空白块：`msrc.trim()` 为空直接 `continue`。
4. 普通围栏未被劫持：`info` 精确等于 `mermaid` 才走占位（大小写不敏感）。

## 1.3 缺陷

### 1.3.1 P1 · 预览视图下切换主题抛 `ReferenceError`，预览重绘被掐掉（已修）

**现象**：Markdown 预览打开时切换主题，界面配色变了，但已渲染的 mermaid 图表保持旧配色——浅色界面上贴一张深色图表；`app_control` 的 `set_theme` 直接返回 `doc is not defined`。

**复现**：打开含 mermaid 围栏的 `.md` 停在预览视图 → 切换主题 → 界面变浅色、图表仍是深色，动作报 `doc is not defined`。

**根因**：`frontend/src/settings-ui.js` 的 `setTheme()` 里有一行死代码

```js
if (deps.file && deps.currentMode === 'preview' && doc && false) {}
```

`doc` 从未声明（ES module 严格模式），短路求值到它时抛 `ReferenceError`。执行顺序是 `settings.theme = id` → `applySettings()`（界面已换肤）→ 抛错，所以**换肤成功、重绘与状态栏提示被跳过**。

**影响**：mermaid 的 SVG 颜色在 `mermaid.render` 时写死，不跟随 CSS 变量；不重绘就出现"深色图表 + 浅色界面"的错配。

**修复**：删除该行，保留其后本已正确的重绘调用（`frontend/src/settings-ui.js:241`）。

**验证**：`npm run build` 退出码 0；`npm test` 199/200（唯一失败是 `ai-local-classifier.test.mjs:156` 的出厂权重金丝雀，既有失败，与本项无关）。**视觉效果待重建 exe 后复核**。

### 1.3.2 P2 · 分屏视图下切换主题不重绘（待办）

`setTheme` 只在 `currentMode === 'preview'` 时重绘；分屏时 `enterSplitView` 会把 `currentMode` 置为 `'code'`（`frontend/src/editor-split-preview.js` 的 `enterSplitView`），因此分屏里的图表不跟随主题。

**建议修法**：判断条件加 `|| deps.file.splitActive`。重绘走 `renderMarkdownPreview` 全量重建，会重置预览滚动位置，但随后 `mdSyncScrollFromAce` 会按源码位置重新对齐，代价可接受。

### 1.3.3 P3 · AI 面板里的 ```mermaid 围栏渲染为空白（待办）

`frontend/src/main.js:2348` 把共享渲染器传给 AI 面板：

```js
renderMarkdown: (text) => renderMarkdownHtml(text, {aiWidgets: settings.aiInlineWidgets !== false}),
```

`renderMarkdownHtml` 内部已绑定 `mermaidPlaceholder`，所以 AI 回复里的 ```mermaid 会正常产出 `.md-mermaid` 占位；但 **`renderMermaidBlocks` 只在 `editor-split-preview.js:48`（编辑器预览容器）被调用**，`frontend/src/ai/` 下没有任何调用点（`grep renderMermaidBlocks` / `md-mermaid` 均为空）。

**影响**：模型输出的 mermaid 图在对话里**直接消失**——占位 div 无内容、无报错，连源码都看不到，比降级成代码块更糟。这与"AI 回答的 svg/html 围栏渲成可视化卡片"是两条独立路径：`widgetLangOf` 只认 `svg` / `html` / `htm`，`mermaid` 不在其列。

**建议修法**：给 AI 面板注入 `renderMermaidBlocks`，消息渲染完成后对消息容器调用一次（流式期间跳过，参照 `enhanceWidgets` 的 `streaming` 参数）；或按 `docs/unfinished-plans/visualizer.md` §3.6 抽公共 `mermaid-render.js` 共用。

## 1.4 非缺陷观察

### 1.4.1 主题映射只按 id 正则判断

`mermaidThemeForCurrent()` 用 `/dark|darcula/` 匹配主题 id，命中 → `'dark'`，其余 → `'neutral'`：

- 走 `dark`：`dark`、`darcula`、`idea-dark`
- 走 `neutral`：`light`、`idea-light`、`github`、`pixyll`、`whitey`、`newsprint`、`harness`、**`night`**

`night` 的 `bg` 是 `#16181f`（深色）却落到 `neutral` → 配色不一致。**静态推断**（运行中的构建未含本次修复，无法重绘复核）。建议按主题 `bg` 亮度判定，或把 `night` 纳入深色集合。

### 1.4.2 小宽度容器下图表字号偏小

`gantt`、`xychart` 的 SVG 带固定 viewBox，`style.css` 的 `.md-preview .md-mermaid svg{max-width:100%;height:auto}` 会整体等比缩放；窗口窄（尤其分屏右栏）时文字降到 6–8px。不是渲染错误；若要做，方向是设最小宽度或允许横向滚动而非缩放。

---

# 第 2 项 · 计时器（`start_timer` / `stop_timer`）

## 2.1 调用链

```text
AI 工具 start_timer / stop_timer        frontend/src/ai/ai-tool-defs.js:151 / :164
  └─ executeTool 分支                   frontend/src/ai/ai-panel.js:6023 / :6037
       └─ ai-timer.js start/stop        frontend/src/ai/ai-timer.js:114 / :124
            └─ Go StartTimer/StopTimer  timer.go:173（注册表 start 在 timer.go:86）
                 └─ time.AfterFunc 到点 → EventsEmit('ai-timer-fired')   timer.go:165
                      └─ main.js 订阅      frontend/src/main.js:2514
                           └─ handleTimerEvent → onFired   ai-panel.js:11399 → ai-timer.js:147
                                └─ wakeSessionByTimer       ai-panel.js:2077
                                     └─ sendAppMessage → submitText（注入本会话并自动开新一轮）
```

设计要点：

- **计时在后端**：`time.AfterFunc`，窗口最小化/WebView 节流不会漂移（前端 `setTimeout` 会）。
- **纯内存、不持久化**：应用退出即全部消失，工具描述里已告知 AI。
- **上限**：同时运行 5 个（`timer.go:19`）；单个时长上限 24h（`timer.go:20`），更长的等待应改用定时任务。
- **会话归属记在前端**：Go 侧不感知会话，`ai-timer.js:114` 把 `timer.id → sessionId` 存在本地 Map，到点时据此选会话。

## 2.2 用例矩阵

| 用例 | 结果 | 证据 / 备注 |
|---|---|---|
| Go 单测 `timer_test.go` | ✅ 6/6 | 参数校验（5 子用例）、EndMs 计算、上限、fire/stop 幂等、AfterFunc 真实触发 |
| 同时运行上限 5 个 | ✅ | 并行 6 个调用：1 成功、5 报「最多同时运行 5 个计时器」 |
| 并发下计数不被击穿 | ✅ | 同上（Go 侧互斥 + 上限判断在并发中成立） |
| 倒计时 0 秒 | ✅ 拒绝 | 「倒计时必须提供大于 0 的秒数（seconds）」（前端拦） |
| 倒计时 90000 秒 | ✅ 拒绝 | 「倒计时时长须在 1–86400 秒之间」（Go 侧拦，`timer.go:91`） |
| 空 label | ✅ 拒绝 | 「计时目的（label）不能为空」 |
| 胶囊显示与秒级刷新 | ✅ | AI 面板头部 chips 行；倒计时用强调色，正计时用 muted 色 |
| 点击胶囊停止 | ✅ | 5 个胶囊点掉后即时消失（`ai-timer-stopped` → `onStopped` 清 UI） |
| `stop_timer` 多计时器不带 id | ✅ 报错 | 「有多个计时器在运行，请指定 id」 |
| **倒计时到点自动唤醒** | ❌ **100% 失效** | 胶囊正常倒计时并自动消失，但无系统消息、无提示、无报错（已修，见 §2.3.1） |
| `start_timer` 返回带 id | ❌ | 返回值只有文案，无 id → 多计时器时 AI 无法按 id 停止（见 §2.3.2） |

## 2.3 缺陷

### 2.3.1 P0 · 倒计时到点永远唤不醒，且完全静默（已修，待重建复验）

**现象**：倒计时胶囊正常走秒、到点自动消失，但**没有任何系统消息**、状态栏也没有提示、日志无记录。用户视角就是"计时器到点了，什么也没发生"。

**定位过程**（可复用为同类问题的排查范式）：

1. 先看**胶囊是否消失** → 消失说明 Go 侧 `AfterFunc` 触发了、`ai-timer-fired` 事件也到了前端（`onFired` 已执行并把 chip 移除）→ 断点被缩小到 `onFired` 之后的唤醒环节。
2. 读 `wakeSessionByTimer`（`ai-panel.js:2077`），发现第一行就调用 `getSessions()`：

```js
const session = getSessions().find((s) => s.id === sessionId);
```

3. `grep getSessions` 结果：只有 `1926` / `1953` / `2033` / `11264` 处作为 **`ctx.getSessions`** 传给其它域模块，**`ai-panel.js` 自身作用域里没有这个标识符**（会话列表在本文件里就叫 `sessions`，声明在 `ai-panel.js:423`）。→ 抛 `ReferenceError: getSessions is not defined`。
4. 这个异常发生在 `wakeSessionByTimer` 的 `try` 之前，直接冒到 `onFire` 的 `Promise...catch(() => {})`——**空 catch 吞掉**，于是没有任何可见症状。

**影响**：该功能的核心卖点（到点自动唤醒 AI 继续任务）自引入提交 `7677800` 起**从未成功过一次**。能起计时、能显示胶囊、能点停止，唯独唤醒无效。

**为什么定时任务没事**：定时任务走 `ai-schedule.js`，那里有 `const getSessions = ctx.getSessions;`（`ai-schedule.js:18`）——同一条投递通道，只有计时器侧漏了这行注入。

**修复**（两处，`frontend/src/ai/ai-panel.js`）：

```js
// ① wakeSessionByTimer：用本文件作用域里的 sessions
const session = sessions.find((s) => s.id === sessionId);

// ② onFire：不再空 catch，异常必须可见
onFire: (payload) => {
    Promise.resolve(wakeSessionByTimer(payload)).catch((e) => {
        flash('计时器「' + String((payload && payload.label) || '计时器') + '」唤醒失败：' + ((e && e.message) || e), true);
    });
},
```

**验证**：`npm run build`（vite）退出码 0；`grep "getSessions("` 已无裸调用（只剩注释）。**端到端唤醒待重建 exe 后复验**：发 20 秒倒计时 → 应看到「计时器到点」系统消息并自动开新一轮。

### 2.3.2 P1 · `start_timer` 返回值不含 id，多个计时器时无法按 id 停止（待决策）

**现象**：工具返回只有「已启动倒计时「X」（25 秒）。到点会自动……」，没有 id。

**影响**：`stop_timer` 在 ≥2 个计时器并存时**强制要求 id**（`ai-timer.js:124`「有多个计时器在运行，请指定 id（start_timer 返回值里有）」），而"返回值里有"其实**没有**——AI 只能请用户手点胶囊。实测时我并发起了多个计时器，随后无法自行停掉其中任意一个。

**建议修法**（`ai-panel.js:6028` 一带）：返回串末尾附 `[id: t-xxxxxx]`，两条分支（倒计时 / 正计时）都加。

## 2.4 非缺陷观察

1. **胶囊行会溢出**：5 个胶囊并存时首个被裁到可视区外（chips 行横向滚动），用户需滚动才能点到；数量多时建议改为「N 个计时器」折叠入口。
2. **上限是"同时运行"而非"累计"**：与工具描述一致；正计时不会自动结束，占满 5 个后新的倒计时会直接被拒（报错文案已指明先停部分）。
3. **不持久化已确认**：`timer.go` 只有内存 map，无任何落盘路径；`ListTimers` 仅用于面板重开/窗口重载恢复胶囊。
4. **验证方法教训**：中途我起了第 6、7 个都被接受，一度误判"上限失效"。实际是你手点掉了几个胶囊把计数降了下来。**计数器类功能验证应先清零、再单独测上限**，否则自己的操作会污染结论。

---

# 第 3 项 · `ask_user` 提问面板的超时语义

## 3.1 现象与根因

用户反馈：AI 连续两次提问，面板上**都没有超时倒计时**。查证后不是"关掉了"，而是 AI 传了 `timeoutSec` 的同时又传了 `timeoutAction: "wait"`，而实现里 `wait` 会直接禁用计时器：

```js
// frontend/src/ai/ai-panel.js（改动前）
const useTimer = timeoutSec > 0 && timeoutAction !== 'wait';       // :5533
...
deadline: useTimer ? Date.now() + timeoutSec * 1000 : 0,           // :5540
```

`deadline` 为 0 时：

- `askCountdownText()` 首行 `if (!ask || ask.state !== 'pending' || !ask.deadline) return '';` → 直接返回空；
- `ai-takeover.js` 的渲染条件又是 `if (ask.deadline)` → 连节点都不创建。

于是 `timeoutSec` 成了**死参数**，且没有任何提示。

**为什么这个组合容易踩**：AI 想表达"别到点替我选"，直觉会传 `wait`；但 `wait` 的语义是"永远等"，不是"有倒计时但超时再等"。反过来，**不传这两个参数**时走 `config.askTimeout`（默认 300 秒）+ `recommended`，面板本来是有倒计时的——"定制"反而取消了它。

## 3.2 修复（4 处）

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/src/ai/ai-panel.js` | `normalizeAsk` | 恢复历史时保留 `ignoredSec`，否则重载会话后提示消失 |
| `frontend/src/ai/ai-panel.js` | `runAskQuestion` | `ask` 新增 `ignoredSec: useTimer ? 0 : timeoutSec` |
| `frontend/src/ai/ai-panel.js` | `askCountdownText` | 无 `deadline` 且 `ignoredSec > 0` 时返回「本次不限时（已忽略 N 秒超时）」；`state` 判断前移 |
| `frontend/src/ai/ai-takeover.js` | `renderAskTakeover` | 渲染条件由 `if (ask.deadline)` 改为「文案非空」，让无倒计时的提示也能显示 |

选择"提示"而不是"静默清掉"的理由：保留 AI 的原始意图（用户能看出"这次确实要了 240 秒，只是被 wait 忽略了"），便于排查 AI 为什么这样传参。若更希望"设了不生效就别显示"，可在 `resolveAskTimeout` 里直接把 `timeoutSec` 压成 0。

## 3.3 语义约定（供后续 AI 与文档使用）

| 想要的效果 | 传参 |
|---|---|
| 显示倒计时，到点采用推荐项 | `timeoutAction: "recommended"` |
| 显示倒计时，到点交给 AI 自行决定并继续 | `timeoutAction: "ai_decide"` |
| 不设超时、一直等用户 | `timeoutAction: "wait"`（此时 `timeoutSec` 被忽略，面板会写明「已忽略 N 秒」） |
| 走设置里的默认超时 | 两个参数都不传（默认 300 秒 + `recommended`） |

## 3.4 验证

`npm run build` 退出码 0。面板文案需重建 exe 后复核（与 ①② 一并）：传 `wait` + 明确秒数时，头部应显示「本次不限时（已忽略 N 秒超时）」而不是空白。

---

# 第 4 项 · 任务提醒（`reminder_*`）

## 4.1 数据与注入链

```text
工具 reminder_add / list / update / remove   frontend/src/ai/ai-tool-defs.js:111-148
  └─ executeTool 分支                        frontend/src/ai/ai-panel.js:5971 / 5990 / 6000 / 6021
       └─ 只改 session.reminders             ai-panel.js（不碰工作区文件）
            ├─ persistSessions() → meta.json（随会话落盘，已实测）
            └─ syncRemindersUI() → 铃铛徽标 / 弹层

纯函数（可单测）      frontend/src/ai/ai-reminders.js
  normalizeReminders  归一 + 补 id + 截断到上限
  remindersForPrompt  注入用，只留未完成条目
  reminderAddBlocked  超限报错文案

每轮注入              assembleSystemContext → parts.push('<task_reminders>' …)
                      frontend/src/ai/ai-panel.js:7077-7089
  └─ 返回 {text, meta} → run.baseSystemPrompt（**系统上下文块，不是消息气泡**）
     见 ai-panel.js:7444-7445
```

- 常量：`AI_REMINDER_LIMIT = 5`、`TITLE_MAX = 80`、`DETAIL_MAX = 300`（`ai-constants.js:38-40`）。
- UI：AI 面板头部铃铛按钮 + 徽标（只数未完成）+ 弹层（头部 `list.length/5`、行内「完成 / 恢复」「删除」、底部手动新增：标题必填 + 简述可选，同样受上限约束）。
- 单测：`frontend/src/ai/ai-reminders.test.mjs` 4 项（归一化截断去重、注入过滤、超限文案）。

## 4.2 用例矩阵（实测，经真实工具调用）

| 用例 | 结果 | 证据 |
|---|---|---|
| 空清单 | ✅ | 「任务提醒清单为空（可用 reminder_add 添加，上限 5 条）」 |
| 标题 + 简述 | ✅ | 返回 `[rem-xxx]` + 计数 1/5；list 用「 — 」分隔简述 |
| 3 条并发添加 | ✅ | 计数 2/5 → 3/5 → 4/5 递增，无丢条目 |
| 上限 5 条 | ✅ | 第 6 条被拒：「任务提醒已达上限（5 条）…」 |
| **标记 done 后再添加** | ❌ | 仍被拒（见 §4.3.1） |
| update 改标题 + 清空简述 | ✅ | 传 `detail: ""` 清空生效，状态保持进行中 |
| 非法 status | ✅ | 「status 只能是 open 或 done」 |
| 不存在的 id | ✅ | 「提醒不存在：rem-not-exist（先用 reminder_list 查看 id）」 |
| 空白标题 | ✅ | 「提醒标题为空」 |
| 标题 80 字截断 | ✅ | 87 字输入 → 返回串截到 80 字 |
| remove（4 个并发） | ✅ | 全部生效，list 从 5 条降到 1 条 |
| 磁盘持久化 | ✅ | `ai-sessions/session-…/meta.json` 里 `reminders` 字段结构与内容正确 |
| 徽标计数 | ✅ | 留 1 条 open → 头部铃铛徽标显示 `1`，与 list 的 1/5 一致 |
| 弹层 UI | ⚠️ 未实测 | 无法模拟鼠标点击；静态确认渲染逻辑（行内完成/恢复/删除 + 手动新增） |
| 注入内容 | ✅ 静态确认 | 只注入未完成条目，作为 `<task_reminders>` 拼进 system prompt |

## 4.3 缺陷

### 4.3.1 P2 · 上限把已完成条目也算进去，而报错文案与徽标口径不一致（待决策）

**三处口径不统一**（`frontend/src/ai/ai-reminders.js`）：

| 位置 | 计数方式 | 5 条中 1 条 done 时 |
|---|---|---|
| `reminderAddBlocked`（上限判断） | `list.filter(Boolean).length`（**含 done**） | 拒收新条目 |
| 报错文案 | 「…或用 `reminder_update` 把完成的条目标记 done 后再添加」 | **照做无效**（done 不释放名额） |
| 头铃铛徽标 | `openCount()`（只数 open） | 显示 4 |
| 弹层头部 | `list.length + '/' + 5`（含 done） | 显示 5/5 |

**实测复现**：5 条里把「并发 B」标记 done → 徽标变 4、弹层仍 5/5 → `reminder_add` 继续被拒，且报错建议的 `reminder_update` 路径根本不存在。

**影响**：模型照报错文案操作会陷入死循环（标记 done → 仍满 → 再标记 → 仍满），只能改用 `reminder_remove`；用户看徽标 4 却加不进第 5 条，也难理解。

**建议二选一**：

- **A（推荐）**：上限只管未完成条目——`reminderAddBlocked` 改数 open，弹层头部同步改成 `open/5`；已完成的保留作历史，不挤占名额。符合"提醒是防遗漏清单"的用途。
- **B**：保持总数上限（防历史膨胀），但把报错文案里"标记 done 后再添加"删掉，并把弹层头部改成 `open/总数`。

## 4.4 非缺陷观察

1. **注入只含 open 条目**（`remindersForPrompt` 过滤 done），已完成不会污染每轮上下文。
2. **注入是 system 上下文块**，与用户消息气泡隔离，不会造成"对话里多出一条假消息"。
3. **并发添加不丢条目**：3 个 `reminder_add` 同轮发起，计数严格递增（executeTool 串行执行，无读改写竞争）。
4. **截断静默**：超长标题被静默截到 80 字，没有"已截断"提示，但返回串直接体现结果，模型能看到。
5. 上限 5 条、标题 80、简述 300 与工具描述完全一致。

---

## 后续

| 待办 | 内容 | 归属 |
|---|---|---|
| 重建复核 ① | `wails build` 后重启：切主题 → 图表即刻换配色（§1.3.1） | 需用户关机后构建 |
| 重建复验 ② | 重建后发 20 秒倒计时 → 应收到「计时器到点」系统消息并自动开新一轮（§2.3.1） | 同上 |
| 重建复核 ③ | 传 `wait` + 明确秒数时，面板应显示「本次不限时（已忽略 N 秒超时）」而非空白（§3.4） | 同上 |
| 决策 ①-1 | 是否修分屏下切主题不重绘（§1.3.2，一行判断） | 待用户定 |
| 决策 ①-2 | 是否给 AI 面板接上 mermaid 渲染（§1.3.3，改动面较大） | 待用户定 |
| 决策 ②-1 | 是否给 `start_timer` 返回值补 id（§2.3.2，一行改动） | 待用户定 |
| 决策 ④-1 | 上限口径：改成"只管未完成"（推荐）还是只改文案与弹层计数（§4.3.1） | 待用户定 |
| 顺手确认 | 修完后实测 `night` 主题的图表配色（§1.4.1） | 随重建一起 |

后续验证项（同一份报告继续追加）：AI 对话内 svg / html 可视化卡片、补丁视图、SQL 查询视图、运行代码等——每项按"调用链 + 用例矩阵 + 缺陷 + 非缺陷观察"四节结构新增一章。
