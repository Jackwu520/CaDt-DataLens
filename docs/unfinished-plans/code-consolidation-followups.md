# 代码收敛跟进项：#3 显示在文件管理器 与 #4 弹层外点关闭 / 锚点定位

> 来源：2026-11-23 一次全面代码审查（「通用能力埋在具体模块 / 重复造轮子」）。本文件只覆盖审查结论里**需要单独方案**的两项；同一轮审查里风险低、可直接改的 #1（escapeHtml）、#2（formatBytes / relativeTime）已直接实施，不在此列。
>
> 本文件是**待开工方案**，尚未实现。落地后移入 `docs/finished-plans/`。

---

## #3 `ShowInFolder` 手写 `explorer.exe`，绕开 `executil` 且非跨平台

> **状态：已实施（2026-11-23）。** `internal/shellexec` 新增 `RevealInFolder`（windows 走 `explorer.exe` + `executil.HideCommandWindow`，other 桩报错）；根壳 `ShowInFolder` 只留校验后转发，`explorerArgs` 删除；测试迁到 `internal/shellexec/shellexec_test.go`（`//go:build windows`）；`crossplatform_guard_test.go` 增加「`"explorer.exe"` 只许在 Windows 文件」规则。验证：`go build ./...`、`go test`、`tools/check-crossbuild.ps1`（linux/darwin 三目标）全通过。以下保留原始现状与方案记录。

### 现状

- `app_window.go:164` 直接 `exec.Command("explorer.exe", explorerArgs(path, info.IsDir())...)`。
- 全仓其余 25 处 `exec.Command` 均走 `executil.HideCommandWindow`，只此一处裸写（与 AGENTS.md「防黑窗统一用 `executil.HideCommandWindow`」不一致）。
- `internal/` 内没有任何 `explorer.exe` 字面量——这是唯一一处。
- `app_window.go` 无 build tag；`crossplatform_guard_test.go` 的 `windowsOnlyAPI` 正则只扫 `SysProcAttr` / `syscall.UTF16*` / `x/sys/windows`，**扫不到 `"explorer.exe"` 字符串**，所以真编 linux/darwin 时会编译通过、运行期失败。
- 配套纯函数 `explorerArgs`（`app_window.go:189`）有踩坑注释：路径须先 `filepath.Clean` 成 Windows 原生分隔符，否则 `explorer.exe` 把 `/` 开头的段当开关，静默回退打开「文档」文件夹。测试 `app_test.go:597 TestExplorerArgsUseNativePath` 钉住这个行为。

### 目标

把「在系统文件管理器里显示/打开」下沉到已成对的平台 glue 包 `internal/shellexec`（`shellexec_windows.go` + `shellexec_other.go`），根壳只保留 Wails 绑定方法做转发。

### 方案

1. `internal/shellexec` 新增 `RevealInFolder(path string, isDir bool) error`：
   - `shellexec_windows.go`：内部 `exec.Command("explorer.exe", revealArgs(path, isDir)...)`，自行 `executil.HideCommandWindow`；`revealArgs` 就是把现有 `explorerArgs` 连注释一起搬过来。
   - `shellexec_other.go`：`return errors.New("当前平台不支持在文件管理器中显示")`（与 `Open` 的桩一致）。
2. `app_window.go` 的 `ShowInFolder` 改为：路径存在性校验（`os.Stat`）留在根壳（错误文案属绑定层职责），之后 `return shellexec.RevealInFolder(filepath.Clean(path), info.IsDir())`；删掉 `explorerArgs`。
3. 测试搬迁：`app_test.go:597 TestExplorerArgsUseNativePath` → `internal/shellexec/shellexec_test.go`，改为测 `revealArgs`（导出或同包测试）。
4. 顺手补一道护栏：`crossplatform_guard_test.go` 的 `windowsOnlyAPI` 增加一条「`"explorer.exe"` / `"explorer"` 字面量只许出现在 `_windows.go`」的规则，防止以后在平台无关文件里再手写。

### 风险与验证

- 风险：`--convert --out` 之类不受影响；仅 `ShowInFolder` 一处。`atomfile` 无关。
- 验证：`go build ./...`；`tools\check-crossbuild.cmd`（真编 linux/darwin，确认桩可编译）；`go test ./internal/shellexec/ ./`（搬完的测试）。

---

## #4 弹层「外点关闭」与「锚点视口定位」仍是各写各的

> **状态：基础设施已落地，部分站点已迁移（2026-11-23）。**
> - 新增 `core/popover-position.js` 的 `placePopover(el, anchor, {placement, align, gap, margin})`（视口钳制 + 自动翻上方）。
> - `core/overlay-stack.js` 的 `open()` 新增 `closeOnOutsideClick` + `anchors`（共享 document `pointerdown` 捕获，只看栈顶活层，`pendingActivate` 跳过打开当帧）。
> - 已迁移：`shell/message-center.js`（定位 + 外点关闭）、`shell/titlebar-popovers.js`（定位）、`ai/ai-model-picker.js`、`ai/ai-agent-settings.js`（分组建议）、`ai/ai-usage-ui.js`（用量弹层）、`ai/ai-panel.js`（模型列表弹层）——外点关闭均改为 `open({closeOnOutsideClick, anchors})` 并删除各自自挂的 document 监听与 dismiss 句柄。
> - 剩余站点：`ai/ai-panel.js`（用量弹层，当前无弹层栈条目，需先补 open/close 生命周期）、`ai/ai-reminders.js`（面板内全局单监听）、`ai/ai-changes-ui.js`、`ai/ai-head-hud.js`、`ai/ai-group-view.js`、`settings/settings-select.js`、`editor/foot-menus.js`、`shell/titlebar-git-branch.js`、`reading/reading.js`、`main.js`、`explorer/explorer.js` —— 范式与 message-center 相同（定位 → `placePopover`；外点关闭 → `open({closeOnOutsideClick, anchors})`），逐处替换即可。以下保留原始现状与方案记录。

