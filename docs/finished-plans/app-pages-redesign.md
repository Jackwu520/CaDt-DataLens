# 四个应用页面现代化重设计（已完成）

> 状态：2026-11-22 立项并当日实施完成。范围：外部工具 / 定时任务 / 操作记录 / 补丁库四个应用页面标签页。
> 相关：`tab-registry.md`（应用页面第二族机制）、`overlay-stack.md`（详情抽屉栈）、`form-controls` 规范、`icon-guidelines.md`。

## 1. 背景与目标

「一切皆标签页」第二族落地后，四个功能页从设置对话框搬进内容区标签页，但骨架仍是设置面板的 `.set-card` 纵向堆叠——信息不可扫读、无详情、无状态反馈、交互只有「刷新 + 删除」。本次重设计让它们符合现代化数据管理页的操作习惯。

**用户拍板的三项取舍**：
1. 改动深度 = 前端 UI + 必要后端增强（后端契约与 mount/unmount 接口默认不变）。
2. 设计语言 = 各页定制，只统一视觉 token（不强行同构成「数据工作台」）。
3. 设置项归属 = 留在设置页 + 页内「去设置」跳转（保住 settings-tree 的 DOM 反射与 AI `set_setting_row` 能力）。

**不可动契约**：`core/app-pages.js` 清单、`core/tab-kinds.js` 的 appPage 项、`bridge/bridge-app-page-view.js` 的单例标签 + `mount(root)→卸载函数` 契约、`main.js` 的 `appPageMounters`、`sched-fire`/`schedules-changed`/`mcp-*` 事件名、设置页 `opt-activity-log`/`opt-activity-retention` DOM 节点。

## 2. 调研结论（共性痛点）

四页骨架全是 `.set-card` 纵向堆叠，列表无列对齐/无详情/无状态反馈，整行不可点。各页：
- **外部工具**：`#extcap-park` 常驻 DOM 搬运；`renderToolsPanel` 每次 `renderAll` 复用 panel 节点重复 `addEventListener`（MCP 事件高频触发持续累积）；三份配置快照手动同步。
- **定时任务**：类型/下次时间/权限/会话/最近结果塞进一行 nowrap；编辑器裸建 `input/select/textarea`（违反表单控件硬规范）；`mountedList` 单例刷新，应用页标签不订阅 `schedules-changed`。
- **操作记录**：筛选服务端重查 + 全表替换；keyword 无防抖；`beforeTs` 单游标同毫秒易重复/漏；详情是裸 `JSON.stringify`；无 UI 测试。
- **补丁库**：`patchPath` 已在数据里却不用，整行只有删除按钮；无筛选/搜索/排序，`limit=50` 硬编码；时间无年份/相对时间；列表 `max-height:260px` 造成嵌套滚动。

## 3. 实现

### 3.1 共用基础：`frontend/src/app-pages/ui-kit.js`（新增，277 行）

纯 DOM 工厂，不 import 任何域模块（放 `app-pages/` 新目录，域模块单向依赖它）。依赖 `core/form-controls` / `core/icons` / `core/overlay-stack` 三件既有设施，零新依赖：

- `pageHeader({title, desc, actions})` / `statusBadge(text, tone)` / `commandBar({search, filters, onSearch, debounceMs=200})` / `filterChips` / `stateBlock(kind, text, action)` / `detailDrawer({title, onClose, content})`（经 overlay-stack 注册，Esc 栈序关闭，不自挂全局监听）/ `relativeTime` / `formatFullTime` / `copyButton` / `iconButton`。
- `style.css` 新增 `.ap-*` token 类（页头 / 徽标 / 命令栏 / chips / 状态块 / 抽屉 / 图标按钮），颜色全走主题变量（`--panel2`/`--border`/`--text`/`--muted`/`--accent`/`--green`/`--red`/`--warn` + `color-mix`），无硬编码色。不改 `.apppage-root` 的 padding/max-width 契约。

### 3.2 外部工具（`settings-pane-external-tools.js` + `ai-mcp-settings.js`）

**实现选择**：完整组件化（去掉 `#extcap-park`）需要改 `ai-panel.js`（1.1 万行）的 MCP 挂载契约（`mcpSettingsMod` 的 render/renderAll 在 6 处被调用，含标签未打开场景），回归风险高。因此保留 DOM 搬运契约（测试守卫依赖），修真正的 bug 根因 + 视觉重排，达成同样用户可见目标：
- 能力矩阵改 `#extcap-list` 响应式两列网格；`capabilityHint` → `capabilityState`（有效性徽标 success/warn/danger + 说明）。
- 保存反馈：`setSaveState` + `saveSeq` 竞态序号，页头徽标显示「保存中 / 已保存 HH:mm:ss / 保存失败」；unmount 移除 mount 时新建的页头。
- **修监听器累积**：`renderToolsPanel` 改为每次 `if (panel) panel.remove()` 再新建节点，旧节点连同监听器一起被 GC（原实现复用 panel 节点、`innerHTML` 只换子节点，每次 `renderAll` 叠加一组按钮 + change 监听）。

