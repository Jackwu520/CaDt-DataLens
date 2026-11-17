# 书签功能补全 + 经 app_control 开放给 AI 助手

> 状态：**未开工**（2026-11-18 规划）。

## 需求

编辑器已有行书签（F11 切换、F2/Shift+F2 跳转），但只有「当前文档内循环跳转」一个动作面，没有跨文件总览，AI 也感知不到。目标：

1. 补全书签功能本身：跨文件书签总览（列出全部文件的书签、点击跳转、可删）。
2. 通过 app_control 开放给 agent：列书签、加书签、删书签、跳书签——让 AI 能「记住这个位置回头再看」这类工作流。

## 现状（代码事实）

**数据与渲染**（全部在 `frontend/src/editor/editor-doc-extras.js`）：
- 每个 doc 挂 `doc.bookmarks: Set<number>`（**0-based** 行号），初始化于 `editor-groups.js:1337`；`bookmarkRowsForDoc` / `renderBookmarks`（`editor-doc-extras.js:219-248`）打 gutter 紫标（`style.css:4141-4153`，`.bm-gutter`）。
- `toggleBookmark()`（`:250-266`）、`jumpBookmark(delta)`（`:268-290`，F2/Shift+F2 循环跳，走 `deps.jumpToPosition`，只限当前文档）。
- 快捷键：`core/keybindings.js:62-64`（`edit.toggleBookmark` F11 / `edit.nextBookmark` F2 / `edit.prevBookmark` Shift+F2），派发在 `main.js:4631-4638/4712-4716`；命令面板只有「切换当前行书签」一项。
- 文档重读时书签保留（`main.js:3278` 的 `Object.assign` 保 `bookmarks` Set）。

**持久化**：搭编辑器视图状态记忆的便车——`captureDocView` 把 `bookmarks` 写进 `views[sessionPathKey]`（`editor-doc-extras.js:314-315`，上限 500/文档），随会话快照进 localStorage `cadt.session.v1` / `cadt.workspace-sessions.v1`（`session-restore.js:12-15`），重启/切工作区经 `applyDocView`（`:320-355`）恢复。**没有独立书签存储、没有命名书签、Go 侧不落盘。**

**「打开文件 + 跳行」链路**（AI 工具卡与全局搜索都在用，直接复用）：`openPaths`（`main.js:2016-2071`）→ `selectLineInDoc(doc, line, column)`（`main.js:2139-2192`）→ `openTargets` 汇聚（`main.js:2197-2206`）。

**app_control 接线点**（新增动作四处对齐，缺一处即被守卫拦红）：
1. 模型可见清单：`ai-constants.js:259-336` cadt-ui 技能动作表，格式 `- 动作名 {参数}：说明`，**一条一个动作**。
2. 白名单：`main.js:469-480` `APP_ACTIONS`。
3. 分发：`main.js:630-1192` `runAppAction` switch（`goto_line` 先例在 `main.js:859-876`）。
4. 守卫：`test/ai/ai-app-actions.test.mjs` 三方对账（技能表 ↔ APP_ACTIONS ↔ switch，含无重复检查）。
- mock-backend **不需要** mock：app_control 是前端内部桥（main.js 函数直调），不过 Wails 绑定，dev 模式下 `runAppAction` 照常可用。
- 权限：app_control 全档下发（`ai-tool-defs.js:1083`）、执行不走 `decidePermission`，靠技能表文字约束；计划模式 per-action 拦截在 `ai-panel.js:9176-9180`（memo 三写动作先例）。

## 关键决策

1. **不新增存储文件**。书签继续挂 `doc.bookmarks` + 视图快照（`views[key].bookmarks`）持久化——它是视图状态不是用户数据资产，跨启动已可恢复，0 新存储符合体积预算。AI 的读取面 = 打开中的 docs + `knownDocViews` 里已记录的关闭文档快照，两处合并列出。
2. **动作只做四个，不做命名书签**。命名/备注书签是范围膨胀（要动数据模型、快照结构与总览 UI），YAGNI，刻意不做；行号 + 该行内容片段已足够 AI 与用户定位。
3. **未打开的文件 add/goto 时自动打开**（复用 `openPaths` 链）：语义清楚、用户可见（文件被打开），避免往会话快照里直写一套旁路数据。`remove` 同理——先定位 doc 再删，找不到已记录行号时回报错误而非静默。
4. **行号语义：动作一律 1-based**（与 `goto_line`、`read_file`、命令行 `--line` 一致），与 `doc.bookmarks` 的 0-based 的换算收在动作实现一处，写注释防错。
5. **计划模式 per-action 拦截**：`add_bookmark` / `remove_bookmark` / `clear_bookmarks` 是用户可见 UI 状态变更，计划模式下拒绝（照 memo 写动作先例）；`list_bookmarks` / `goto_bookmark` 只读/导航性质，放行。
6. **不加审批卡**：与 memo 动作同级（低风险 UI 操作，无文件写入），全档可用，删书签靠技能表文字约束「删书签前先和用户确认」。
7. **总览弹层走轻量路线**：菜单条「查看」+ 命令面板 + 编辑器右键菜单三入口，弹层实现参照现有弹出层模式（foot-menus / quick-switch），按文件分组列出「路径 · 行号 · 行内容片段」，条目悬浮出删除按钮，点击跳转。**不做**虚拟文档标签页（书签是瞬态导航，不值得占内容区标签位）。

