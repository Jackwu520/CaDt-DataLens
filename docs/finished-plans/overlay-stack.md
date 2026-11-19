# 全局弹层栈（overlay-stack）

> 立项 2026-11-20，当日立项当日落地。源自对弹层管理的现状调研：39 处 Esc 分支散布在约 41 个文件、20 个 window/document 级 keydown 监听各自为政，跨层协调靠特判硬编码，z-index 72 处手工赋值 31 个不同值。

## 1. 背景与痛点

### 1.1 没有栈，「栈」是手写特判

调研时（2026-11-20）的全貌：

| 体系 | Esc 监听位置 | 跨层特判 |
|---|---|---|
| 设置对话框族（12 个对话框共享 #dialog-mask） | main.js 全局代管 | `parentSettings` 伪栈 + `closeTopDialog` |
| AI 弹窗（openAIDialog，top 方式挂 body） | ai-panel document 冒泡 | `isAIDialogOpen`（只认 `ai-dialog-top`）让 main.js 让路 |
| 模型/环境变量编辑器 | document/window capture 抢跑 | envvars 用 `stopImmediatePropagation` 抢在 main.js 前 |
| 右键菜单（3 个实例） | window capture | 靠 `.ctx-menu` DOM 类协调实例 |
| 图片灯箱 | window capture | `e.defaultPrevented` + `querySelector('.ctx-menu:not(.hidden)')` 反查 |
| 标题栏三弹层 | document capture | 逐个点名 `isToolbarPopOpen(...)` |
| git-graph 模态 | window capture | 注释明说「不进全局设置对话框栈」——进不去所以自建 |
| 其余（palette/quick-switch/gs/jp/diff/js/msg-center/foot/…） | 各自 input/document 监听 | main.js 全局链逐个让路 |

已出的真实 bug：设置窗里以 top 方式打开的 AI 二级弹层，第一次 Esc 被 main.js 的 `closeTopDialog()` 连带把设置窗关掉（根因是两套监听的执行顺序差），催生了 `ai-dialog-esc.test.mjs` 护栏。

### 1.2 z-index 靠口口相传

`.set-select-pop` 1200 压对话框 100 是实证需求、`.ctx-menu` 120 压灯箱 60 是故意的、tooltip 9999 压一切——全写在各自 CSS 与注释里，没有单一来源。

## 2. 设计

### 2.1 API（`core/overlay-stack.js`，模块级单例仿 keymap.js 先例）

```js
const handle = overlayStack.open({
    id,            // 调试用 / has() 查询
    kind,          // 'bar' | 'lightbox' | 'dialog' | 'modal' | 'popover' | 'menu'
    el,            // 栈层最外元素（open 写内联 z，dispose 还原）
    underEl,       // 可选遮罩元素（钉在档位地板 z；共享遮罩还有其他条目引用时保留内联 z）
    onClose,       // 关闭回调；返回 false = 不消费、传给下一层（quick-switch 子级先回主级）
    consumesEsc,   // 默认 true
});
handle.dispose();  // 幂等出栈 + 还原内联 z；系统的所有关闭路径收口到这里
overlayStack.top() / has(id) / size() / tierZ(kind)
overlayStack.dispatchEscape(e)   // 纯逻辑可测（fake 事件对象）
overlayStack.install(window)     // 幂等；main.js 最顶调用，先于一切弹层工厂
```

### 2.2 Esc 分发契约

唯一 window 捕获 keydown 监听，**装得最早**（window 捕获按注册顺序执行，只有装在一切弹层工厂之前，`stopImmediatePropagation` 才能可靠抢占各域散落的旧监听——这是整个方案成立的时序前提，护栏测试钉住）：

1. `e.defaultPrevented` / `e.shiftKey`（Shift+Esc 归 `view.closeDockPanel`）/ `e.isComposing`（输入法组合态）→ 放行；
2. 从栈顶向下找第一个可消费层：跳过已让路与死层（`isAlive` 默认 `el.isConnected && !hidden`，死层顺手剔除——泄漏自愈）；
3. `data-esc-local` 让路：焦点落在**真实顶层**子树内带标记的元素上时整体放行（元素级 Esc 语义 ≠「关所在层」，如设置搜索框清词不关窗）；
4. `onClose()` 返回 false → 记入 passed 集合继续向下；否则 `preventDefault + stopImmediatePropagation`，消费；
5. 栈空 → 返回 false，事件照旧流向旧监听（未迁移层与元素级语义的兜底通道）。

main.js 的全局 Esc 分支因此收成三行：`dispatchEscape` 优先，`size() === 0` 时才兜底 `closeTopDialog()`（**栈让路时不能兜底**，否则「Esc 只清搜索词」会连带关掉设置窗——这正是兜底必须带空栈守卫的原因）。

### 2.3 z-index 档位（用户裁定一起收口）

| kind | 基准 | 现状对照 | 依据 |
|---|---|---|---|
| bar | 100 | find-bar 35 | 非模态工具条，低于一切遮罩 |
| lightbox | 1100 | 60 | 面板内覆盖，低于对话框遮罩 |
| dialog | 2100 | mask 100 / card 101 | mask 作 underEl 钉地板、卡片按栈位排 |
| modal | 3100 | model editor 130、gs/jp/diff/js 150、gg 400、AI top 300 | 独立遮罩模态 |
| popover | 4100 | select-pop 1200、tb-pop/msg-center/enc 90 | **实证须压过 dialog/modal**（设置下拉开在设置窗上） |
| menu | 5100 | ctx-menu 120+depth | 可出现在任何层之上，仅次于 tooltip |