### 3.3 定时任务（`ai-schedule.js`）

- 新增 `renderScheduleTableRow` 给应用页（列对齐表格：任务 / 排程 / 下次触发含相对倒计时 / 目标会话 / 权限徽标 / 状态徽标 / 操作），与弹层/对话框共用的窄列表 `renderScheduleRow` 分开；`renderScheduleSettings` 按 `target.classList.contains('ap-sched-table')` 分流。
- `mountSchedules` 用 `pageHeader` + `commandBar` + `filterChips`（全部/启用中/已停用）+ 表头 + 表格容器；`filteredSchedules` 前端过滤；空态用 `stateBlock` + 「新建第一个任务」CTA。
- 行操作补 `data-tip`/`aria-label`（启停/编辑/删除），删除图标改 `trash`。
- 编辑器改用 `createInput/createSelect/createTextarea`（修复 `ai-schedule.js` 存量裸控件违规），删除易错的 `valueLabel.insertBefore` 手工挂载。
- `main.js` 的 `schedules-changed` 订阅补刷新打开的应用页标签（`docs.find(d => d.appPage === 'schedules')`），修复跨窗口/工具 CRUD 后标签陈旧。

### 3.4 操作记录（`activity-pane.js` + `internal/activity/activity.go`）

- 日志表格：`act-thead` + 日期分组头 + 中文动作名（`ACTIVITY_ACTION_LABEL` domain 前缀映射）+ 格式化 JSON 详情（`<pre>` 缩进 + 复制按钮）+ 相对时间（完整时间进 `data-tip`）。
- `commandBar` 防抖搜索 + 动作域/来源下拉（走 `createSelect`）+ 清除筛选 + 刷新。
- **Go 增强**：`activityQuery` 新增 `BeforeSeq int64 json:"beforeSeq"`；`Read` 在 `BeforeSeq>0` 时按 `TS>beforeTs || (TS==beforeTs && Seq>=beforeSeq)` 跳过（严格更旧），`BeforeSeq=0` 退化为旧单 `beforeTs` 口径（老前端与 AI `get_activity` 兼容）。前端 `activityView.oldestSeq` 维护游标，翻页带 `beforeSeq`。
- 设置项：页内「去设置」按钮经 `deps.openActivitySettings` → `settingsUI.openSettingsAtRow('general', elsSettings.activityLog)`；设置页两项 DOM 保留（反射契约）。
- 测试：`frontend/test/settings/activity-pane.test.mjs`（5 例）+ Go `TestActivityReadCompositeCursorSameMillisecond`（同毫秒 3 条分两页不重复/不漏 + 旧游标兼容）。

### 3.5 补丁库（`settings-pane-patches.js`）

- 卡片列表：`patch-store-row` 圆角卡 + 整行可点开详情抽屉 + 状态徽标（ui-kit tone）+ 相对时间；删除降级为行尾次级危险图标按钮。
- `showDetail` 详情抽屉（`detailDrawer` 走 overlay-stack）：元信息键值表 + 文件列表 + 操作（打开补丁视图 / 撤销已应用项 / 删除）。「打开视图」经 `deps.openPatchFile` → `main.js` 的 `openPath(path)`，`.patch` 文件由 `patch-view.js` 接管（含预检/应用/撤销）。
- 状态筛选 chips + 搜索 + 排序（时间/改动量）+ 前端分页（`PAGE_SIZE=30`，显示「共 N 条 · 第 x/y 页」）。
- **实现选择**：分页在前端做（`PatchList(dir, 500)` 一次取足够多 + 前端筛选/排序/分页），未改 Go 绑定签名——前端全量取数已足够，避免扩大后端改动面与 mock 同步成本。
- 去掉列表固定 `max-height:260px`（消除嵌套滚动），交给 `.apppage-pane` 统一滚动。

## 4. 验证

- 前端：新增/扩展 4 个接线守卫测试（`ai-schedule-page` / `activity-pane` / `patch-store-page` / `external-tools-page`），全部登记 `npm test`；全量 2260+ 例通过（含 icon-guard / form-controls-factory / overlay-esc-guard / no-src-tests / test-manifest 护栏）。
- Go：`go test ./... -timeout 300s` 全量通过，重点 `internal/activity`（复合游标表驱动用例）与 `internal/patch`。
- 构建：`npm run build` 通过（更新 go:embed 的 dist）。
- 手工验收：四页标签单例去重、外部工具 MCP 事件高频下无监听器累积、定时任务跨窗口刷新、操作记录同毫秒翻页、补丁库详情抽屉 Esc 与主题适配。

## 5. 契约边界与后续

- 后端只改了 `internal/activity` 的查询结构（新增可选字段，向后兼容）；其余三页零 Go 变更。
- 外部工具 `#extcap-park` 搬运机制保留——彻底组件化需连同 `ai-panel.js` 的 MCP 挂载契约一起重构，另立方案。
- 补丁库分页在前端；若补丁数超 500 需再考虑 Go 侧真分页。