## 动作定义

| 动作 | 参数 | 计划模式 | 说明 |
|---|---|---|---|
| `list_bookmarks` | `{}` | 放行 | 列出全部书签（打开中 + 已记录的关闭文档），按文件分组：`path:line 行内容片段`；无书签返回明确空态文案 |
| `add_bookmark` | `{path?, line}` | 拒绝 | path 缺省 = 当前激活文档；未打开则打开；line 1-based 越界 clamp 并回报实际行 |
| `remove_bookmark` | `{path?, line}` | 拒绝 | 未命中该行书签时报错列出该文件现有书签行 |
| `clear_bookmarks` | `{path?}` | 拒绝 | 清空指定/当前文档全部书签；path 缺省 = 当前激活文档 |
| `goto_bookmark` | `{path, line}` | 放行 | 跨文件跳转（打开 + 定位）；与 `goto_line` 的分工在描述里写明：goto_line 只在当前文档内，goto_bookmark 可跨文件打开 |

技能表边界声明（`ai-constants.js:327-335`「不保存/不删文件」）不受影响——书签是界面状态，非文件内容。

## 改动清单

**前端**（无 Go 改动）：
- `ai-constants.js`：cadt-ui 技能动作表加 5 行（一条一个动作的格式）；边界段如有必要补一句书签语义。
- `ai-tool-defs.js`：app_control 常驻 description 点名书签动作族（保证可发现性，memo 先例）。
- `main.js`：`APP_ACTIONS` 加 5 项；`runAppAction` 加 5 个 case（复用 `openPaths` / `selectLineInDoc` / editor-doc-extras 导出面；`knownDocViews` 的合并读取若跨模块不便，由 session-restore 导出一个只读 `bookmarksSnapshot()` 帮手，getter 注入）。
- `ai-panel.js`：app_control 分支的计划模式 per-action 拦截清单加 3 个写动作（含拒绝文案，memo 先例样式）。
- `editor-doc-extras.js`：补 `clearDocBookmarks(doc)`（若无）；`addBookmarkAt(doc, row)` 帮手（复用 toggle 逻辑的去重版）。
- 新增 `src/editor/bookmark-list.js`：总览弹层（数据聚合纯函数 + 渲染分离，聚合函数可单测）。
- 入口接线：`menu-bar.js`（查看菜单项）、命令面板（main.js actions）、编辑器右键菜单（`editor-menus.js`）、`core/keybindings.js`（可选：书签总览快捷键）。

**测试**：
- `test/ai/ai-app-actions.test.mjs`：三方对账自动覆盖新动作（无需改守卫本身）。
- 计划模式拦截：照 `ai-mcp-config.test.mjs:102-112` 模式断言拦截清单与拒绝文案。
- `test/editor/bookmark-list.test.mjs`：聚合/分组/排序纯函数（1-based 输出、按路径排序、内容片段截断）。
- 全部登记进 `frontend/package.json` npm test 清单。

**文档**：CHANGELOG.md、README 书签小节；`docs/skills/` 下的应用技能文档如提及 app_control 动作需同步。

## 手动冒烟清单（实施后）

1. F11 打几个书签 → 总览弹层按文件分组显示、点击跨文件跳转、悬浮删除生效。
2. AI：`list_bookmarks` 返回带行内容片段的清单 → `goto_bookmark` 打开对应文件并定位 → `add_bookmark` 后 gutter 紫标出现、`list_bookmarks` 能看到 → `remove_bookmark` / `clear_bookmarks` 生效。
3. 计划模式：三个写动作被拒，`list_bookmarks` / `goto_bookmark` 可用。
4. 未打开的文件 `add_bookmark`：文件被打开、书签落位、总览可见。
5. 重启应用：书签随会话快照恢复（现状能力回归）。
6. 关闭 app_control 开关：工具不下发、技能隐藏（现状回归）。
