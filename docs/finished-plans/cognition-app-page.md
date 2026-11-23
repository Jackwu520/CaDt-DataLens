# 应用页面「认知索引」（已完成）

> 状态：2026-11-23 立项并当日实施完成。
> 需求：**开启认知索引后，「应用页面」出现「认知索引」页**，可浏览工作区 `.cadt/cognition/` 卷的相关信息；关闭后入口消失。
> 决策依据：①页面**只读**——卷只能经 AI 的 `cognition_edit` 以 CAS 写（`.cadt/cognition` 整树对 write_file/edit_file 拒绝，`ai-panel.js` 的 `assertNotCognitionPath`），页面不做任何写动作；②数据直接走既有绑定 `CognitionRead` / `CognitionStatus`，AI 面板闭包零参与，**纯组件重建型**（`usage-stats` 先例，无需停靠区搬运、无需 `initAIPanel` 兜底）；③它是 `APP_PAGES` 第一个**条件可见页**，机制落注册表而非各入口散判。

## 1. 条件可见机制（本方案新增，后续条件页的先例）

- `core/app-pages.js` 的 `AppPage` 新增可选字段 `visibleWhen`（settings 布尔键名）；`appPageGroups(settings)` 加可选参数，组内过滤 `!page.visibleWhen || settings?.[page.visibleWhen] === true`。
- **四个入口全部经它过滤**：侧栏 `renderAppPagesNav`、菜单「工具 → 应用页面」、活动栏 `ab-more` 弹层（命令面板自动跟随菜单）、设置目录 pane——改一处全生效；调用方传当前 `settings`（活引用，渲染时现取值）。
- **`appPageOf(id)` 不过滤**：已开的认知标签在开关关掉后仍要能 resolve 图标与标题（`tab-kinds.js` 的 `appPage` resolve 依赖它）。
- 翻转刷新：`main.js` 的 `settings-changed` 处理器记 `cogBefore`，`applyRemoteSettings` 合并后若 `settings.aiCognition` 翻转 → `refreshAppPagesNavIfVisible()`（侧栏面板重建）+ `refreshCognitionPageIfVisible()`（已开标签 `refresh()` 重读卷，判 `appPageRoot.isConnected`）。v3 广播无定向、本窗口自己也收，所以本窗口内改开关同样走这条路；菜单与设置目录每次打开现建，天然新鲜。

## 2. 页面形态（`frontend/src/ai/ai-cognition-page.js`）

- 纵向骨架：页头（标题 + 刷新）→ 状态条 → 命令栏（搜索 + 全部/文件/目录 chips）→ 路径列表；详情抽屉。
- **overview**：`CognitionRead(ws,'{}')` 的 `lines`（path/labels/dir）本地渲染；chips 对目录标记（`dir` 或路径尾 `/`）本地过滤。
- **搜索**：空词回落 overview 本地过滤；非空走 `CognitionRead(ws,{query})`（FRAS 值子串匹配），渲染 `hitEntries` 结构化命中 + F 首行预览，`hitCount` 与展示数不一致时提示收窄；请求序号守卫防竞态。
- **详情**：点行 → `CognitionRead(ws,{paths:[p]})` → 结构化渲染 职责 F / 强关联 R / 对外契约 A / 暗约束 S（空字段省略）+ 标签 chips + 复制条目；抽屉走 ui-kit `detailDrawer`（内部注册 overlay-stack，Esc 栈序），挂 `.apppage-pane`（补丁库先例）。
- **状态条**：`CognitionStatus(ws,false)` 尽力而为（失败只藏条不打断）：scene 徽标、条目/字节、预算占比、drift 四态徽标（缺文件 / 孤儿条目 / 已过期 / 未记账，>0 warn 色）、卷指纹短码 + 复制。
- **空态**：无工作区（info）、卷未建立（empty + CTA：未启用时「去设置开启」→ `openSettingsAtRow('ai', #ai-opt-cognition)`；已启用提示按目录分批建卷）、搜索无命中。
- 卸载对称：`bar.destroy()`、关抽屉、移除宿主 `.cog-root` class、清引用、推进序号。

## 3. 后端小扩展（`internal/cognition/service.go`）

- `ReadResult` 新增 `HitCount int`（过滤命中总数）与 `HitEntries []EntryIn`（结构化命中条目）：entries 模式填充，helper `limitEntriesForUI` 按 `FormatEntry` 的 rune 计数沿用 `ReadRuneLimit=7000` 封顶。**模型看的 `Text` 渲染口径完全不变**（仍渲染全量 filtered）。
- 动机：页面详情/搜索直接拿结构化 FRAS，避免前端复刻 `FormatEntry` 行格式的解析器。
- `dev/mock-backend.js`：卷改为 3 条样例条目（含目录条目、非 0 drift），过滤命中返回 `hitEntries`/`hitCount`——dev 浏览器下页面有东西可看。

## 4. 接线清单（全部落点）

| 文件 | 改动 |
|---|---|
| `core/app-pages.js` | `visibleWhen` 字段 + `appPageGroups(settings)` 过滤 + 注册表加 `cognition` 项（icon `tree`，AI 组，插在 `agents` 后） |
| `ai/ai-cognition-page.js` | 新建页面模块（`createAICognitionPage(deps)` → `{mount, refresh}`） |
| `main.js` | 导入 + 工厂实例（deps 全 getter）+ `appPageMounters['cognition']` + 3 处 `appPageGroups(settings)` + settingsPaneAppPages 注入 `get settings` + settings-changed 翻转刷新 + 两个 refresh helper |
| `settings/settings-pane-app-pages.js` | `appPageGroups(deps.settings)` |
| `style.css` | `.cog-root` / `.cog-status` / `.cog-fp` / `.cog-list` / `.cog-row*` / `.cog-chip` / `.cog-detail` / `.cog-field*` |
| `dev/mock-backend.js` | 样例卷 |
| `internal/cognition/service.go` | `HitCount` / `HitEntries` / `limitEntriesForUI` |
| `frontend/test/ai/ai-cognition-page.test.mjs` | 新建接线守卫（9 例，已登记 `npm test` 的 `test:ai`） |
| `internal/cognition/service_test.go` | `TestReadFilteredAndTruncate` 补结构化命中断言 |

## 5. 守卫要点（测试钉住什么）

- `appPageGroups` 过滤矩阵：`aiCognition:true` 进 / `false`·缺省·未传藏 / 无条件页不误伤 / `appPageOf` 不过滤。
- main.js：挂载器登记、工厂 deps（`getWorkspace` / `openCognitionSettings`）、**禁止裸 `appPageGroups()` 调用**（防新入口漏传 settings）、settings-changed 翻转刷新、`refreshCognitionPageIfVisible` 判 `isConnected`。
- 页面模块：mount/unmount `.cog-root` 对称、搜索与详情的调用形态、序号守卫、无裸原生控件（搜索框在 ui-kit `commandBar` 里）、无 window/document 级 Esc 监听、抽屉走 `detailDrawer`。

## 6. 验证记录（2026-11-23）

- `go test ./internal/cognition/ -timeout 120s`：`ok datalens/internal/cognition 4.824s`。
- `go build ./...` 通过；`go vet ./internal/cognition/` 干净。
- `npm test`：`test:ai` 1466/1466；`test:ui-shell` 485/485；`test:ui-core` 唯一失败为另一并行会话未登记的 `test/maven/maven-model.test.mjs`（untracked 文件，非本方案改动面）。
