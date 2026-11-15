# AGENTS.md

## 项目概述
CaDt-DataLens 是一个面向 Windows 的轻量级多格式数据查看与编辑器（JSON/JSONL、YAML、XML/SVG、CSV/TSV、TOML、INI/Properties、Markdown、代码文本、图片、二进制）。

技术栈：Go 后端 + Wails v2（原生窗口 + Windows WebView2）+ 原生 JS 前端（Vite 构建，Ace / jsoneditor / markdown-it / highlight.js）。

设计目标：**单 exe、零依赖、系统提供引擎**——不自带 Chromium、不打包 Node、不做项目索引。许可证 Apache-2.0。

## 目录结构
> 根目录是扁平 Go 包 `main`，没有顶层 `src/`。

### Go 后端（仓库根）
- `main.go`：Wails 启动配置、窗口选项、`//go:embed all:frontend/dist` 资源内嵌、单实例锁
- `app_core.go`：App 结构与生命周期（startup/domReady/单实例）、命令行目标与启动参数解析；`const appVersion` 在 `app_core.go:22`
- `app_file.go` / `app_fs.go` / `app_window.go`：文件读写与编码（opensave/外部修改校验/图片判定）· 目录与条目操作（列举/增删改移/落盘/对话框）· 脏标记/应用配置/多窗口与资源管理器定位
- `appdata.go` / `logging.go` / `app_pathinfo.go`：应用数据目录、日志、路径信息
- `ai_types.go` / `ai_chat.go` / `ai_http.go` / `ai_sse.go` / `ai_validate.go` / `ai_stream.go`：AI 后端——类型与载荷 · Wails 入口（发消息/停止/看门狗/连通性/目录）· 双协议 URL/头/体与重试 · SSE 解码与 HTTP 客户端/代理 · 参数校验 · 增量合并缓冲
- `ai_gen.go`：生图/视频执行通道（哑通道两绑定：`AIGenHTTPRequest` 按前端渲染好的规格发同步 HTTP、`AIGenSaveProducts` 产物解码/下载 + 工作区路径校验落盘 `.cadt/gen/`；模板渲染/提取/轮询在前端 `ai-gen-model.js` / `ai-gen-jobs.js`，方案见 `docs/finished-plans/ai-gen-models.md`）
- `ai_float.go` / `ai_proxy_*.go` / `ai_command_windows.go`：AI 浮窗、代理、命令执行
- `sessionstore*.go` / `sessionlock*.go`：AI 会话磁盘存储（追加式 JSONL、每会话 meta、原子替换、fsync 回滚、跨进程写锁、回收站删除）
- `aiconfig*.go`：AI 配置 `ai-config.json` 的原子读写（0600）
- `sessionindex*.go`：AI 会话 SQLite **派生**搜索索引（modernc pure Go，JSONL 为唯一真源）
- `timer.go`：AI 计时工具的 Go 侧计时器（纯内存不持久化，倒计时 `time.AfterFunc` 到点 EventsEmit `ai-timer-fired`；注册表回调化便于测试；应用总上限 30 / 会话内 5（运行中计数，done 不计入；会话内上限由前端按会话归属判定）/ 单个 24h）
- `ai_worklog.go`：AI 工作日志（工作区 `.cadt/logs/` 三层：根 INDEX.md 每月一行 → `{YYYY}/{MM}/INDEX.md` 每条一行**且只放标题一句话** → 当日 md 正文含标题 + 一句话摘要；追加式 + 跨进程锁；只存标题 + 一句话摘要）
- `activity.go`：操作留痕（追加式 JSONL、按月分文件滚动分段、跨进程写锁、保留清理；只存操作摘要，不存正文与密钥）
- `sqlview*.go`：CSV/TSV/JSONL 的只读 SQL 查询（导入临时 SQLite，不修改原文件）
- `patch_types.go` / `patch_parse.go` / `patch_match.go` / `patch_plan.go` / `patch_write.go`：`.patch` 类型与错误 · 解析（含 git 引号路径）· 严格匹配与 hunks · 计划构建与 `.cadt/patches` 索引 · 两阶段写入（atomic / partial）与字节快照撤销
- `patch_review.go`：只读审阅的纯解析 `PatchParseText`（只切文件/hunk/行，不 buildPatchPlan、不读目标文件、不生成 planId）+ 与预检共用的 `patchHunkToOut` 行号组装；AI 汇总卡「审阅」走它，`patch-view.js` 的 `doc.patchReview` 分支只渲染、不预检不应用
- `patch_app.go` / `patch_cli.go` / `patch_platform_*.go`：Wails 薄包装 · CLI 的 `--check-patch` / `--apply-patch` / `--revert-patch`（不启动窗口）· 平台差异。核心逻辑是不依赖 App 的自由函数，CLI 与界面共用
- `storage_app.go` + `internal/storage/`：设置 → 存储与清理的壳与引擎（见下方「internal 包」）。
- `browser*.go` / `devtools_*.go`：内嵌浏览器、开发者工具
- `search.go`：工作区内容搜索（有 `searchBudget`、`searchMaxFileSize` 等硬预算）；`SearchWorkspaceFiltered` 把文件名通配下推到搜索层（rg `--glob` / 内置扫描遍历时过滤），AI 的 `search_text` 用它
- `glob.go`：AI `glob` 工具的后端（`FindFiles` 列文件与大小 + `globMatchPath` 通配匹配；语义与 `frontend/src/ai/ai-file-tools.js` 的 `globMatchPath` 一致、两边用例互相对齐，测试 `glob_test.go`）
- `structuredir.go`：结构化目录导出
- `plugins.go` / `skills.go` / `market.go` / `update.go`：插件、技能注册（`docs/skills` 经 `go:embed` 分发，内置技能首次列出时物化到应用数据 `builtin-skills/`）、市场、检查更新
- `gitinfo.go`：Git 分支/提交面板后端
- `delete*.go`、`envvars*.go`、`terminal_windows.go`（内置终端 ConPTY 会话 + `TermCreate/Write/Resize/Close/Shells` 绑定；AI 读输出用的 64 KiB 环形缓冲与 `TermRead` / `TermList` 也在这里）、`toolchain_windows.go`、`integration_windows.go`、`installer_cli_windows.go`、`notify_windows.go`、`cursors*`、`windowicon*`：Windows 能力与注册表集成
- `run.go` / `run_shells_*.go`：运行代码（`PrepareRun` 临时副本与工作目录、`RunExec` 流式执行 + GBK 解码 + PATH 前置、stdin 队列 `RunInput` / `RunEndInput`、`RunStop`、临时目录清理）；配方与语言知识在前端 `src/run.js`，Go 侧只负责起进程
- `run_project.go`：项目感知运行（`DetectRunProject` 只读探测项目标记与候选命令，遇 `.git` / 用户主目录停止）；执行仍走 `RunExec`，确认在前端
- `app_dialogs.go` / `app_commands.go` / `app_preview_assets.go` / `app_debugconsole.go`：对话框、命令注册、预览资源、调试控制台
- `*_test.go`：与同名源文件对应的单元测试