### 现状

`core/overlay-stack.js` 已收口「Esc 栈序 + z-index 档位」两件事，文件头注释明确「所有关闭路径（按钮/遮罩点击/外点/blur/resize）都应收口到 `handle.dispose()`」，但**机制上没提供**外点关闭与锚点定位，导致：

**外点关闭 ~14 处**，同一模式各写一遍（`document.addEventListener('mousedown'|'pointerdown', e => { if (!pop.contains(target) && !anchor.contains(target)) close() }, true)` + 手动 remove）：
- `ai/ai-agent-settings.js:75`、`ai/ai-model-picker.js:299`、`ai/ai-panel.js:14883`、`ai/ai-panel.js:15005`、`ai/ai-usage-ui.js:235`、`ai/ai-reminders.js:414`、`ai/ai-group-view.js:402`、`shell/message-center.js:312`、`settings/settings-select.js:505`、`shell/titlebar-git-branch.js:618`、`reading/reading.js:1145/1181/1184`、`editor/foot-menus.js:338`、`main.js:6689`、`explorer/explorer.js:1364`。

**锚点视口钳制定位 ~7 处**（`Math.max(8, Math.min(rect.left, innerWidth - width - 8))` + 底部溢出翻上方）：
- `shell/titlebar-popovers.js:31`（已有独立函数，但锁在 shell 域）、`ai/ai-agent-settings.js:60`、`ai/ai-model-picker.js:304`、`ai/ai-panel.js:14870/14986`、`ai/ai-reminders.js:400`、`ai/ai-changes-ui.js:128`、`shell/message-center.js:295`。
- `core/tooltip.js:150` 的 `positionBubble` 有完整实现，但是私有、不导出。

### 目标

把这两件「弹层三件套」的另外两件并入 `core/overlay-stack.js` 的 `open()` 选项，让浮层只声明意图，不再各挂 document 监听、各写定位数学。

### 方案

1. `overlayStack.open()` 新增两个可选参数：
   - `closeOnOutsideClick: true` + `anchors: HTMLElement[]`：内部装**一个共享** document `pointerdown` 捕获监听（整个栈只装一次，按栈顶判定），命中「点在 el 与 anchors 之外」即 `dispose()`。
   - `position: {anchor: HTMLElement, placement?: 'auto'|'bottom'|'top', margin?: number, gap?: number, container?: HTMLElement}`：open 时与 resize/scroll 时（栈内统一挂）把 el 摆到 anchor 附近并做视口钳制。
2. 定位数学抽成 `core/popover-position.js` 的 `placePopover(el, anchor, opts)`（`container` 支持「相对容器」模式，供 AI 面板这类与面板滚动容器而非 viewport 绑定的浮层用），`core/tooltip.js` 的 `positionBubble` 后续改为复用。
3. 逐个迁移调用点，**保留各自的 toggle 语义**：
   - 「点锚点再点一次 = 关」：由 `anchors` 命中判定 + 调用方自己的 toggle 处理，栈只管「点到别处就关」。
   - 「打开事件本身不应立即触发关闭」：`shell/message-center.js:312`、`reading/reading.js:1184` 用 `setTimeout(...,0)` 延迟注册——共享监听必须保留这个细节（打开当帧的 pointerdown 不入栈判定）。
4. 迁移顺序：先做定位（`popover-position.js` + 7 处 → `position` 选项），再做外点关闭（`closeOnOutsideClick` → 14 处）。两步都可独立验证。

### 风险与验证

- 风险：toggle 语义细微差别（有的点锚点收起、有的忽略）；`ai/ai-panel.js` 在 `overlay-esc-guard.test.mjs` 豁免清单里（面板内自管小浮层），迁移时要保留其「相对面板容器」定位。
- 护栏：`overlay-esc-guard.test.mjs`、`icon-guard.test.mjs` 基线在迁移期间**只减不增**。
- 验证：`npm test`；手动核对外点关闭、锚点翻转、Esc 栈序三层叠加场景。

---

## 附：本轮审查里同属「低优先级、顺手做」的项（不在本文件展开）

`el()` DOM 工厂 ~14 份、`newId()` 7 份、`JSON.parse` 安全封装 20+ 处、localStorage 读写封装 14 处、文本剪贴板 3 份、Go `os.WriteFile` 绕开原子写、Go「无法定位应用数据目录」文案 13 文件——这些量大但每处独立、语义各有细微差异，建议触碰相关模块时顺手迁移，不专门开任务。

> **状态更新（2026-11-23）**：以上各项已由一个独立会话全部实施（`core/dom.js`、`core/id.js`、`core/json-safe.js`、`core/kv-store.js`、`core/clipboard.js` + Go 原子写 / `appdata.ErrNoRoot`），验证通过并已记入 CHANGELOG。
>
> **复查新发现的遗漏**：`clampInt(value, min, max, fallback)` 仍有 5 份独立实现——`ai/ai-external-tools.js:43`、`ai/ai-gen-model.js:25`、`ai/ai-group-model.js:103`、`ai/ai-session-tools.js:11`，以及 `ai/ai-search-advanced.js:7`（**参数顺序不同**：`fallback` 在 `min/max` 前，合并时须逐个核对调用点）。`ai/ai-constants.js` 已有权威的 `aiClampInt`，可将前四份同签名者收归它；`ai-search-advanced` 那份单独评估。字符串截断 `clampText` 亦有 ~7 份实现（是否压缩空白语义各异），同属此类，触碰相关模块时顺手做。