同档内 `z = 基准 + 1 + min(栈位, 899)`（间距 1000 容纳同档多层不越档）。**不进栈的常驻层**：tooltip 9999、`.app-toasts` 200→6000（唯一一处改值：否则被 modal 档盖住）、split-mask 40、code-fold-hover 90、ai-panel 20——非栈层一律压在 1000 以下。栈管的 15 处 CSS z-index 全部删除，栈成为唯一来源。

### 2.4 接入口径（哪些进栈、哪些豁免）

**进栈**（页面级，约 20 个体系）：设置对话框族（逐对话框条目、mask 共享作 underEl）、AI 弹窗、模型编辑器、环境变量编辑器、右键菜单（子菜单 `tierZ('menu') + 菜单基准 + depth`）、图片灯箱、命令面板、快速切换、消息中心、标题栏三弹层、状态栏浮层、查找条（bar 档）、全局搜索、JSONPath/对比/Schema 三遮罩、git-graph 模态、设置下拉、模型选择器、模型列表浮层、本轮用量浮层、菜单条下拉。

**豁免**（面板/视图层叠上下文内的小浮层，保留自身 Esc 监听）：AI 面板 ctx/changes/chips pop、群聊菜单、CSV 统计面板、阅读模式 Esc 链（全屏视图状态机）、tooltip（跟随指针、任何 Esc 顺手隐藏且不消费）、toast（转瞬即逝）、sbFilter 等元素级非弹层 Esc。豁免的合理性：栈消费时它们被 `stopImmediatePropagation` 自然抢占（不会双重响应）；栈空时事件照常到达它们的监听（行为不变）。若它们进栈反而破坏档位（popover 档 4101 会在面板内压过面板内对话框）。

**data-esc-local**：全量审计后只有 settings-search 输入框需要（Esc = 清词 + blur，不关窗）；其余元素级 Esc 皆为「关所在层」（与栈语义一致，栈先消费后其监听成死代码但无害）或内联控件自管（CSV 单元格还原、memo 行内编辑、AI 审批输入框、消息原地编辑）。

## 3. 实施清单

- 新建 `frontend/src/core/overlay-stack.js`（~230 行）+ `test/core/overlay-stack.test.mjs`（16 例纯逻辑：栈序/幂等出栈/共享遮罩 z 保留/各让路守卫/死层自愈/onClose 异常按消费处理/连带出栈）+ **后续强制接入的机械护栏** `test/core/overlay-esc-guard.test.mjs`（扫描 src 下 window/document 级 keydown 监听，±窗口内提及 Escape 的命中文件必须在豁免清单里——豁免只允许「面板/视图层叠上下文内自管的小浮层」且逐条写原因，探针验证过能逮住新违例；已知盲区：超长 handler 与远处定义的具名函数扫不到，靠文件级豁免兜住），登记 npm test 清单。
- main.js：顶部 install（先于 createSettingsUI，注释写明时序前提）；Esc 分支收成 dispatchEscape + 空栈守卫兜底；删 `isAIDialogOpen` 让路与 findbar 特判；菜单条下拉注册。
- 各域注册 + 删旧 Esc 监听 + 删跨层特判：settings-dialogs / ai-manage-dialogs / ai-panel（isAIDialogOpen 导出删除；document Esc 监听只收面板内 pops）/ ai-settings-dialog / ai-model-settings / settings-pane-envvars / contextmenu / image-lightbox / palette / quick-switch / message-center / titlebar 三模块 / foot-menus / find-bar / settings-select / json-query / diff-dialog / schema-panel / global-search / git-graph-dialogs / ai-model-picker / ai-usage-ui。
- style.css：删 15 处栈管 z（含注释指向栈）、`.app-toasts` 200→6000、tooltip 注释更新。
- 护栏 `test/ai/ai-dialog-esc.test.mjs` 重写：栈先分发、兜底带空栈守卫、install 先于第一个工厂、`isAIDialogOpen` / 灯箱 DOM 反查 / envvars 抢跑 / 标题栏逐个点名 Esc 不复存在。
- 文档：AGENTS.md（core/ 条目 + 前端侧「弹层硬规范」）+ 本方案 + CHANGELOG。

## 4. 行为变化（用户可见）

- **一次 Esc 只退一层**：此前对话框开着按 Esc 会连带关掉菜单条下拉/状态栏浮层；现在逐层退。
- **层序正确**：对话框上右键 → Esc 先退菜单再退对话框；灯箱上右键同理；设置下拉 → Esc 先退下拉再退设置窗（此前一枪全关）。
- **z 视觉不变**：档位表与现状对照逐项核实过，无层叠错乱案例。

## 5. 验证

- `npm test` 全量 1890 例：本改动零新增失败（工作区前序批次的 2 个既有失败已用临时 worktree 在 HEAD 上验证为非本次引入）。
- 手工链（wails dev）：设置窗 → 命名子对话框逐层退；设置窗开 AI 用量配置（top）→ Esc 只退 AI 层；对话框上右键 → Esc 先退菜单；灯箱上右键同验；select-pop 与设置窗互压；git-graph 模态 Esc；Shift+Esc 仍关 dock；settings-search Esc 只清搜索词。
- z 档位抽查：DevTools 看各弹层 open 时内联 z、close 后内联清除（还原 CSS 或清空）。