> **`package main` 只能在仓库根**：`//go:embed all:frontend/dist` 与 `frontend/wailsjs/go/main/` 都以根目录为前提，`type App` 与全部 Wails 绑定方法必须留在根。所以根目录的分类靠**文件名前缀 + 同包拆文件**。
>
> **纯引擎可以下沉 `internal/<域>`**（2026-11-16 起按 `docs/unfinished-plans/go-layout.md` 分批执行）：引擎包不 import main、不碰 App，位置与外部动作一律经 `Deps` 注入，根目录留一个 `*_app.go` 壳做挂名绑定。已落地：`internal/storage`（存储与清理，壳 `storage_app.go`）。待抽：`internal/patch`、`internal/mcp`、`internal/sqlview`、会话存储族——判定与批次见该方案。**平台 glue（`*_windows/_other` 成对文件）留在根是本分**，不要摊进 internal 包。

### 前端 `frontend/`
> 2026-11-14 目录归位：`src/` 顶层只留 `main.js`，其余按域进目录。**Go 的目录即包，前端的目录只是分组**——新增模块直接放进对应域目录，不要往顶层加文件。

- `src/main.js`：组合根与核心枢纽（标签页核心状态、命令面板、菜单注册表、初始化接线，约 4,400 行）。域逻辑已拆到下列目录，每个模块都是「factory + 显式依赖注入」——依赖一律经 `deps` 延迟求值（main.js 传 getter），不依赖声明顺序；改动某域时先找到对应模块，不要往 main.js 回填
- `src/core/`：跨域共享的纯逻辑与无状态工具
  - `formats.js` 格式驱动层（parse / stringify，插件格式也走这里）· `markdown.js` 共享 Markdown 渲染/sanitize（规则单一来源）· `diff.js` 行级与结构化 diff · `jsonpath.js`/`jsonrepair.js`/`jsonschema.js` JSON 工具 · `icons.js`/`fileicons*.js` 图标 · `image-clipboard.js` · `writing.js` 写作纯函数 · `activity-log.js` 操作留痕前端服务（脱敏 sanitizer、攒批 ≤200ms/20 条调 `ActivityAppend`）· `readonly.js` 只读判定单一来源（全局锁 `settings.readOnlyMode` + 标签锁 `doc.readOnlyLocked` + 固定锁 `doc.readOnlyFixed`（审阅快照，不可解锁、不给解锁菜单）+ 大文件/二进制；新增编辑能力判定一律走它） · `tooltip.js` 全局 tooltip 运行时（`data-tip` 属性驱动替代原生 title：委托监听 mouseover/focusin 显示、滚动/点击/Esc 隐藏，位置下方优先越界翻转。**显示时机**：普通 `data-tip` 要停留 `SHOW_DELAY_MS`(1s) 才出——扫过一排按钮一个都不该弹；气泡刚消失后 `WARM_WINDOW_MS` 内再贴到别的锚点只等 `RESHOW_DELAY_MS`(150ms)（Windows TTDT_RESHOW 语义：initial 0.5s / reshow 0.1s，macOS 是 1s，别再回到悬停即弹）；设置页 `.info-tip` 的 ⓘ 必须立即出（`::after` 版本已删）；`data-tip-delay="<ms>"` 单点覆盖（0 = 立即）；气泡还在屏时切相邻锚点立即换内容；键盘 focusin 立即。**别乱挂**：只给「图标看不出是什么」的动作按钮、快捷键提示、被截断文本的补全文挂 tooltip；面板/卡片标题行、自明的展开收起箭头（树 chev、任务卡头、思考卡头）一律不挂——鼠标路过就冒泡等于噪音，折叠语义交给 `aria-expanded`。触屏粗指针点击 ⓘ 切换气泡；全仓 `.title =` 赋值已改为 `.dataset.tip =`，`document.title` 与 iframe 的 title 除外；护栏 `core/tooltip.test.mjs`）
  - `widget.js`：AI 回答里 `svg`/`html`/`mermaid`/`echarts`/`graph`/`wordcloud` 围栏的可视化卡片（Shadow DOM + DOMPurify；只有 AI 面板传 `env.aiWidgets` 时启用）。异步引擎卡片动态 import 下列渲染模块、vendor 按需加载，产物仍是静态 SVG 走同一条清洗管线；SSR 结果按内容+主题 LRU 缓存、`data-theme` MutationObserver 触发重渲染、断连登记表清扫（sweepAsyncMaps）；卡片带源码/复制/**另存为**（`.cadt/answers/`）。**借驻 core**：`markdown.js` 依赖它，挪进 `ai/` 会形成 core→ai 反向依赖；配套技能 `inline-visual`/`answer-me-with-html` 规则单一来源在 `visual-spec.js`
  - `visual-spec.js` 可视化规范单一来源（SHADOW_STYLE 别名表、尺寸/数量预算、inline-visual 技能全文、决策表、`resolveThemeColors` 计算样式读色）· `render-cache.js` 内容+主题 LRU
  - `mermaid-render.js`（mermaid 懒加载出图，与 editor/markdown-mermaid.js 共用 vendor、各自独立）· `chart-render.js`（ECharts option 纯 JSON 白名单校验 + SSR 静态 SVG：禁 formatter/rich/外链、强制关动画、实例用完即 dispose）· `layout-render.js`（```graph 关系图 ELK 布局，3s 超时弃实例、简单分层兜底）· `wordcloud-render.js`（词云：echarts-wordcloud SSR 优先，产物无 `<text>` 退 d3-cloud 自拼；d3-cloud@2 是 ES module，走 @vite-ignore 动态 import）
- `src/editor/`：编辑器内核（统一模式 `createEditor<域>(deps)`，deps 与 editor-groups 共用 main.js 的 getter 集经 Object.create 委托）
  - `editor-groups.js` 编辑器组/分栏（二叉分割树）、标签页 chrome、DnD、面包屑、createDocEditor 分发、文档生命周期 · `editor-ace-hooks.js` Ace 会话钩子（模式切换、折叠范围调整——import 圆括号块折进括号、折叠行悬停预览、多光标、python token 染色） · `editor-csv-view.js` CSV/TSV 表格族 · `editor-split-preview.js` 分屏与预览视图族 · `editor-sql-view.js` 大文件 SQL 视图 · `editor-browser-tab.js` 浏览器标签页 · `editor-doc-extras.js` 横幅/折叠预览/书签/视图记忆/git gutter · `editor-export-menus.js` md 块渲染/SVG 导出/右键菜单 · `editor-menus.js` 编辑器右键菜单
  - `structure.js` 17 种语言结构解析（纯函数）· `structure-panel.js` 结构面板控制器（Worker + 缓存 + 导出）· `structure-worker.js` 解析 Worker（`new URL('./structure-worker.js', import.meta.url)`，**必须与 structure-panel 同目录**）
  - `patch-view.js` 补丁视图（只渲染，解析与写入走 Go；`doc.patchReview` 为只读审阅分支：无预检/应用/撤销，走 `PatchParseText`）· `find-bar.js` 查找替换 · `json-query.js` JSONPath 查询栏 · `schema-panel.js` Schema 校验面板 · `format-convert.js` 格式互转 + JSON 修复 · `diff-dialog.js` 双文件对比对话框 · `foot-menus.js` 状态栏底部弹出层（编码/换行/视图/缩放宽度）· `markdown-mermaid.js` 共享 md 渲染器实例 + mermaid 出图
- `src/explorer/`：资源管理器与工作区检索
  - `explorer.js` 文件树（惰性加载 + 缓存 + 自动刷新）与扁平列表视图（带目录数/深度/条目硬上限）· `explorer-ops.js` 路径改码/文件剪贴板/新建重命名删除 · `global-search.js` 工作区全局搜索
- `src/shell/`：窗口外壳与应用级动作
  - `menu-bar.js` IDEA 新 UI 菜单条 · `titlebar-popovers.js` 标题栏弹层壳（定位工具 + 图标）· `titlebar-project.js` 项目弹层/克隆 · `titlebar-git-branch.js` Git 分支弹层 · `mode-switch.js` 模式切换（含留痕）· `palette.js` 命令面板 · `quick-switch.js` 快速切换器 · `contextmenu.js` 右键菜单 · `app-actions.js` 退出/最近打开 · `app-links.js` 外链与内置文档 · `update-check.js` 更新检查 · `properties-ui.js` 属性对话框 · `cursor-themes.js` 系统光标主题 · `session-restore.js` 布局持久化 · `image-lightbox.js` 图片灯箱 · `message-center.js` 状态栏消息中心 · `plugins.js` 插件运行时（加载插件 JS、`cadt.*` API、格式/命令/主题注册生命周期）
- `src/settings/`：设置页——`settings-ui.js` 核心（主题/字体/只读锁/`applySettings`/集成状态/字数统计）· `settings-dialogs.js` 对话框族（遮罩栈/关于/保存冲突/命名）· `settings-select.js` 行式下拉增强 · `settings-search.js` 设置搜索 · `activity-pane.js` 操作记录面板 · `settings-pane-run/plugins/envvars/lang.js` 四个 pane（运行配置 · 插件与市场 · 环境变量 · 格式与语言工具链）· `settings-pane-patches.js` 补丁库列表（开发者页内）· `settings-pane-storage.js` 存储与清理（占用统计 · 一键清缓存 · 勾选清数据；条目与删除都在 Go 侧 `internal/storage`，本模块只渲染与传 id，纯函数配 `settings-pane-storage.test.mjs`）。后三个在 main.js 里 `createSettingsPaneXxx({getter deps})` 直接接线，`selectSettingsPane` 按 `data-pane` 回调
- `src/writing/`：`writing-mode.js` 写作模式（生效判定/chrome/字数/排版整理/起名器/goto）· `writing-ui.js` 壳（LANG_DEFS、视图与编码常量、`readonlyTipObserver`、`flash`/脏标记/自动保存，返回面 22 显式键 + 六模块 spread）
- `src/bridge/`：`bridge-ui.js` 进程桥/虚拟文档/浏览器标签 + 启动编排 IIFE；`bridge-terminal-view.js` 后台终端视图 · `bridge-agent-view.js` 子代理详情标签页（正文渲染归 `ai/ai-subagents.js`，这里只管建标签页与挂载容器）· `bridge-git.js` git 浅集成 · `bridge-cli-convert.js` `--convert` 转换
- `src/terminal/`：`terminal-ui.js` 终端面板/dock/侧栏 git 面板 · `terminal-sessions.js` 会话管理 · `run.js` 运行配方与输出渲染（纯函数，`run.test.mjs`）· `run-ui.js` F5 接线 · `debugconsole.js` 调试控制台（底部面板一档）
- `src/ai/`：AI 助手，按域拆为兄弟模块（统一模式：`createAI<域>(ctx)` 工厂 + ctx 注入，重赋值状态经 getter/setter 访问器，互引经惰性转发箭头；测试与源码同目录）。`ai-panel.js`（约 1.2 万行核心编排：`executeTool`、回合流程、会话持久化、消息渲染、三形态、init）；`ai-system-context.js`（系统提示词组装域：`<workspace_rules>` 守则 / `<plan_mode>` / `<output_language>` / 附件块与 `assembleSystemContext` 按稳定→动态拼装，面板闭包状态经 ctx getter 注入）；数据/常量类：`ai-constants.js`、`ai-session-store.js`（JSONL 编解码/重放）、`ai-session-disk.js`（磁盘适配）、`ai-config-model.js`、`ai-permissions.js`、`ai-read-roots.js`（工作区外读取的授权判定纯函数：用户点名 `userNamedPath` / 已批准读根 / 应用数据目录硬拒；按档授权链 `resolveReadPathWithApproval` 在 ai-panel.js——read/edit 档弹审批卡、auto/full 直读、子代理不弹卡报回主代理）、`ai-command-rules.js`、`ai-git.js`、`ai-app-message.js`、`ai-tool-args.js`、`ai-file-tools.js`（AI 文件工具纯函数：`read_file` 窗口切片（offset/limit 字符分页 + startLine/endLine 行号模式带前缀与续读提示）、`edit_file` 定位（默认唯一命中 / replaceAll 全量替换 + CRLF 兜底）、humanSizeBytes、globMatchPath；`executeTool` 的 list_dir/read_file/search_text/edit_file 调用，测试 `ai-file-tools.test.mjs`），`ai-session-tools.js`（跨会话检索工具的纯函数：`formatSessionSearchResult` 会话分组渲染、`sessionLogDigest` 用 `replaySessionLog` 把会话 JSONL 摘成「头部 + 若干条消息」（query 定位命中及前后各一条、8000 字符预算、跨工作区标注），测试 `ai-session-tools.test.mjs`），`ai-terminal-tools.js`（terminal 工具纯函数：ANSI/OSC 清洗 `stripAnsi`、`\r` 重绘归一 `normalizeTermText`、`formatTerminalRead` / `formatTerminalList` 整形、`terminalSendLabel` 审批展示，测试 `ai-terminal-tools.test.mjs`），`ai-image-encode.js`（图片载荷编码**单一来源**：扩展名白名单 `isReadableImagePath` / 等比缩放 `fitImageSize` / 画布 PNG→JPEG 降质 `encodeCanvasPayload` / 文件与 data URL 解码 `prepareImagePayload`；输入框附图与 `read_image` 工具共用同一条链，测试 `ai-image-encode.test.mjs`），`ai-gen-model.js`（生图/视频条目数据层：`genModels[]` 归一化 + 通用输入输出模板渲染（占位符一律 JSON 字面量）+ 响应提取点路径 + 预设表，纯函数可单测）、`ai-gen-jobs.js`（生成任务运行时：同步执行 / 异步 submit→poll→落盘 注册表、check/stop、完成经信箱唤醒会话；Go 侧是哑通道见 `ai_gen.go`）、`ai-tool-defs.js`（**工具声明单一来源**：定义表 `AI_TOOL_DEFS` + 权限档清单 `toolsForScope` + 工具目录数据 `AI_TOOL_CATALOG` / 组注册表 `AI_TOOL_GROUPS` 与 `<tool_catalog>` 渲染；目录独立成表不内联进 def——def 对象原样发给 API；作者规则 2026-11-15：**新增工具必须写进目录**，测试强制 def↔目录一一对应）、`session-outline.js`（结构面板的会话定位条）；UI 域类：`ai-write-guard.js`（write_file 陈旧缓冲防护：覆盖已存在文件前必须先 read_file）、`ai-session-list.js`、`ai-composer.js`、`ai-tool-cards.js`、`ai-takeover.js`、`ai-todos.js`、`ai-changes-ui.js`、`ai-schedule.js`、`ai-reminders.js`（reminder_* 工具 + 标题栏铃铛，每轮 `<task_reminders>` 注入）、`ai-timer.js`（头部胶囊 + 弹层；Go 侧计时，到点唤醒会话）、`ai-git-ui.js`、`ai-slash.js`、`ai-message-queue.js`、`ai-manage-dialogs.js`、`ai-settings-dialog.js`（设置页壳：ctx 解包 + 状态条 + 640 行 `bindSettingsPane` 绑定器）、`ai-permission-settings.js`（审批授权/会话与项目级规则/端侧分类器/审批记录）、`ai-preference-settings.js`（偏好清单/预设账号/系统提示词）、`ai-model-settings.js`（模型条目与编辑器状态机/窗口与思考预算）、`ai-gen-settings.js`（设置 → AI → 生图与视频 pane：条目列表/编辑器居中弹窗/测试连接）、`ai-settings-io.js`（配置导入导出）、`ai-subagents.js`（子代理运行时：`startSubAgent` 派单拆建/等两段、`subAgentRecords` 终态 LRU 20、`sub.inbox` 双队列收件箱（step 插队 / turn 排队，唯一消费点在 `runSubRound` 开头）、冷唤醒、`subCompacts` 压缩注册表 + 轮边界 auto-compact、HUD chips/详情视图（含停止与压缩按钮、收件箱预览））、`ai-agent-notices.js`（**会话信箱单一注入通道**：三态投递 忙→下轮边界 / 压缩中→排队 / 闲→`startSessionTurn` 唤醒，唤醒单飞、被拒内容退回队列；`buildSettlementNotice` / `buildAskNotice` 纯函数；会话间投递 `session_send` 守卫矩阵与逐目标回执）、`ai-sidechat.js`（支线对话动作域：`sideOf` 旁路会话的创建/引用预填/带回主对话/提升独立）、`ai-session-send.js`（会话投递的选择器 UI：搜索 + 多选 + 键盘 + 内容预览，`filterSessionRows` / `togglePicked` 纯函数可单测；传输走 ai-agent-notices 的 `deliverToSessions`）、`ai-compact.js`（压缩应用内核：cutoff 回退到 user 轮边界、summary 形状、messages 裁剪、压缩请求组装，主会话与子代理共用）、`ai-classifier-verdict.js`、`ai-local-classifier.js`（端侧命令分类器：int8 推理/严格度/插件分类器聚合/个性化；权重 `local-classifier-weights.mjs` 由 `scripts/train-local-classifier.mjs` 生成、勿手改）
- `src/reading/`：阅读模式（`reading.js` 控制器、`reading-model.js` 纯函数 TOC/排序/进度、`reading-state.js` localStorage、`reading-view.js` 书架/详情/目录 DOM、`reading-render.js` md/txt/docx/epub + LRU、`reading-search.js` 查找、`reading-tts.js` 朗读）；Go 侧对应 `reading*.go`；方案见 `docs/finished-plans/reading-mode.md`；**只读，禁止调用写接口**
- `src/dev/mock-backend.js`：vite dev 浏览器调试用的 mock 后端，main.js 在 `!hasWails && import.meta.env.DEV` 时**动态 import**（`import.meta.env.DEV` 守卫让 rollup 在生产构建里整段剔除，否则会产出一个 66 KB 的 chunk 被 go:embed 带进 exe）；改 mock 场景只动这里
- `src/style.css`：布局、主题、Ace/jsoneditor 样式；`src/reading.css`：阅读模式样式（`.rd-` 前缀）
- `index.html`：窗口结构、菜单、设置对话框
- `public/vendor/`：jsoneditor、mermaid 等第三方资源，以及 AI 可视化引擎 echarts（1.07 MiB）/ elk（1.57 MiB）/ wordcloud 两件（~52 KiB，均懒加载，许可见 `licenses/`）；`public/fonts/`：Inter / JetBrains Mono / Fira Code（OFL）
- `wailsjs/`：Wails 自动生成的绑定，**不要手改**
- `dist/`：构建产物，经 `go:embed` 编进 exe，**不要手改**

### `docs/`
- `packaging.md`（打包与发布）、`plugins/`、`skills/`、`samples/`、`screenshots/`、`icons/`、`legal/`
- `finished-plans/`：已实施完的方案存档（`ai-panel.md`、`ai-panel-v2.md`、`ai-panel-v3.md`、`ai-head-agents-terminal.md`、`operation-audit-log.md`、`writing-mode.md`、`reading-mode.md`、`visualizer.md`、`mcp-client.md`、`ai-personalization.md`、`local-command-classifier.md`、`ai-gen-models.md` 等）
- `unfinished-plans/`：未开工/进行中的方案（目前：`frontend-split-phase3.md`、`go-layout.md`、`subagent-sandbox.md`、`ai-gen-image-edit.md`）；全部实施后移入 `finished-plans/`
- `icon-guidelines.md`
- `reports/optimization-proposals.md`：体积与性能优化提案（含实测体积基线）

### 其他
- `build/`：Wails 构建资源与 `build/bin` 产物；`build/windows` 放 NSIS 脚本
- `scripts/build-installer.ps1`：构建 + 代码签名
- `tools/rebuild-exe.ps1` + `tools/rebuild-exe.cmd`（双击入口）：一键构建并替换根目录便携副本 `datalens.exe`——测试门（Go + 前端）通过才构建、失败可复制剪贴板给 AI 修复或强行构建；运行中实例优雅关闭 / 改名让路（见脚本头注释）
- `plugins/`：随仓库分发的插件样例（如 `scene-carousel`，含欢迎页轮播与 AI 空态看板娘换装）
- `.cadt/`：本应用 AI 助手的本地状态（`memory/` 记忆 · `plan/` 计划模式产出的计划正文 · `patches/` 补丁库 · `logs/` 工作日志 · `gen/` 生图产物 · `answers/` HTML 回答页）

## 约定

### 通用
- 回答使用中文；代码注明语言。
- 修改文件前先读取确认；不要改动与任务无关的内容。
- 新增依赖或改变目录结构时说明原因。
- **体积是第一约束**：任何新依赖先问「能否不引入」，体积预算为 0 的改动优先。
  - 不打包 Chromium / Node / ripgrep / SQLite / LSP。
  - **SQLite 例外（作者批准的派生索引，均不存真源数据）**：AI 会话搜索的 `ai-index.db`（2026-11-11 批准，实测整包 +3.9 MB）与 AI 定时任务的 `ai-schedule.db`（2026-11-12）。两者都是纯 Go `modernc.org/sqlite`、可随时删除重建（JSONL / 触发指令原文仍是真源）。**不要**把设置、偏好、模型配置或会话正文搬进 SQLite。
  - **可视化引擎例外（作者批准的 AI 能力扩展，预算 ≤5 MB，2026-11-13 定）**：ECharts 6（1.07 MiB）+ ELK.js 0.12（1.57 MiB）+ 词云两件（~52 KiB）放 `public/vendor/` 懒加载，合计 +2.69 MiB（逐字节实测），全部只产出静态 SVG、不持有活动实例，禁脚本边界不变；能力优先于体积仅限本次，方案见 `docs/finished-plans/visualizer.md`。**不要**拿这个例外给别的依赖开绿灯。
  - 重型前端库（mermaid 2.57 MB 是当前天花板）必须**懒加载**，参考 `main.js` 的 `ensureMermaidScript()`。
  - 明确否决过的方向见 `docs/reports/optimization-proposals.md` 第四节（换 Monaco、内置 SQLite、全项目索引、内置 LSP、打包 rg）。

### 代码规模与质量红线（写码必读）

> 2026-11-14 定，源自 phase 2/3 前端拆分与历次带病提交的实测教训。行数不是目标，职责单一才是；每条红线背后都有真实事故。

**文件规模**
- 新建源码文件目标 ≤ 1500 行，**硬上限 3000 行**（Go 与前端同规）；豁免类不计上限：测试文件（`*_test.go` / `*.test.mjs`）、样式、HTML、表驱动常量（`structure.js`、`run.js`、`ai/ai-tool-defs.js`、`ai/ai-constants.js`、`dev/mock-backend.js`）。
- 拆分信号看职责不看行数：文件里出现第二个互不相关域（靠分节注释隔开的两类功能）就必须拆，几百行也不留——「现在无痛拆」的成本远低于「将来被迫拆」。
- 存量超线文件「只减不增」：不往里加新域，改动到哪顺手收敛到哪。当前超线（2026-11-14 实测，按 3000 行口径）：前端 `ai/ai-panel.js`（1.1 万行，拆分方案另立）、`main.js`（4.4k 组合根）；Go 侧无超线。

**函数与命名**
- 函数 < 200 行，参数 ≤ 5 个，嵌套 ≤ 4 层；超限拆辅助函数。
- 新导出名先 grep 全仓防撞（`createStructurePanel` 重名教训）；文件头保留 2–3 行职责注释（现有模块惯例：`// xxx.js：...`）。

**依赖与状态**
- 依赖单向：main.js → 域模块 → 纯函数模块（formats/structure/markdown 等）；域模块之间不互相 import，跨域一律经 deps/ctx 注入或组合根接线；禁止反向 import main.js；不引入循环依赖。
- 导出可变 let 状态一律 getter 活引用，禁止值快照（splitRoot 教训）；跨模块回写走宿主 setter。

**错误处理**
- 禁止空 catch 吞错；`.catch(() => {})` 仅限尽力而为路径（事后清理/状态同步）并注明忽略原因。
- `console.assert` 不中断执行，禁止当校验用；关键不变量显式 throw。
- 用户可见错误走 flash/状态栏；诊断信息走调试日志（debug-console.jsonl），不要弹窗打断用户。

**验证与提交**
- 新增/修改纯逻辑必须配测试：Go 表驱动 `*_test.go`；前端 `*.test.mjs` 与源码同目录，**并登记进 `npm test` 清单**（漏登记 = 测试从未跑过）。
- 提交前跑改动面的测试 + 构建；**测试/构建命令不许接 grep/tail 等管道核对结果**（会吞退出码，M3 带病提交教训），要看退出码本身。
- conventional commits + 中文描述（feat/fix/refactor/docs/test/chore/perf）；一次提交一个主题；重构类一批一 commit、可单独 revert；提交信息写明行为变化，提交前核对 `git show` 的 diff 与描述一致（d5ad6ac 教训）。

### Go 侧
- 平台相关代码按现有约定分文件成对出现：`xxx_windows.go` + `xxx_other.go`，不要在一个文件里堆 `runtime.GOOS` 判断。
- 新增导出方法后，`frontend/wailsjs/` 由 `wails dev` / `wails build` 重新生成。
- 新增/修改逻辑要补 `*_test.go`；现有测试多为表驱动，跟随即可。
- 文件大小硬限制（`app_core.go` 的 `largeFileBytes` / `maxFileBytes` / `imagePreviewLimit`，图片 hex 上限 `app_file.go` 的 `imageHexLimit`）：>10 MB 只读、>100 MB 拒绝打开、图片预览 32 MB、二进制 hex 1 MB。放宽限制前先确认性能。

### 前端侧
- `main.js` 是组合根（约 4,400 行）：改动前先按域找到对应模块（editor-groups / writing-ui / settings-ui / terminal-ui / bridge-ui / explorer-ops / structure-panel 等），不要把域逻辑回填进 main.js；新域一律新建模块（从 main.js 拆出的模块需要 deps 重写裸标识符，参考 explorer-ops 先例）。
- 域模块的约定是「factory + 显式依赖注入」：`export function createXxx(deps)`，依赖一律 `deps.X` 延迟求值，main.js 侧传 getter（`get X() { return X; }`）——不依赖声明顺序、不拍 let 快照。新增域照此办理，不要在模块顶层 import main.js 的绑定。
- 格式相关逻辑放 `formats.js`，结构解析放 `structure.js`，不要往 `main.js` 里塞新的格式分支。
- 界面设计原则：避免不必要的辅助标签与说明，让布局本身发挥解释作用（Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.）。
- **表单控件硬规范（2026-11-15 定）**：禁止新增裸 `<input>` / `<select>` / `<textarea>`（含 checkbox / radio），一律用 `core/form-controls.js` 的 `createSwitch / createSelect / createInput / createTextarea`（动态）或 `docs/frontend-form-controls.md` 里的静态 class 结构；设置页行式下拉用 `createSettingsSelect`。`style.css` 的 `:where()` 全局兜底只兜存量，不是继续写原生控件的许可；`core/form-controls-factory.test.mjs` 按文件基线卡新增，**基线只允许调小，不许调大**。
- Markdown 渲染链：markdown-it → DOMPurify → hljs / KaTeX / mermaid；涉安全的改动（sanitize、外链、内嵌 HTML）必须保守，**原始 HTML 不执行是硬要求**。
- 预览/表格等大 DOM 操作注意避免整段 `innerHTML` 重渲染。

### 文档与提交
- 用户可见的改动同步更新 `CHANGELOG.md` 与 `README.md` 对应小节。
- 方案文档放 `docs/unfinished-plans/`，全部实施后移入 `docs/finished-plans/`。
- 版本号三处需一致：`app_core.go` 的 `appVersion`（`app_core.go:22`）、`wails.json` 的 `productVersion`、NSIS 脚本（见 `docs/packaging.md`）。

## 常用命令

前置：Windows 10/11 + WebView2 Runtime、Go 1.26+、Node.js 20.19+（或 22.12+）、Wails CLI v2.17.1+。

```bash
# 环境检查
wails doctor

# 开发（热重载）
wails dev

# 构建 exe（产物 build/bin/CaDt-DataLens.exe）
wails build -devtools

# 一键构建并替换根目录便携副本 datalens.exe（tools/rebuild-exe.cmd 双击入口）：开头选是否跑
# Go 测试（1 进行 / 2 跳过只跑前端），测试门（Go + 前端）通过才构建，失败可按提示
# 「1 复制失败信息到剪贴板（粘贴给 AI 修复）」/「2 跳过测试强行构建」/其他退出；
# 自动优雅关闭运行中的实例，锁死时改名让路 datalens.running-old-*.exe、下次运行清理；
# -SkipTest 跳过测试门 / -KeepRunning 不停实例 / -Devtools 带调试面板
powershell -ExecutionPolicy Bypass -File tools/rebuild-exe.ps1

# 构建安装包（需 NSIS 3，makensis 在 PATH）
wails build -nsis -installscope user

# 构建 + 代码签名
powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1

# Go 测试
go test ./...

# 重训端侧命令分类器（产出 frontend/src/ai/local-classifier-weights.mjs，语料/硬指标在脚本内）
node scripts/train-local-classifier.mjs --version factory-YYYY-MM-DD-1

# 后端测试（含 Windows 集成测试）
go test -v -run 'Windows|Integrat' ./

# 前端单独调试（浏览器 + mock 数据）
cd frontend
npm install
npm run dev
# 打开 http://localhost:5173/
# mock 场景：?jsonl ?yaml ?xml ?csv ?text ?image ?line ?large ?invalid ?multi ?empty ?gbk
```

## 命令行能力（改动 CLI 时参考）

```bat
CaDt-DataLens.exe "D:\data\sample.json:42:8"
CaDt-DataLens.exe --line 42 "D:\data\sample.json"
CaDt-DataLens.exe -g "D:\data\sample.json:42"
```

支持 `--line/-l`、`--column/-c`、`--goto/-g`，行列从 1 开始；程序已在运行时新命令转发到现有窗口。
