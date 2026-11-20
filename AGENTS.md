# AGENTS.md

## 项目概述
CaDt-DataLens 是一个面向 Windows 的轻量级多格式数据查看与编辑器（JSON/JSONL、YAML、XML/SVG、CSV/TSV、TOML、INI/Properties、Markdown、代码文本、图片、二进制）。

技术栈：Go 后端 + Wails v3（一进程原生多窗口 + Windows WebView2）+ 原生 JS 前端（Vite 构建，Ace / jsoneditor / markdown-it / highlight.js）。

设计目标：**单 exe、零依赖、系统提供引擎**——不自带 Chromium、不打包 Node、不做项目索引。许可证 Apache-2.0。

## 目录结构
> 根目录是扁平 Go 包 `main`，没有顶层 `src/`。

### Go 后端（仓库根）
- `main.go`：Wails 启动配置、窗口选项、`//go:embed all:frontend/dist` 资源内嵌、单实例锁
- `app_core.go`：App 结构与生命周期（startup/domReady/单实例）、命令行目标与启动参数解析；`const appVersion` 在 `app_core.go:40`
- `app_window.go` / `app_fs.go`：脏标记/应用配置/多窗口与资源管理器定位 · 文件/文件夹对话框；文件读写与目录条目操作已下沉 `internal/fileio` / `internal/fsops`
- `window_app.go` + `windowmeta.go` / `window_factory.go`：**Wails v3 一进程多窗口**的窗口注册与会话复用——`windowmeta.go` 维护进程内窗口注册表（名字 / 形态 / 工作区 / 启动参数 / 每窗脏标记与 AI 状态），绑定方法经 `ctx.Value(application.WindowKey)` 归属调用方窗口（无上下文回退主窗口）；`window_factory.go` 创建主窗口（可多开 main/main-N）、AI 浮窗（float 单例）、调试控制台（debug 单例），每窗独立 WindowClosing / 导航完成钩子；`WindowRegister` / `WindowReuseForSession` 按工作区匹配存活窗口并直接投 `app-open-ai-session` 事件（v2 的文件注册表与信箱协议已在 P3 删除）；复用决策纯函数仍在前端 `ai-session-scope.js` 的 `decideSessionOpen`
- `appdata.go` / `logging.go`：应用数据目录、日志（文件属性在 `internal/fsops` 的 `GetPathInfo`）
- `internal/aichat/` + `internal/aitransport/`：AI 对话与传输——发消息/停止/流注册表/看门狗/连通性/目录（aichat）· OpenAI/Anthropic/Responses 三套请求构造 · SSE 解码 · 重试与空闲看门狗 · 参数校验与代理 · 事件契约（aitransport）；`ai_transport_app.go` 注入 Logf/Version/LogsDir/看门狗挂载点
- `ai_gen_app.go` + `internal/aigen/`：生图/视频执行通道（哑通道两绑定：`AIGenHTTPRequest` 按前端渲染好的规格发同步 HTTP、`AIGenSaveProducts` 产物解码/下载 + 工作区路径校验落盘 `.cadt/gen/`；模板渲染/提取/轮询在前端 `ai-gen-model.js` / `ai-gen-jobs.js`，方案见 `docs/finished-plans/ai-gen-models.md`）
- `ai_catalog_app.go` + `internal/aicatalog/`：模型配置表远端拉取/校验/appdata 缓存（字段归一在前端 `model-catalog.js`，Go 只搬原始文本）
- `ai_float.go` / `ai_command_windows.go`：AI 浮窗、命令执行
- `sessionstore_app.go` + `internal/sessionstore/`：AI 会话磁盘存储（追加式 JSONL、每会话 meta、原子替换、fsync 回滚、跨进程写锁、回收站删除）；**磁盘按工作区短哈希分桶** `<ai-sessions>/<ws 8hex>/<id>/`（桶名 `WorkspaceBucketKey` 与 wipe-guard 方案的 `ws` 字段同一约定；`NewBucketed` opt-in，`aigroups` 复用引擎仍按 groupId 平铺；现存目录永远赢，附件落盘绑定带 workspace）；引擎与 `Service` 绑定在包内，根壳只注入 AppDataDir 与派生索引标脏钩子；**回合租约** `AISessionLeaseAcquire/Release/Status` / `AISessionStat`（根门闩共享 + 会话独占，`.locks/<id>.turn.lease` 与 `<root>.gate` 都在会话目录之外；写路径 `withSessionLock` 另有短租约兜底）
- `internal/sessionlock/`：跨进程写锁（Windows LockFileEx / 其他平台 flock），sessionstore / activity / ai_worklog 共用；提供 `TryLockFile` / `TryLockFileShared` / `ErrLocked`
- `internal/resourcelease/`：跨进程资源写权租约（per-key refcount、共享/独占、`AcquireNoShare`、owner 提示、`Probe`；锁文件放在被保护目录之外）；memo / sessionstore / 存储清理共用，方案见 `docs/unfinished-plans/multi-instance-sync.md`
- `resource_watch_app.go`：多实例资源目录监听绑定（`MemoWatch/Unwatch`、`AISessionWatch/Unwatch`；Go 侧发 `resource-changed`，会话变更异步给派生索引标脏）
- `aiconfig*.go`（`internal/aiconfig`）：AI 配置 `ai-config.json` 的原子读写（0600）**与整份 DPAPI 加密**（Windows 文件前缀 `enc:v1:`，绑定当前用户与本机；旧明文读得懂、下次保存自动升级；解不开返回带 `AI_CONFIG_SEALED` 标记的错误，前端先用 `AIConfigBackupSealed` 把原文件改名留档再写，绝不静默覆盖）。加解密实现在 `internal/dpapi`（`envvars` 共用同一份 syscall）
- `ai_artifact_app.go` + `internal/aiartifact/`：**AI 工具结果大对象落盘区** `<应用数据>/ai-artifacts/<会话 id>/`（`AIArtifactWrite` / `AIArtifactClear` / `AIArtifactClearAll`）。超过阈值（内置 8 192 字符 / 外部工具 `mcp__`·`plugin__` 50 000 字符）的工具结果在回包时落盘，上下文里只发「头 4 K + 路径 + 读法 + 尾 1 K」指针（判定与文案在 `frontend/src/ai/ai-context-slim.js`，写盘失败或超 4 MB 退回修剪中段）。它是应用数据目录下**唯一对模型可读的子树**（`ai-read-roots.js` 的 `ARTIFACT_DIR_NAME`/`isArtifactPath` 放行且不走授权链），里面只有工具结果与子代理转录；删会话随删、另有 `ai-artifacts` 缓存条目进一键清缓存
- `sessionindex_app.go` + `internal/sessionindex/`：AI 会话 SQLite **派生**搜索索引（modernc pure Go，JSONL 为唯一真源；包内只依赖 Store 的 List/Read 最小接口）
- `timer_app.go` + `internal/aitimer/`：AI 计时工具的 Go 侧计时器（纯内存不持久化，倒计时 `time.AfterFunc` 到点 EventsEmit `ai-timer-fired`；注册表回调化便于测试；应用总上限 30 / 会话内 5（运行中计数，done 不计入；会话内上限由前端按会话归属判定）/ 单个 24h）
- `ai_worklog_app.go` + `internal/aiworklog/`：AI 工作日志（工作区 `.cadt/logs/` 三层：根 INDEX.md 每月一行 → `{YYYY}/{MM}/INDEX.md` 每条一行**且只放标题一句话** → 当日 md 正文含标题 + 一句话摘要；追加式 + 跨进程锁；只存标题 + 一句话摘要）
- `activity_app.go` + `internal/activity/`：操作留痕（追加式 JSONL、按月分文件滚动分段、跨进程写锁、保留清理；只存操作摘要，不存正文与密钥）
- `sqlview_app.go` + `internal/sqlview/`：CSV/TSV/JSONL 的只读 SQL 查询（导入临时 SQLite，不修改原文件）
- `internal/patch/`：`.patch` 引擎——类型与错误 · 解析（含 git 引号路径）· 严格匹配与 hunks · 计划构建与 `.cadt/patches` 索引 · 两阶段写入（atomic / partial）与字节快照撤销 · 只读审阅解析
- `patch_app.go`：补丁能力的 Wails 薄包装（参数整理、根目录解析、副作用分发）；落盘/去重/删除编排在包内 `SavePatch` / `DeletePatch`
- `internal/patchcli/`：CLI 的 `--check-patch` / `--apply-patch` / `--revert-patch`（不启动窗口），与界面共用 `internal/patch`；sidecar 与补丁文本读取在 patch 包
- `patch_review.go`：只读审阅的 Wails 入口（`PatchParseText` 转发 + 与预检共用的行号组装在包内）；AI 汇总卡「审阅」走它，`patch-view.js` 的 `doc.patchReview` 分支只渲染、不预检不应用
- `storage_app.go` + `internal/storage/`：设置 → 存储与清理的壳与引擎（`BeforeClear` 注入门闩：`memo` / `ws-memo` / `ai-sessions` 正在被另一窗口使用时拒绝清理）。
- `browser_app*.go` + `internal/browser/`：内嵌浏览器（WebView2 宿主、标签页、CDP 桥；引擎与集成测试在包内）；`devtools_*.go`：开发者工具（Wails 内部反射，平台 glue）
- 工作区检索 / glob：已下沉 `internal/search/`（`SearchWorkspace` / `SearchWorkspaceFiltered` / `FindFiles`；rg 两趟实现与产物档表在包内；目录树与搜索共用导出的 `SkipDir` 忽略表）
- `structuredir_app.go` + `internal/structuredir/`：目录结构树生成与导出（遍历与 ├── 渲染在包内，保存对话框与写盘留根）
- `internal/plugins/` + `internal/skills/`：插件与市场、内置技能（根壳 `skills.go` 只保留 `//go:embed all:docs/skills` 并把 `embed.FS` 注入包内；物化与注册在包内）
- `update_app.go` + `internal/update/`：检查更新（Gitee Release）；版本比较在 `internal/vercmp`
- `gitinfo_app.go` + `internal/gitinfo/`：Git 分支/提交面板后端（21 个查询/操作绑定，纯引擎；图谱布局交给 `git log --graph` 字形流，`graphglyph.go` 移植 Gitea 解析器上色、`graph.go` 压缩成 flow 路径，前端只渲染）
- `internal/terminal/`：内置终端 ConPTY 会话 + `TermCreate/Write/Resize/Close/Shells` 绑定与 AI 读取（64 KiB 环形缓冲 `TermRead` / `TermList`），App 以服务嵌入；输出按 4 KiB 分块推 `term-out` 事件（块尾不完整 UTF-8 序列攒住与下一块拼回再清洗，`utf8IncompleteTail` 纯函数）
- `internal/toolchain/`：语言环境检测（`DetectToolchain` / `ListLangPackages`），Windows 实现与包内 build tag
- `installer_cli_windows.go`、`cursors*`、`windowicon*`：Windows 能力与安装器（回收站删除与文件属性在 `internal/fsops`，底层回收站动作在 `internal/recycle`；notify / screenshot / watch / integration 已下沉 `internal/`）
- `reading_app.go` + `internal/reading/`：阅读模式扫描/解析/搜索（零状态引擎，日志与事件经钩子注入；启动缓存清理由根壳调用）
- `internal/run/`：运行代码（`PrepareRun` 临时副本与工作目录、`RunExec` 流式执行 + GBK 解码 + PATH 前置、stdin 队列 `RunInput` / `RunEndInput`、`RunStop`、临时目录清理）；进程取消表与命令桥共用 `internal/procctl`；配方与语言知识在前端 `src/run.js`，Go 侧只负责起进程
- `run_project_app.go` + `internal/runproject/`：项目感知运行（`DetectRunProject` 只读探测项目标记与候选命令，遇 `.git` / 用户主目录停止）；执行仍走 `RunExec`，确认在前端
- `envvars_app.go` + `internal/envvars/`：环境变量配置（DPAPI 加密、子进程注入合并 `MergeEnv`；平台加解密对随包）
- `webtools_app.go` + `webtools_config.go` + `internal/webtools/`：联网与外部工具——内置 Bing RSS 搜索 / 公网网页抓取 / 公网图片抓取（`FetchImage` → data URL 供 AI 的 `read_image` 看网图，与 `Fetch` 共用 `webValidateURL` 的 SSRF 与重定向校验，16 MB 上限、只信魔数），DeepSeek 工具 API 适配（搜索 / 抓取 / OCR / TTS / ASR，TTS 流式落盘 `.cadt/gen/tts/`，ASR 接受 20 MB 音频字节）；`webtools_config.go` 管 `<应用数据>/external-tools.json`（0600、apiKey 只掩码下发、空值保持）与五个能力来源配置；来源路由（含本地 MCP 转发）在前端 `executeTool`
- `internal/mcpsamples/`：内置 MCP 示例（根壳 `mcp_samples.go` 只保留 `//go:embed` 三份 `docs/mcp-samples` 脚本并注入 `embed.FS`；释放与 `mcp.json` 合并在包内）
- MCP「使用约定」：`mcp.json` 每个 server 可带 `notes`（≤1000 字），前端 `mcpNotesBlock` 拼成 `<mcp_server_notes>` 接在工具目录前注入系统提示词；`stripRuntimeFields` 剥离它，改备注不会重启 server
- `ai_usage_app.go` + `internal/aiusage/`：AI 账号余额/用量查询（`AIUsageQuery` 官方白名单引擎；`AIUsageHTTPRequest` 是额度外显的哑通道薄绑定，转发 `internal/aigen.HTTPRequest`，脚本管线与缓存在前端 `ai-usage-quota.js`，方案见 `docs/finished-plans/ai-quota-display.md`）
- `oauthquota_app.go` + `internal/oauthquota/`：通用 OAuth 额度引擎（Provider 配置驱动，引擎无厂商硬编码）——Hydra OIDC 登录（PKCE S256 + JWKS RSA-OAEP/SHA-1 封密码成 JWE + IAM 登录 + 授权码换 token）+ refresh 轮转 + 带 Bearer 查控制台，原始响应交前端脚本 extractor 解析；refresh token 按 providerID 存 `<应用数据>/oauth-<id>-credentials.json`（DPAPI 加密），密码不落盘、请求 URL 限在 provider 域名、不给 AI 暴露。当前内置 SenseNova Token Plan（照 dsh 插件实现），方案见 `docs/finished-plans/oauth-quota-template.md`
- `usage_stats_app.go` + `internal/usagestats/`：AI 使用统计的派生事实库（`ai-usage.db`，modernc SQLite，可随时删除重建）——两条写入路径：前端在主会话 `finishStream`、子代理 `handleSubEvent`、群聊 `persistSpeech` 三处静默上报（`AIUsageStatsRecord`，主会话/子代理用 `sessionId + 消息时间戳`、群聊用 `group:<id> + gid` 幂等；载荷含请求耗时 `modelMs`、首字 `ttftMs`、HTTP 状态码）+ 打开「使用统计」面板或点刷新时按「字节偏移 + 文件大小/mtime」游标增量扫描 `ai-sessions` 与 `ai-groups` 的 JSONL（首次打开即历史回填，无启动回填/定时轮询；子代理无 JSONL 只能实时上报）；查询 `AIUsageStatsSnapshot(range)` 只读库并在 Go 内存聚合（本地时区归日、连续天数对齐 ZCode 口径），`AIUsageStatsRequests(offset, limit)` 分页读请求日志（`usage_events` 新增 `model_ms` / `ttft_ms` / `status_code`，老库补列后清一次游标回填历史时序），打开面板不扫文件；`AIUsageStatsSync` 供刷新按钮手动增量同步。设置 → 存储与清理有 `ai-usage` 缓存条目（删前 `Close()`，删后自动回填），方案见 `docs/finished-plans/usage-stats.md`
- `internal/aischedule/`：AI 定时任务调度器（派生 SQLite `ai-schedule.db`；`AISchedule*` 绑定；`Start` / `Close` / `Path` 由根壳调用）
- `internal/cmdbridge/`：进程桥（插件命令、git 浅集成、AI 终端命令）；App 以服务嵌入，与 run 共用 `internal/procctl`
- `sandbox_app.go` + `internal/sandbox/`：子代理命令沙箱的 Windows 受限令牌 + ACL 写效应圈定（`read-only` / `workspace-write`，fail-closed；`sandbox_windows.go` + `sandbox_other.go` 平台对）；根壳只暴露授权检查/清除两个绑定，方案见 `docs/finished-plans/subagent-sandbox.md`
- `wipeguard_app.go` + `internal/wipeguard/`：**工作区破坏防护**（源自 2026-11-18 清空事故）——L1 写前快照（`write_file` / `edit_file` 落盘前经 `backupWrite` 进内容寻址库 `objects/<sha256 前 2 位>/<哈希>`，`index.jsonl` 是唯一 manifest，行带 `ws` 短哈希与 session-workspace-buckets 同一约定）· L2 检测（前端 `ai-wipeguard.js` 只计 `workspace-changed` 的 `removed` 数组——Go 侧 `watchEvent.Removed` 按 FILE_ACTION_REMOVED/RENAMED_OLD_NAME 分组，added/modified（回灌/写入）零计数；10s 窗口 ≥40 **净消失** → critical，净消失 = 删除减去「之后又重新出现」的 `present` 路径——插件更新「删旧目录→复制新目录」是替换不是消失；首次到阈值延迟 1.2s 复核，等重建事件落地；排除检索忽略表 + 构建产物目录两级口径 + 元数据/依赖/缓存目录（`.git`/`.cadt`/`node_modules`/`.venv`/`target` 等）任意层级 + 临时文件 basename 形态（atomfile/补丁 temp/锁）+ 窗口内同路径去重 + rename 成对（OLD_NAME 紧跟 NEW_NAME = 工作区内改名，不算消失）；插件安装/更新/卸载经 `plugins.OnBulkMutate`、git 写工作树命令（checkout/switch/reset/clean/pull…，`gitinfo.OnMutateWorktree` 子命令白名单）经 `watch.BeginQuiet/EndQuiet` 静默门显式豁免）+ 结构指纹兜底（关键标记消失 / 顶层清空 / 文件数腰斩，判定阈值单一来源在 Go `ShouldWarn`/`Compare`）；critical **不自动停会话、不熔断写**（2026-11-19 作者裁定）——状态栏红条 + 向被告警工作区正在运行的会话**插队投递应用消息**（`ai-panel.wipeguardNotifyForWorkspace` → `deliverAgentNotice(urgent)`，固定前缀 `［工作区防护］`，kind=`wipeguard`）由模型自查相关性、用户决定是否中止；消息由 `buildGuardNotice` 拼（最多 8 条截断样例 + 一行快照/备份恢复提示，不塞全量路径），投递与红条共用 2 分钟冷却（`WIPEGUARD_NOTIFY_COOLDOWN_MS`）；`isWriteBlocked` 恒 false 仅为兼容保留。**canary 诱饵 2026-11-19 砍掉**：作者裁定工作区零足迹，且落地首日暴露幂等 bug（随机 token 文名致每调用新增一排，一天积 297 个）与 build/ 布点误报；watcher+指纹已覆盖事故形态，代码与设置开关一并移除）· L3 定期状态快照（有 git 走临时 index + `git archive` 自足 tar，无 git 小工作区增量 CAS，staggered 保留）。备份根默认 `<应用数据>/wipe-guard`，套 deny-delete ACL（`icacls`，DC deny 必须逐层继承——Go openat 删除有「父目录 DELETE_CHILD 回退」）；blob/manifest 在保护树内**直写**（temp+rename 会被 DC deny 拒掉）。恢复出口在 设置 → 存储与清理 → 工作区防护；清理条目 `wipe-guard` 刻意不进一键清缓存（`TestMustNotBeCached` 负向断言）。补丁写入点经 `patch.OnWriteBackup` 包级钩子顺手持久化。不进 AI 工具体系（不给模型暴露）。方案见 `docs/finished-plans/workspace-wipe-guard.md`
- `internal/shellexec/`：用系统默认关联程序打开文件或目录（`ShellExecuteW`，不闪黑窗、不受路径空格/中文影响）；`shellexec_windows.go` + `shellexec_other.go` 平台对
- `groupstore_app.go` + `internal/aigroups/`：AI 群聊磁盘存储（复用 sessionstore 引擎；共享 JSONL 是唯一真源，不进会话搜索索引）；根壳只注入 AppDataDir，方案见 `docs/finished-plans/ai-group-chat.md`
- `memo_app.go` + `internal/memo/`：快捷便签面板的磁盘存储——工作区 `<ws>/.cadt/memo/` 与全局 `<应用数据>/memo/` 两作用域各一份 `memo.json`（真源）+ `img/` 贴图；`Load / Save / SaveImage` 三个绑定 + 写权租约 `MemoLeaseAcquire/Release/Status`（锁文件 `<memo>.lock` 在目录之外，多窗口单写者，第二个窗口只读），Save 带 mtime CAS 与 `Busy` 兜底、贴图只信魔数嗅探；结构级上限（块/条目/文本长度）由前端 `memo-model.js` 统一执行
- `app_dialogs.go` / `app_preview_assets.go` / `app_debugconsole.go`：对话框与绑定壳（预览资源在 `internal/previewassets`，调试控制台存储在 `internal/debugconsole`）
- `*_test.go`：与同名源文件对应的单元测试

> **`package main` 只能在仓库根**：`//go:embed all:frontend/dist` 以根目录为前提，`type App` 与全部 Wails 绑定方法必须留在根。所以根目录的分类靠**文件名前缀 + 同包拆文件**。
>
> **纯引擎可以下沉 `internal/<域>`**（2026-11-16 起按 `docs/finished-plans/go-layout.md` 分批执行）：引擎包不 import main、不碰 App，位置与外部动作一律经 `Deps` 钩子注入，根目录留一个 `*_app.go` 壳做挂名绑定。已落地的包见上方「Go 后端」清单（含 `internal/aigroups`、`internal/sandbox`、`internal/shellexec`），另有一批不单独挂绑定行的叶子包：`internal/mcp`、`internal/integration`、`internal/aiconfig`、`internal/screenshot`、`internal/notify`、`internal/watch`（工作区 watcher + `ResourceWatcher` 资源目录监听），以及 `internal/launchargs`（启动参数解析）、`internal/appconfig`（config.json 读写）、`internal/applog`（运行日志与开发者模式）、`internal/convertcli`（--convert 命令行）、`internal/installercli`（安装器集成命令）、共享叶子包 `internal/appdata`（应用数据路径）、`internal/shellpath`（Git Bash / pwsh 探测）、`internal/clipboard`（剪贴板图片）、`internal/atomfile`（原子替换 + 残行修复）、`internal/chardec`（GBK/GB18030 编解码）、`internal/executil`（防黑窗/杀进程树）。B1–B12、C0–C3、D 系列均已实施（B11 已并入 C1 完成）；上述域引擎均按服务嵌入 App，实测成立；剩余根目录为绑定壳与平台 glue，布局收口。**平台 glue（`*_windows/_other` 成对文件）留在根是本分**，不要摊进 internal 包。

### 前端 `frontend/`
> 2026-11-14 目录归位：`src/` 顶层只留 `main.js`，其余按域进目录。**Go 的目录即包，前端的目录只是分组**——新增模块直接放进对应域目录，不要往顶层加文件。

- `src/main.js`：组合根与核心枢纽（标签页核心状态、命令面板、菜单注册表、初始化接线，约 4,400 行）。域逻辑已拆到下列目录；改动某域先找对应模块，接线约定见「前端侧」
- `src/core/`：跨域共享的纯逻辑与无状态工具
  - `formats.js` 格式驱动层（parse / stringify，插件格式也走这里）· `markdown.js` 共享 Markdown 渲染/sanitize（规则单一来源）· `diff.js` 行级与结构化 diff · `jsonpath.js`/`jsonrepair.js`/`jsonschema.js` JSON 工具 · `icons.js`/`fileicons*.js` 图标 · `image-clipboard.js` · `writing.js` 写作纯函数 · `activity-log.js` 操作留痕前端服务（脱敏 sanitizer、攒批 ≤200ms/20 条调 `ActivityAppend`）· `lifecycle-hooks.js` 生命周期钩子纯函数（9 事件枚举 / 归一化 / 上限 / 工作区过滤 / 工具名匹配器 / 动作审批规格 / 执行汇总，测试 `core/lifecycle-hooks.test.mjs`）· `readonly.js` 只读判定单一来源（全局锁 `settings.readOnlyMode` + 标签锁 `doc.readOnlyLocked` + 固定锁 `doc.readOnlyFixed`（审阅快照，不可解锁、不给解锁菜单）+ 大文件/二进制；新增编辑能力判定一律走它） · `tooltip.js` 全局 tooltip 运行时（`data-tip` 属性驱动替代原生 title：委托监听 mouseover/focusin 显示、点击/Esc 隐藏，位置下方优先越界翻转。**显示时机**：普通 `data-tip` 要停留 `SHOW_DELAY_MS`(1s) 才出——扫过一排按钮一个都不该弹；气泡刚消失后 `WARM_WINDOW_MS` 内再贴到别的锚点只等 `RESHOW_DELAY_MS`(150ms)（Windows TTDT_RESHOW 语义：initial 0.5s / reshow 0.1s，macOS 是 1s，别再回到悬停即弹）；设置页 `.info-tip` 的 ⓘ 必须立即出（`::after` 版本已删）；`data-tip-delay="<ms>"` 单点覆盖（0 = 立即）；气泡还在屏时切相邻锚点立即换内容；键盘 focusin 立即。**滚动隐藏分两类（2026-11-18）**：用户手势（滚轮/触摸/翻页键）后的滚动照旧立即隐藏——气泡不跟手滚动；程序滚动（AI 流式贴底、布局补偿）不掐 tooltip——指针还压在锚点上就跟随重摆、锚点被流式重渲染整只换掉就原地换到指针下的新锚点、被挪出指针下才隐藏（进热窗口），处置判定是纯函数 `resolveScrollAction`；配套两条：待显示期间同文案元素被替换**不重置停留窗口**（innerHTML 每帧重建会把 1s 等待无限顺延），定时器到点按指针位置 `elementFromPoint` 再验证一次。**别乱挂**：只给「图标看不出是什么」的动作按钮、快捷键提示、被截断文本的补全文挂 tooltip；面板/卡片标题行、自明的展开收起箭头（树 chev、任务卡头、思考卡头）一律不挂——鼠标路过就冒泡等于噪音，折叠语义交给 `aria-expanded`。触屏粗指针点击 ⓘ 切换气泡；全仓 `.title =` 赋值已改为 `.dataset.tip =`，`document.title` 与 iframe 的 title 除外。**交互扩展（默认关，逐锚点 opt-in）**：`data-tip-sticky` 让「锚点+气泡」合为一个悬停区，指针移进气泡读长说明、移出才隐藏；`data-tip-actions='[{"label":"去关闭","action":"ai:context-slim"}]'` 在气泡尾部渲染动作链接、点击经 `setTooltipActionHandler`（main.js 分发，定位用 settings-ui 的 `openSettingsAtRow`），挂 actions 自动启用 sticky；链接只用 createElement+textContent 渲染、测试卡 HTML 写入；只挂在「解释完顺手给出口」的场景，别滥。护栏 `core/tooltip.test.mjs`）
  - `overlay-stack.js` 全局弹层栈（2026-11-20 定，取代散落 41 文件的 39 处手写 Esc 特判）：所有页面级浮层（对话框/模态/popover/菜单/灯箱）的唯一注册口，模块级单例仿 `keymap.js` 先例，域模块直接 import。**两职责**：① Esc 栈序分发——`install(window)` 的 window 捕获监听装在 main.js 最顶（必须先于一切弹层工厂，否则 `stopImmediatePropagation` 抢不到），一次 Esc 只退栈顶层，`onClose` 返回 false = 让路下一层（如 quick-switch 先回主级），Shift+Esc / IME 组合态 / `defaultPrevented` 一律放行，死层（`isConnected` 断连 / `.hidden`）顺手剔除自愈泄漏；② z-index 档位分配——`open` 时写内联、`dispose` 时还原，档位 bar 100 < lightbox 1100 < dialog 2100 < modal 3100 < popover 4100 < menu 5100，同档按栈序（后开在上），`tierZ(kind)` 供遮罩兄弟层与 ctx 子菜单取基准；不进栈的常驻层：tooltip 9999、`.app-toasts` 6000，其余压在 1000 以下。**接入口径**：面板/视图层叠上下文内部的小浮层（AI 面板 ctx/changes/chips pop、群聊菜单、CSV 统计面板、阅读模式 Esc 链）不进栈、保留自身 Esc 监听（栈消费时被抢占、栈空时自关）；元素级 Esc 语义 ≠「关所在层」的输入框（如设置搜索框清词不关窗）打 `data-esc-local` 标记让路。护栏 `test/core/overlay-stack.test.mjs`（16 例纯逻辑）+ `test/ai/ai-dialog-esc.test.mjs`（源码断言钉接线契约）+ `test/core/overlay-esc-guard.test.mjs`（扫描全局 Esc 监听，新弹层自挂即红）
  - `widget.js`：AI 回答里 `svg`/`html`/`mermaid`/`echarts`/`graph`/`wordcloud` 围栏的可视化卡片（Shadow DOM + DOMPurify；只有 AI 面板传 `env.aiWidgets` 时启用）。异步引擎卡片动态 import 下列渲染模块、vendor 按需加载，产物仍是静态 SVG 走同一条清洗管线；SSR 结果按内容+主题 LRU 缓存、`data-theme` MutationObserver 触发重渲染、断连登记表清扫（sweepAsyncMaps）；卡片带源码/复制/**另存为**（`.cadt/answers/`）。**借驻 core**：`markdown.js` 依赖它，挪进 `ai/` 会形成 core→ai 反向依赖；配套技能 `inline-visual`/`answer-me-with-html` 规则单一来源在 `visual-spec.js`
  - `visual-spec.js` 可视化规范单一来源（SHADOW_STYLE 别名表、尺寸/数量预算、inline-visual 技能全文、决策表、`resolveThemeColors` 计算样式读色）· `render-cache.js` 内容+主题 LRU
  - `mermaid-render.js`（mermaid 懒加载出图，与 editor/markdown-mermaid.js 共用 vendor、各自独立）· `chart-render.js`（ECharts option 纯 JSON 白名单校验 + SSR 静态 SVG：禁 formatter/rich/外链、强制关动画、实例用完即 dispose）· `layout-render.js`（```graph 关系图 ELK 布局，3s 超时弃实例、简单分层兜底）· `wordcloud-render.js`（词云：echarts-wordcloud SSR 优先，产物无 `<text>` 退 d3-cloud 自拼；d3-cloud@2 是 ES module，走 @vite-ignore 动态 import）
- `src/editor/`：编辑器内核（统一模式 `createEditor<域>(deps)`，deps 与 editor-groups 共用 main.js 的 getter 集经 Object.create 委托）
  - `editor-groups.js` 编辑器组/分栏（二叉分割树）、标签页 chrome、DnD、面包屑、createDocEditor 分发、文档生命周期 · `editor-ace-hooks.js` Ace 会话钩子（模式切换、折叠范围调整——import 圆括号块折进括号、折叠行悬停预览、多光标、python token 染色） · `editor-csv-view.js` CSV/TSV 表格族 · `editor-split-preview.js` 分屏与预览视图族 · `editor-sql-view.js` 大文件 SQL 视图 · `editor-browser-tab.js` 浏览器标签页 · `editor-doc-extras.js` 横幅/折叠预览/书签/视图记忆/git gutter · `editor-export-menus.js` md 块渲染/SVG 导出/右键菜单 · `editor-menus.js` 编辑器右键菜单
  - `structure.js` 17 种语言结构解析（纯函数）· `structure-panel.js` 结构面板控制器（Worker + 缓存 + 导出）· `structure-worker.js` 解析 Worker（`new URL('./structure-worker.js', import.meta.url)`，**必须与 structure-panel 同目录**）
  - `patch-view.js` 补丁视图（只渲染，解析与写入走 Go；`doc.patchReview` 为只读审阅分支：无预检/应用/撤销，走 `PatchParseText`）· `find-bar.js` 查找替换 · `json-query.js` JSONPath 查询栏 · `schema-panel.js` Schema 校验面板 · `format-convert.js` 格式互转 + JSON 修复 · `diff-dialog.js` 双文件对比对话框 · `foot-menus.js` 状态栏底部弹出层（编码/换行/视图/缩放宽度）· `markdown-mermaid.js` 共享 md 渲染器实例 + mermaid 出图 · `bookmark-list.js` 书签总览聚合与 AI 文本格式（渲染复用 quick-switch 的 bookmarks 层级）
- `src/explorer/`：资源管理器与工作区检索
  - `explorer.js` 文件树（惰性加载 + 缓存 + 自动刷新）与扁平列表视图（带目录数/深度/条目硬上限）· `explorer-ops.js` 路径改码/文件剪贴板/新建重命名删除 · `global-search.js` 工作区全局搜索
- `src/shell/`：窗口外壳与应用级动作
  - `menu-bar.js` IDEA 新 UI 菜单条 · `titlebar-popovers.js` 标题栏弹层壳（定位工具 + 图标）· `titlebar-project.js` 项目弹层/克隆 · `titlebar-git-branch.js` Git 分支弹层 · `titlebar-run-config.js` 运行配置 widget 与下拉（[配置名/文件名 + 展开] + 运行 ▶，最近的配置/所有配置/当前文件/编辑配置…；模型纯函数在 `terminal/run.js`，方案见 `docs/finished-plans/titlebar-run-config.md`）· `mode-switch.js` 模式切换（含留痕）· `palette.js` 命令面板 · `quick-switch.js` 快速切换器 · `contextmenu.js` 右键菜单 · `app-actions.js` 退出/最近打开 · `app-links.js` 外链与内置文档 · `update-check.js` 更新检查 · `properties-ui.js` 属性对话框 · `cursor-themes.js` 系统光标主题 · `session-restore.js` 布局持久化 · `image-lightbox.js` 图片灯箱 · `message-center.js` 状态栏消息中心 · `lifecycle-hooks.js` 生命周期钩子控制器（通用 `runForEvent(event, tool, ws)` 覆盖 9 事件：工作区开/关 fire-and-forget；session-start / user-prompt-submit / pre-tool-use / permission-request **阻塞**；post-tool-use / post-tool-use-failure / stop fire-and-forget；工具级按 matchTools 过滤；ai-panel 把 executeTool 包一层挂钩并在 startSessionTurn / 审批入口 / stopGeneration 接线，main.js 注入 `lifecycleEvent`；+ AI 四动作 `handleAppAction` 三个写动作**无条件**审批、无 run 动作防借道；执行复用 `AIRunShellCommand`，测试 `shell/lifecycle-hooks.test.mjs`）· `plugins.js` 插件运行时（加载插件 JS、`cadt.*` API、格式/命令/主题/命令分类器/AI provider/**文档格式转换器**注册生命周期）
- `src/settings/`：设置页——`settings-ui.js` 核心（主题/字体/只读锁/`applySettings`/集成状态/字数统计）· `settings-dialogs.js` 对话框族（遮罩栈/关于/保存冲突/命名）· `settings-select.js` 行式下拉增强 · `settings-search.js` 设置搜索 · `activity-pane.js` 操作记录面板 · `settings-pane-run/plugins/envvars/lang.js` 四个 pane（运行配置（可绑定目标文件，管理列表 + 行内编辑器） · 插件与市场 · 环境变量 · 格式与语言工具链）· `settings-pane-patches.js` 补丁库列表（开发者页内）· `settings-pane-storage.js` 存储与清理（占用统计 · 一键清缓存 · 勾选清数据 · 自动清理三控件；条目与删除都在 Go 侧 `internal/storage`，本模块只渲染与传 id，纯函数配 `settings-pane-storage.test.mjs`）· `storage-autoclean.js` 存储自动清理驱动器（前端驱动复用 StorageScan/StorageClear，Go 侧零改动；启动后 2 分钟 + 每 6 小时检查，判定与范围纯函数在 settings-pane-storage.js）· `settings-pane-usage-stats.js` 使用统计面板（5 指标卡 + 53 周热力图（每日/每周/累计）+ 每日模型趋势 + 环形图/排行 + 底部分页请求日志（供应商账号名 / 新增输入 / 输出 / 缓存 / 命中率 / 速度 / 首字 / 总耗时 / 状态码，命中率·速度·首字带 info 口径）；ECharts 懒加载）+ `usage-stats-model.js` 纯函数（token/时长格式化、热力图网格与填充、请求日志命中率/速度/首字格式化、趋势/环形切片，配 `usage-stats-model.test.mjs`） · `settings-pane-lifecycle.js` 生命周期 pane（条目列表摘要 / 新建与编辑走独立弹窗（复用 aiPanel 的 openDialog 三件套，含时机下拉与匹配器）/ 危险标记 / 预跑一次；总开关行 `lifecycle-enabled` 进设置树 risk=medium，**条目行刻意不进设置树**——条目读写只走专用四动作或本页，避免 set_setting_row 第二条写路径稀释审批语义）· `settings-pane-external-tools.js` 外部工具（AI 子页：能力来源矩阵 + 服务提供商配置；MCP 服务器组 DOM 已从「AI 助手」页迁入，绑定仍归 `ai-mcp-settings.js`）。后四个在 main.js 里 `createSettingsPaneXxx({getter deps})` 直接接线，`selectSettingsPane` 按 `data-pane` 回调
- `src/writing/`：`writing-mode.js` 写作模式（生效判定/chrome/字数/排版整理/起名器/goto）· `writing-ui.js` 壳（LANG_DEFS、视图与编码常量、`readonlyTipObserver`、`flash`/脏标记/自动保存，返回面 22 显式键 + 六模块 spread）
- `src/bridge/`：`bridge-ui.js` 进程桥/虚拟文档/浏览器标签 + 启动编排 IIFE；`bridge-terminal-view.js` 后台终端视图 · `bridge-group-member-view.js` 群聊成员详情标签页（`doc.groupMember = groupId:agentId`，正文渲染归 `ai/ai-group-member-view.js`，最多 8 个标签互换淘汰）· `bridge-agent-view.js` 子代理详情标签页（正文渲染归 `ai/ai-subagents.js`，这里只管建标签页与挂载容器）· `bridge-memo-view.js` 快捷便签面板标签页（每窗口一个虚拟文档 `doc.memo`，作用域「工作区|全局」切换、粘贴图、活动栏 `ab-memo` 入口；kind=text|md|**term（终端条目：正文即命令，行首运行按钮、输出内存态渲染条目下方，120s 超时杀树不支持挂起任务，复用 RunExec 通道，运行时在同目录 `memo-term.js`，AI 只可建改读不可运行）**；纯函数与缓存在同目录 `memo-model.js` / `memo-store.js`（多窗口单写者：打开面板取租约，另一个窗口只读并显示 PID 横幅；AI 写入在面板未持锁时用短租约），AI 经 app_control 的 `get_memo / add_memo / update_memo / remove_memo / open_memo_panel` 动作走同一套变更通路（写动作在 ai-panel 的 app_control 分支做计划模式 per-action 拦截）；正文占位符 `![名](img/x.png)` 内联渲染，贴图 GC 按引用差集（保存成功后对比上次引用集，消失即回收站）；导出内置 md/html/**Word(.docx 原生)**（OOXML 直排 + store-mode ZIP，零第三方依赖，生成器 `bridge/memo-docx.js`，产物经 Python zipfile/XML 独立交叉验证）+ 通用插件扩展点 `cadt.registerDocConverter`（PDF 等更重格式由市场插件承担；一个转换器服务所有接入场景）；Go 侧见 `memo_app.go`）· `bridge-git.js` git 浅集成 · `bridge-cli-convert.js` `--convert` 转换
- `src/terminal/`：`terminal-ui.js` 终端面板/dock/侧栏 git 面板 · `terminal-sessions.js` 会话管理（xterm 挂载、term-out 统一入口 `writeTermOut`——session 未注册先缓冲挂上后回放；fit 后经 `syncTermSize` 防抖同步 `TermResize` 给 ConPTY；`attachCustomKeyEventHandler` 按键分流 + 终端区域右键菜单——指向链接时前置「复制链接 / 内置浏览器打开（`deps.openBrowserTab`）/ 默认程序打开」，定位在 `termLinkAtPointer`：指针换算缓冲行列后对该行重跑链接检测） · `term-keys.js`（终端按键语义分流纯函数：Ctrl+C 有选中复制 / 无选中放行 SIGINT、Ctrl+Shift+V 粘贴，测试 `term-keys.test.mjs`） · `term-links.js`（终端内 http/https 链接检测纯函数：`matchLinks` / `trimLinkTail` / `linkRangeInRows`——跨软换行拼接、宽字符 cell 列映射；`linkHitAt` 指针命中判定（跨行链接中段整行算命中）；接线在 terminal-sessions.js 的 `registerTermLinks`，hover 下划线是 xterm 默认装饰，Ctrl+单击经 `BrowserOpenURL` 打开，测试 `term-links.test.mjs`） · `run.js` 运行配方与输出渲染（纯函数 + 控制器，`run.test.mjs`；运行配置模型纯函数也在这里——`activeRunConfig` / `resolveRunTarget` / `recentConfigs` 等，绑定文件的配置在 run() 里解析 doc/disk 目标）· `run-ui.js` F5 接线 · `debugconsole.js` 调试控制台（底部面板一档）
- `src/ai/`：AI 助手，按域拆为兄弟模块（统一模式：`createAI<域>(ctx)` 工厂 + ctx 注入，重赋值状态经 getter/setter 访问器，互引经惰性转发箭头；测试在 `frontend/test/ai/`）。`ai-panel.js`（约 1.2 万行核心编排：`executeTool`、回合流程、会话持久化、消息渲染、三形态、init）；`ai-system-context.js`（系统提示词组装域：`<workspace_rules>` 守则 / `<plan_mode>` / `<output_language>` / 附件块与 `assembleSystemContext` 按稳定→动态拼装，面板闭包状态经 ctx getter 注入）；数据/常量类：`ai-constants.js`、`ai-session-store.js`（JSONL 编解码/重放）、`ai-session-scope.js`（会话 ↔ 窗口工作区归属判定：面板当前会话属于别的工作区时切到本工作区的会话、没有就新建空会话，多窗口共享 `activeSessionId` 的串台护栏）、`ai-session-disk.js`（磁盘适配；`whenIdle` / `reloadSession` / `_logStat` 供多实例交接重读）、`ai-config-model.js`、`ai-permissions.js`、`ai-read-roots.js`（工作区外读取的授权判定纯函数：用户点名 `userNamedPath` / 已批准读根 / 应用数据目录硬拒、扫描起点包含应用数据目录的 `scanRootDenyReason`；硬拒判定 `hardReadDenyReason` 先于「在范围内放行」执行（full 档与工作区内路径同样生效）；按档授权链 `resolveReadPathWithApproval` 与扫描起点解析 `resolveScanRoot` 在 ai-panel.js——read/edit 档弹审批卡、auto/full 直读、子代理不弹卡报回主代理）、`ai-command-rules.js`、`ai-git.js`、`ai-app-message.js`、`ai-tool-args.js`、`ai-file-tools.js`（AI 文件工具纯函数：`read_file` 窗口切片（offset/limit 字符分页 + startLine/endLine 行号模式带前缀与续读提示）、`edit_file` 定位（默认唯一命中 / replaceAll 全量替换 + CRLF 兜底）、humanSizeBytes、globMatchPath；`executeTool` 的 list_dir/read_file/search_text/edit_file 调用，测试 `ai-file-tools.test.mjs`），`ai-session-tools.js`（跨会话检索工具的纯函数：`formatSessionSearchResult` 会话分组渲染、`sessionLogDigest` 用 `replaySessionLog` 把会话 JSONL 摘成「头部 + 若干条消息」（query 定位命中及前后各一条、8000 字符预算、跨工作区标注），测试 `ai-session-tools.test.mjs`），`ai-terminal-tools.js`（terminal 工具纯函数：ANSI/OSC 清洗 `stripAnsi`、`\r` 重绘归一 `normalizeTermText`、`formatTerminalRead` / `formatTerminalList` 整形、`terminalSendLabel` 审批展示、`formatCommandDuration` 命令耗时格式化（run_command 卡头徽标），测试 `ai-terminal-tools.test.mjs`），`ai-image-encode.js`（图片载荷编码**单一来源**：扩展名白名单 `isReadableImagePath` / 等比缩放 `fitImageSize` / 画布 PNG→JPEG 降质 `encodeCanvasPayload` / 文件与 data URL 解码 `prepareImagePayload`；输入框附图与 `read_image` 工具共用同一条链，测试 `ai-image-encode.test.mjs`）、`ai-external-tools.js`（外部工具来源矩阵纯函数：配置归一化、实际来源判定（provider 缺 key / MCP 绑定失效按 off）、按权限档可用性、OCR/TTS/ASR 结果格式化，测试 `ai-external-tools.test.mjs`）、`ai-audio-transcode.js`（ASR 前置转码：WebAudio 解码 + 16 kHz 单声道 + 纯 JS `encodeWav16`；20 MB / 15 分钟上限，测试 `ai-audio-transcode.test.mjs`）、`ai-mcp-config.js`（AI 代配 MCP 的纯逻辑：视图脱敏（不下发 args 原文/env 值）、部分更新、env/enabledTools 红线、删除保护；app_control 的 get_mcp_servers / set_mcp_server / delete_mcp_server 走它，测试 `ai-mcp-config.test.mjs`），`ai-gen-model.js`（生图/视频条目数据层：`genModels[]` 归一化 + 通用输入输出模板渲染（占位符一律 JSON 字面量）+ 响应提取点路径 + 预设表，纯函数可单测）、`ai-gen-jobs.js`（生成任务运行时：同步执行 / 异步 submit→poll→落盘 注册表、check/stop、完成经信箱唤醒会话；Go 侧是哑通道见 `ai_gen_app.go` / `internal/aigen`）、`ai-usage-templates.js`（**额度查询模板单一来源**：官方/通用/NewAPI/Sub2API/OAuth/自定义脚本模板 + Token Plan 7 家套餐预设 + OAuth provider 预设（SenseNova 控制台 pool-usage 解析）（端点移植自 cc-switch coding_plan.rs，火山 SigV4/CommandCode 三连不做）+ `renderUsageVars` 变量替换，测试 `ai-usage-templates.test.mjs`）、`ai-usage-quota.js`（额度查询管线：Worker 沙箱执行 extractor（prelude 从实例与原型链摘除网络原语 + 5s terminate + 64KB 上限，依赖 `deps.workerFactory` 缝可测）→ 归一化 → 内存 + localStorage 快照缓存（不存密钥）→ sweep 按间隔节流；**外显显示规范 v1**（币种符号 / 窗口短名 / 账号卡紧凑行 / 分组头最紧单值）单一来源 `usageCompactLine` / `formatUsageCompactText` / `usageTightSummary`，规范全文见 `ai-quota-display.md` §11，测试 `ai-usage-quota.test.mjs`）、`ai-usage-config-dialog.js`（配置用量查询弹窗：openAIDialog 动态构建，模板 chips / 凭证覆盖 / 测试脚本）、`ai-provider-icons.js`（供应商品牌 SVG 注册表（39 家，取自 cc-switch MIT 仓库）+ host/名称匹配 + 首字母瓦片回退，测试 `ai-provider-icons.test.mjs`）、`ai-tool-defs.js`（**工具声明单一来源**：定义表 `AI_TOOL_DEFS` + 权限档清单 `toolsForScope` + 工具目录数据 `AI_TOOL_CATALOG` / 组注册表 `AI_TOOL_GROUPS` 与 `<tool_catalog>` 渲染；目录独立成表不内联进 def——def 对象原样发给 API；增删改规则见下方「AI 工具增删改」）、`session-outline.js`（结构面板的会话定位条）；群聊域（方案 `docs/finished-plans/ai-group-chat.md`）：`ai-agent-model.js`（智能体数据层：归一化/名字与分组校验/`agentsUpsert`/modelRef 解析与能力快照/代建模型关键词解析）、`ai-agent-settings.js`（设置 → AI → 智能体 pane：列表按组分区 + 编辑器弹窗）、`ai-group-model.js`（群聊纯函数：meta 归一/预检/上下文组装/主持人契约/看板合并/点名 `parseMentions`/自由聊天上限 `FREE_CHAT_CAPS` 与接力解析 `relayWakes`）、`ai-group-store.js`（ai-groups 磁盘适配 + 群聊 JSONL 编解码/重放）、`ai-group-runtime.js`（群聊运行时：群状态/发言路径/主持人讨论引擎/自由聊天「消息即唤醒」排队 `runChatDispatch`/压缩/纪要）、`ai-group-view.js`（AI 面板群聊视图（G6 面板化，挂 `#ai-group-host`）：QQ/微信群式气泡时间线/贴底滚动/流式气泡/看板覆盖层/工具栏与 @ 补全/`@` 胶囊镜像层）、`ai-group-ui-model.js`（群聊视图纯函数：日期与轮次分隔/连续合并/@ 补全解析/@ 胶囊扫描与原子删除范围/状态文案/预览截断，测试 `ai-group-ui-model.test.mjs`）、`ai-group-member-view.js`（成员详情标签页正文：实时流/上下文占用/私有过程（仅你可见）/发言记录 + 请发言/静音/停止/打开群聊）、`ai-group-sidebar.js`（侧栏「会话 | 群聊」分段、群列表（最近消息预览/运行脉冲/当前群高亮）、新建群聊与群设置弹窗）；UI 域类：`ai-write-guard.js`（write_file 陈旧缓冲防护：覆盖已存在文件前必须先 read_file）、`ai-session-list.js`、`ai-composer.js`、`ai-inline-edit.js`（用户消息原地编辑的纯数据层：附件快照归一 `normalizeMessageAttachments` / 保存载荷 `inlineEditPayload` / 发送时固化 `snapshotFromAttachments`；控制器与 DOM 在 ai-panel.js，chip 渲染共用 ai-composer 的 `renderAttachmentChips`）、`ai-tool-cards.js`、`ai-takeover.js`、`ai-todos.js`、`ai-changes-ui.js`、`ai-schedule.js`、`ai-reminders.js`（reminder_* 工具 + 标题栏铃铛，每轮 `<task_reminders>` 注入）、`ai-timer.js`（头部胶囊 + 弹层；Go 侧计时，到点唤醒会话）、`ai-git-ui.js`、`ai-slash.js`、`ai-message-queue.js`、`ai-manage-dialogs.js`、`ai-settings-dialog.js`（设置页壳：ctx 解包 + 状态条 + 640 行 `bindSettingsPane` 绑定器）、`ai-permission-settings.js`（审批授权/会话与项目级规则/端侧分类器/审批记录）、`ai-preference-settings.js`（偏好清单/预设账号/系统提示词）、`ai-model-settings.js`（模型条目与编辑器状态机/窗口与思考预算）、`ai-gen-settings.js`（设置 → AI → 生图与视频 pane：条目列表/编辑器居中弹窗/测试连接）、`ai-settings-io.js`（配置导入导出）、`ai-subagents.js`（子代理运行时：`startSubAgent` 派单拆建/等两段、`subAgentRecords` 终态 LRU 20、`sub.inbox` 双队列收件箱（step 插队 / turn 排队，唯一消费点在 `runSubRound` 开头）、冷唤醒、`subCompacts` 压缩注册表 + 轮边界 auto-compact、HUD chips/详情视图（含停止与压缩按钮、收件箱预览）、`deliverToParent`（结算/提问的父级投递：父是运行中子代理时投它的收件箱，否则走会话信箱——`sessionById` 对子代理会话恒为 null））、`ai-inbox-wait.js`（**等待原语**：`wait / notify / cancel`，语义对齐 dsh 的 `wait_agent`——等「调用方自己下一步的新输入」而非某个代理的终态，事件驱动、落地即有输入立即返回、250ms 心跳只查「是否已被停止」；`notify` 带 wake 来源（steer/notice/agent），消费方按来源分文案——**排队车道不打扰等待**，只有插话唤醒（方案 `docs/finished-plans/ai-wait-input-gestures.md`），`ai-inbox-wait.test.mjs` 用假时钟锁住竞态与清理）、`ai-agent-notices.js`（**会话信箱单一注入通道**：三态投递 忙→下轮边界 / 压缩中→排队 / 闲→`startSessionTurn` 唤醒，唤醒单飞、被拒内容退回队列；入队即 `inboxWaiters.notify`；`buildSettlementNotice` / `buildAskNotice` 纯函数；会话间投递 `session_send` 守卫矩阵与逐目标回执）、`ai-sidechat.js`（支线对话动作域：`sideOf` 旁路会话的创建/引用预填/带回主对话/提升独立）、`ai-session-send.js`（会话投递的选择器 UI：搜索 + 多选 + 键盘 + 内容预览，`filterSessionRows` / `togglePicked` 纯函数可单测；传输走 ai-agent-notices 的 `deliverToSessions`）、`ai-compact.js`（压缩应用内核：cutoff 回退到 user 轮边界、summary 形状、messages 裁剪、压缩请求组装，主会话与子代理共用）、`ai-classifier-verdict.js`、`ai-local-classifier.js`（端侧命令分类器：int8 推理/严格度/插件分类器聚合/个性化；权重 `local-classifier-weights.mjs` 由 `scripts/train-local-classifier.mjs` 生成、勿手改）
- `src/reading/`：阅读模式（`reading.js` 控制器、`reading-model.js` 纯函数 TOC/排序/进度、`reading-state.js` localStorage、`reading-view.js` 书架/详情/目录 DOM、`reading-render.js` md/txt/docx/epub + LRU、`reading-search.js` 查找、`reading-tts.js` 朗读）；Go 侧对应 `internal/reading/`；方案见 `docs/finished-plans/reading-mode.md`；**只读，禁止调用写接口**
- `test/`：前端单元测试，按域镜像 `src/`（`test/ai/` ↔ `src/ai/`）；运行与登记入口是 `frontend/package.json` 的 `npm test` 清单
- `src/dev/mock-backend.js`：vite dev 浏览器调试用的 mock 后端，main.js 在 `!hasWails && import.meta.env.DEV` 时**动态 import**（`import.meta.env.DEV` 守卫让 rollup 在生产构建里整段剔除，否则会产出一个 66 KB 的 chunk 被 go:embed 带进 exe）；改 mock 场景只动这里
- `src/style.css`：布局、主题、Ace/jsoneditor 样式；`src/reading.css`：阅读模式样式（`.rd-` 前缀）
- `index.html`：窗口结构、菜单、设置对话框
- `public/vendor/`：jsoneditor、mermaid 等第三方资源，以及 AI 可视化引擎 echarts（1.07 MiB）/ elk（1.57 MiB）/ wordcloud 两件（~52 KiB，均懒加载，许可见 `licenses/`）；`public/fonts/`：Inter / JetBrains Mono / Fira Code（OFL）
- 绑定调用：v3 不再生成 `wailsjs/`；前端经 `/wails/runtime.js` 的 `Call.ByName('main.App.<Method>')` 调 Go 方法（`core/wails-runtime.js` 的 Proxy）
- `dist/`：构建产物，经 `go:embed` 编进 exe，**不要手改**

### `docs/`
- `packaging.md`（打包与发布）、`plugins/`、`skills/`、`samples/`、`screenshots/`、`icons/`、`legal/`、`mcp-samples/`（外部工具本地来源示例：SAPI TTS / Windows OCR / whisper ASR）；三份脚本已随 exe 内嵌、可在设置 → AI → 外部工具 → MCP 服务器 → 内置示例一键安装，本目录保留用于单独分发、审查与修改（Python / whisper 模型 / OCR 引擎仍不打包）
- `finished-plans/`：已实施完的方案存档（`ai-panel.md`、`ai-panel-v2.md`、`ai-panel-v3.md`、`ai-head-agents-terminal.md`、`operation-audit-log.md`、`writing-mode.md`、`reading-mode.md`、`visualizer.md`、`mcp-client.md`、`ai-personalization.md`、`local-command-classifier.md`、`ai-gen-models.md`、`ai-turn-steering.md`、`ai-shell-choice.md`、`session-workspace-buckets.md`、`ai-always-collapse.md`、`workspace-lifecycle-hooks.md`（2026-11-19 实施完成移入）、`ai-quota-display.md`（AI 账号额度外显，2026-11-19 当日立项当日落地）、`oauth-quota-template.md`（通用 OAuth 额度模板 + SenseNova Token Plan，2026-11-19）、`usage-stats.md`（AI 使用统计：事实入库 + 打开面板增量回填 + 请求日志分页，不扫会话超集，2026-11-19）、`ai-queue-background-flush.md`（后台会话排队消息自动续跑，方案 A：`flushMessageQueue` 拆「取项 / 发送」，后台会话走 `startSessionTurn` 内核，2026-11-19 当日评估当日落地）、`inline-message-edit.md`（用户消息原地编辑 + 附件快照，2026-11-19 当日立项当日落地）等；2026-11-21 归档移入：`worktree-export-improvement.md`（隔离区 export 可信化：S1 预检换轨到 PatchPreviewText、S2 AllowOffset 消解假冲突、S3 三栏报告与自举提示，已全部实施）、`plugin-extension-roadmap.md`（插件扩展点路线图，M1–M5 全部完成：命令入口矩阵 / AI 工具注册 / 自定义视图 / AI 上下文注入 + 导入器）、`plugin-tool-security.md`（插件 AI 工具注册安全模型，M2 已定稿并被 M3 采纳）、`memo-terminal-item.md`（便签终端条目 kind=term，2026-11-19 立项并实施））
- `unfinished-plans/`：未开工/进行中的方案（目前：`ai-rerank.md`、`desktop-mcp.md`、`side-chat-tab.md`、`turn-fold-redesign.md`、`cross-platform.md`、`run-check.md`、`ai-segmented-compact.md`、`pdf-xlsx-docx-preview.md`（PDF / xlsx / docx 预览，三期分报体积）、`multi-instance-sync.md`（P1–P5 已实施、群聊复用与手工双窗口验收待做）、`ai-cognition-index.md`（AI 工作区认知索引：FRAS 卷文件 + drift 治理，2026-11-19 立项，源自 AOCI 调研，机制借鉴自写引擎不搬代码，待开工）、`feature-evaluations-2026-11-18.md`（四项功能评估稿：右键菜单定制 / 临时文件 / 群聊智能体分组 / AI search 增强；第 3 项已实施，其余待立项））；已实施的方案完成即移入 `finished-plans/`（2026-11-18 整理移入：`memo-panel.md`、`ai-group-chat.md`、`git-worktree.md`、`subagent-sandbox.md`、`bookmarks-app-control.md`、`auto-cache-cleanup.md`；`workspace-wipe-guard.md`（2026-11-19 移入，已实施）；`wails-v3-migration.md` / `wails-v3-event-filtering.md` / `multi-window-session-reuse.md`（2026-11-20 Wails v3 P0–P3 完成移入：一进程多窗口、事件桥、windowreg/newwindow/wailsjs 删除）；群聊 G5 增强等后续范围如开工另立新方案）
- `icon-guidelines.md`
- `reports/optimization-proposals.md`：体积与性能优化提案（含实测体积基线）
- `reports/external-file-viewers.md`：外部文件预览选型评估（open-file-viewer / kkFileView），**结论为两者均不引入**（2026-11-21 从 `unfinished-plans/` 归档到此——决策已定、不会再产生实施动作；PDF/xlsx/docx 预览另见 `unfinished-plans/pdf-xlsx-docx-preview.md`）
- `reports/incident-2026-11-18-workspace-wipe.md`：**工作区被清空事故的完整取证与恢复记录**（2026-11-18 21:00，AI 红队会话的探针脚本 `find . -delete` 删掉整个仓库含 `.git`）。含事故链、行号级证据、三个 harness 的排除过程、恢复核查与取证命令。**动手改命令执行 / 沙箱 / 审批链之前先读第五节**——它记录了「规则层拦得住、但脚本内 `execSync` 完全绕过规则层」这个结构性盲区。

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
  - **SQLite 例外（作者批准的派生索引，均不存真源数据）**：AI 会话搜索的 `ai-index.db`（2026-11-11 批准，实测整包 +3.9 MB）、AI 定时任务的 `ai-schedule.db`（2026-11-12）与 AI 使用统计的 `ai-usage.db`（2026-11-19）。三者都是纯 Go `modernc.org/sqlite`；前两者可随时删除重建（JSONL / 触发指令原文仍是真源），`ai-usage.db` 的主会话/群聊事实可从 JSONL 回填、但**子代理用量只存在这里（不可重建）**，因此它不进「一键清缓存」、只出现在数据条目里单独删除。**不要**把设置、偏好、模型配置或会话正文搬进 SQLite。
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
- 新增/修改纯逻辑必须配测试：Go 表驱动 `*_test.go`；前端测试统一放 `frontend/test/<域>/`（镜像 `src/<域>/`），**并登记进 `npm test` 清单**（漏登记 = 测试从未跑过）；护栏 `test/core/no-src-tests.test.mjs` 禁止 `src/` 下再出现 `*.test.mjs`。
- 提交前跑改动面的测试 + 构建；**测试/构建命令不许接 grep/tail 等管道核对结果**（会吞退出码，M3 带病提交教训），要看退出码本身。
- **`go test` 禁止前台阻塞等待**：一律丢后台执行（后台任务 / 独立终端，输出重定向到日志），前台用 `sleep` 或计时器轮询日志判断是否结束；必须显式带 `-timeout`（全量建议 `-timeout 300s`）。会拉子进程的用例（MCP 假 server / ConPTY / WebView2）一旦回归，前台阻塞会把整个会话和桌面一起拖死（2026-11-16 教训：假 server 的 `TestMain` 没随包迁移，子进程递归跑全量测试，进程树指数增长，机器黑屏）。
- 测试文件跨包迁移时，`TestMain` 与它服务的测试必须同批同包移动；子进程自调用的测试（如 MCP 假 server）靠 `TestMain` 识别运行模式，漏搬即递归启动。搬完先跑一条最小用例验证子进程模式生效，再跑全量。
- conventional commits + 中文描述（feat/fix/refactor/docs/test/chore/perf）；一次提交一个主题；重构类一批一 commit、可单独 revert；提交信息写明行为变化，提交前核对 `git show` 的 diff 与描述一致（d5ad6ac 教训）。

### Go 侧
- 平台相关代码按现有约定分文件成对出现：`xxx_windows.go` + `xxx_other.go`，不要在一个文件里堆 `runtime.GOOS` 判断。
- 新增导出方法后无需生成绑定：前端经 `Call.ByName` 动态解析；**必须**在 `dev/mock-backend.js` 补同名 mock。
- **平台无关文件里不许出现 Windows 专属符号**（`syscall` 的 `HideWindow`/`CreationFlags`、`UTF16PtrFromString`、`golang.org/x/sys/windows` 等）；防黑窗统一用 `executil.HideCommandWindow`。守两道：`crossplatform_guard_test.go`（静态扫，毫秒级）+ `tools\check-crossbuild.cmd`（真编 linux/darwin，约 5 秒）。`_other.go` 桩**同样要能编译**——2026-11-17 交叉编译发现三个包从未在非 Windows 下编过（其中 `browser_other.go` 连参数重名都没人发现）。评估与分期见 `docs/unfinished-plans/cross-platform.md`。
- 文件大小硬限制（`app_core.go` 的 `largeFileBytes` / `maxFileBytes` / `imagePreviewLimit`，图片 hex 上限 `app_file.go` 的 `imageHexLimit`）：>10 MB 只读、>100 MB 拒绝打开、图片预览 32 MB、二进制 hex 1 MB。放宽限制前先确认性能。

### 前端侧
- `main.js` 是组合根：改动前先按域找到对应模块（editor-groups / writing-ui / settings-ui / terminal-ui / bridge-ui / explorer-ops / structure-panel 等），不要把域逻辑回填进 main.js；新域一律新建模块（从 main.js 拆出的模块需要 deps 重写裸标识符，参考 explorer-ops 先例）。
- 域模块的约定是「factory + 显式依赖注入」：`export function createXxx(deps)`，依赖一律 `deps.X` 延迟求值，main.js 侧传 getter（`get X() { return X; }`）——不依赖声明顺序、不拍 let 快照。新增域照此办理，不要在模块顶层 import main.js 的绑定。
- 格式相关逻辑放 `formats.js`，结构解析放 `structure.js`，不要往 `main.js` 里塞新的格式分支。
- 界面设计原则：避免不必要的辅助标签与说明，让布局本身发挥解释作用（Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.）。
- **表单控件硬规范（2026-11-15 定）**：禁止新增裸 `<input>` / `<select>` / `<textarea>`（含 checkbox / radio），一律用 `core/form-controls.js` 的 `createSwitch / createSelect / createInput / createTextarea`（动态）或 `docs/frontend-form-controls.md` 里的静态 class 结构；设置页行式下拉用 `createSettingsSelect`。`style.css` 的 `:where()` 全局兜底只兜存量，不是继续写原生控件的许可；`test/core/form-controls-factory.test.mjs` 按文件基线卡新增，**基线只允许调小，不许调大**。
- **弹层硬规范（2026-11-20 定）**：新增页面级浮层（对话框/模态/popover/菜单/灯箱）必须经 `core/overlay-stack.js` 的 `overlayStack.open({id, kind, el, onClose})` 注册、所有关闭路径收口 `handle.dispose()`，Esc 由栈按层序退——**不要再写自己的 window/document 级 Esc 监听，也不要在 style.css 手写弹层 z-index**（档位由栈分配）；面板/视图内部的小浮层不进栈、可自挂 Esc；元素级 Esc 语义 ≠「关所在层」的输入框打 `data-esc-local`。护栏 `test/core/overlay-esc-guard.test.mjs` 扫描全局 Esc 监听，非豁免文件直接红——**新弹层让测试变绿的正确做法是注册进栈，不是加豁免**。方案见 `docs/finished-plans/overlay-stack.md`。
- Markdown 渲染链：markdown-it → DOMPurify → hljs / KaTeX / mermaid；涉安全的改动（sanitize、外链、内嵌 HTML）必须保守，**原始 HTML 不执行是硬要求**。
- 预览/表格等大 DOM 操作注意避免整段 `innerHTML` 重渲染。

### AI 工具增删改（动 `ai-tool-defs.js` 必读）

> 给 AI 的文案与文档是工具的一部分：改了工具不改文案 = 只改了一半。2026-11-16 定（背景：list_dir 加 depth 参数时漏改目录文案、漏补 mock-backend）。

**新增工具**
- `AI_TOOL_DEFS` 定义（描述写清「何时用 / 何时不用 / 与相邻工具的分工」）；**必须**同步登记 `AI_TOOL_CATALOG` + `AI_TOOL_GROUPS`（一致性测试见 `ai-tool-defs.test.mjs`，漏目录直接红，规则详情 `.cadt/memory/ai-tool-catalog-rule.md`）。
- 下发范围：`toolsForScope` 档位清单、计划模式白名单、子代理 `subToolsForScope`（`ai-subagents.js`）按需同步。
- 执行分支：`ai-panel.js` 的 `executeToolInner` 加 `case '<名字>'`（异步记得 await；`executeTool` 是生命周期钩子包装层，case 一律写在内层）；工具卡 `ai-tool-cards.js` 的 `toolMeta` 补 `verb` + `icon`（图标名必须在 `core/icons.js` 注册，否则渲染为空不报错）。
- **接线守卫**：`frontend/test/ai/ai-tool-wiring.test.mjs` 会逐个工具核对「目录 ↔ 档位下发 ↔ 执行分支 ↔ 工具卡元数据 ↔ 图标注册」，并交叉核对「描述里提到的参数名 ↔ `parameters.properties` ↔ 执行分支读的 `input.*`」，漏一处直接红；执行分支确实不在 `ai-panel.js` 时登记到该文件的 `EXECUTED_ELSEWHERE` 并写明原因。
- **加参数**（改已有工具同理）：`properties` 加字段 + 写 `description`（模型只看这个）；描述里提到参数名就必须已声明——词表命中的参数名会被守卫当「参数提及」校验，确属取值 / 输出字段 / 别的工具参数时登记 `PROSE_TOKENS` 并写原因。
- Go 绑定方法（v3 无生成绑定目录）；**`dev/mock-backend.js` 补同名 mock**（漏了 dev 模式调用即崩）。
- 配套测试：纯函数进 `*.test.mjs` / `*_test.go`，并登记 `npm test` 清单。

**修改工具（含加参数）**
- `description` 同步：新行为、参数语义、行为指引（如「一次递归代替逐层调用」）写进描述——描述是模型唯一的行为依据。
- 目录 `blurb` 若变，`ai-tool-defs.test.mjs` 的精确断言同步改。
- 联动检查：调度原则（`ai-tool-defs.js` 内 system prompt 段）、档位守则（`ai-system-context.js`）、**相邻工具描述里的分工句**（如 glob 描述里「要列某一层目录用 list_dir」）是否需要跟着改。
- 授权 / 审批语义变化同步 `read-outside-workspace.md` 等方案文档。
- **命令执行 / 审批语义改动**：先读 `docs/finished-plans/ai-shell-choice.md`（`shell` 参数、`psScriptDanger` 特征表、
  脚本档三层判定与「端侧只拦不放」的理由）。改 `aiShellInvocation`、`shellScriptPolicy`、`psScriptDanger`
  任一处都要同步那三个通道：工具描述 ↔ 系统提示词守则 ↔ 审批链；`dangerous` 会短路分类器（`ai-permissions.js:254`），
  所以「想让分类器判」就必须别把它标成 dangerous。
- **已知盲区：脚本内的 shell 不受任何规则约束**（2026-11-18 事故根因，详见 `docs/reports/incident-2026-11-18-workspace-wipe.md`）。
  `analyzeDangerousCommand` / `analyzeReadOnlyCommand` 只作用于 `run_command` 的**命令文本**；AI 自己写的
  `.mjs` / `.py` / `.sh` 在进程内 `execSync` / `subprocess` / `eval` 起真实 shell 时，规则层完全看不到。
  `find . -delete` 本身判得出 `find-delete`（`ai-command-rules.js:536`）也进不了只读白名单，但那次执行绕过了整条判定链。
  因此：① 不要以为加了规则就防住了脚本逃逸；② 红队 / 渗透 / 批量文件操作类任务必须把探针沙箱固定到
  `.cadt/tmp/sandbox-*` 并在脚本头断言 `pwd`；③ 改这类能力时评估「工作区完整性哨兵 / 工作树快照」兜底（方案见报告第五节）——**已落地**：wipeguard（`wipeguard_app.go` + `internal/wipeguard/`）做写前快照 + watcher 检测 + 定期快照，详见 Go 后端清单条目。

**删除工具**
- def、`AI_TOOL_CATALOG` 条目、`toolsForScope` / 计划模式 / 子代理白名单、`dev/mock-backend.js` 同名 mock、Go 绑定与调用分支一并清；测试里的精确断言同步删。

**app_control 动作（第二套「工具」，同样三处对齐）**
- 动作清单有三份：`ai-constants.js` 的 cadt-ui 技能「动作表」（模型唯一看得到的清单）、`main.js` 的 `APP_ACTIONS`（错误提示列它）、`runAppAction` 的 `switch` + `MCP_CONFIG_ACTIONS`（真正分发）。新增/删除动作三处必须同时改。
- 守卫 `frontend/test/ai/ai-app-actions.test.mjs` 三方对账，并要求技能表**一条一个动作**（`- action_name {params}：说明`）——历史上用 `；` / `/` 塞多个动作的行没法机械核对，格式现在由测试强制。
- 已实现但刻意不给模型的动作，登记该文件的 `UNDOCUMENTED`（写原因）；参数写进技能表，别只写在 `description` 里。

**收尾**：用户可见变更进 `CHANGELOG.md`（见下节）。

### 内容区虚拟文档（新增一类标签页时必读）

`browser` / `bgTerm` / `agentView` / `sideChat` / `groupMember` / `memo` 这类**不对应磁盘文件**的标签页靠 doc 上的标记位接进编辑器，四处必须同时改，漏一处都不报错：

1. `src/bridge/*.js` 里建 doc（`kind: …`）——否则编辑器里的分支是死代码；
2. `editor-groups.js` 的 `createDocEditor` 分支（`if (doc.X) { … View(doc) }`）——漏了标签打开是空白；
3. `writing-ui.js` 的 `viewOptionsFor` 返回 `[]`——漏了虚拟标签页会出现文件视图下拉，一切换就坏；
4. `editor-groups.js` 的 `closeDocNow` 卸载（`doc.XUnsub` / `doc.XUnmount`）——漏了订阅、监听与面板 DOM 泄漏。

守卫 `frontend/test/editor/virtual-doc-wiring.test.mjs` 会从 `createDocEditor` 反推虚拟类型集合，与 `viewOptionsFor` 清单双向对账，并核对卸载与创建点。

### 文档与提交
- 用户可见的改动同步更新 `CHANGELOG.md` 与 `README.md` 对应小节。
- 方案文档放 `docs/unfinished-plans/`，全部实施后移入 `docs/finished-plans/`。
- 版本号四处需一致：`app_core.go` 的 `appVersion`、`wails.json` 的 `productVersion`、`build/windows/info.json`（v3 syso 版本资源）、`build/windows/installer/wails_tools.nsh` 的 `INFO_PRODUCTVERSION`（见 `docs/packaging.md`）。

## 常用命令

前置：Windows 10/11 + WebView2 Runtime、Go 1.26+、Node.js 20.19+（或 22.12+）、Wails CLI v3.1.0+（`wails3`，仅用于生成 Windows 资源）。

```bash
# 环境检查
wails3 doctor

# 开发运行（wails3 dev：Vite 热更新 + 应用窗口）
wails3 dev
# 或者只构建启动（不跑 Vite dev server）
go build -o datalens.exe . && ./datalens.exe

# 一键构建并替换根目录便携副本 datalens.exe（tools/rebuild-exe.cmd 双击入口）：开头选是否跑
# Go 测试（1 进行 / 2 跳过只跑前端），测试门（Go + 前端）通过才构建，失败可按提示
# 「1 复制失败信息到剪贴板（粘贴给 AI 修复）」/「2 跳过测试强行构建」/其他退出；
# 构建流程：npm run build → wails3 generate syso（图标/清单/版本资源）→ go build -tags production；
# 自动优雅关闭运行中的实例，锁死时改名让路 datalens.running-old-*.exe、下次运行清理；
# -SkipTest 跳过测试门 / -KeepRunning 不停实例 / -Devtools 带调试面板
powershell -ExecutionPolicy Bypass -File tools/rebuild-exe.ps1

# 构建安装包（需 NSIS 3，makensis 在 PATH；内部同样是前端构建 + syso + go build，再 makensis）
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

支持 `--line/-l`、`--column/-c`、`--goto/-g`，行列从 1 开始；程序已在运行时新命令转发到现有窗口。；另有 `--memo` 接收便签定位点（`cadt-memo://<workspace|global>/<block|item>/<id>`，面板右键「复制定位点」得到）直达便签面板对应位置——解析在 `internal/launchargs.ParseMemoLocatorArg`，冷启动经 `GetStartupMemoLocator` 消费、运行中转发走 `app-open-memo` 事件。

<!-- aoci:begin -->
## AOCI 仓库认知

AOCI 为本仓库维护一个稳定、可版本化、可增量更新的仓库级认知层，供模型跨任务复用对系统的理解。

`aoci.txt` 是面向模型的结构化认知索引。它以每个受管理文件、数据库表或其他受管理对象一条独立 Entry 的方式，用符号标签与 F/R/A/S 语义表达对象的核心职责、重要关系、对外契约，以及理解或修改系统时必须知道的非显然约束和设计决策。

Header、目录段和全部 Entry 共同组成完整仓库索引，可以覆盖前端、后端、配置、数据库结构及其他受管理内容。受管理内容发生变化时，通常只需维护受影响的认知条目，不需要重新生成整个索引。

AOCI 提供系统架构、对象职责、重要关系、对外契约和关键约束的高密度视图。

### 工作原理

AOCI 采用“模型生成、模型读取”的认知闭环。

Header、Entry 和 Curation 语义的创作只按当前机器签发的 Plan 与实时 Guide 执行；由 Host 模型基于当前绑定证据独立完成。

Entry 的语义必须来自模型对真实证据的理解。不得仅依据路径、文件名、扩展名、AST、符号列表、依赖扫描、正则、固定模板或规则引擎推导、预填、拼接或改写索引语义。

对 Fresh Bootstrap，只按当前机器签发的 Plan 和实时 Guide 执行。当它们要求创作时，Host 模型创作 Root、Meta、Tag 和 F/R/A/S，提供 authoring-run 声明，并把它绑定到 Plan、Evidence 与完整 Candidate。不得要求 AOCI 填写 `origin=host_model`、制造 Receipt 或把程序生成的 Framework 当作语义。本文件不自行重建 Onboarding 流程。内部批次不是用户决策；只有遇到既有批准边界或真实的安全、漂移、CAS、Recovery 条件才停止。

### 最小使用入口

- `aoci_rules`：取得当前AOCI版本的会话运行合同。
- `aoci_overview`：建立或恢复本仓库的完整认知。
- `aoci_maintain`：受管理对象达到最终稳定状态后检查认知是否需要维护。
- `aoci_update_entry`：提交与当前证据和源码摘要绑定的完整语义更新批次。
- `aoci_report`：仅当当前布局和工具状态支持时，在证据不足、无法可靠生成语义时登记待办，不猜写。

其他MCP工具、CLI命令、参数和专项流程，以当前工具说明、Guide和 `--help` 返回内容为准，不在本文件中重复完整手册。

本区块只规定仓库接入、认知使用和收尾原则。`aoci_rules` 承载当前会话合同，Guide实时输出承载当前Plan的执行顺序与停点，工具Schema、Spec和Validator承载机器结构与判据；Prompt、Description、README和静态文档不能覆盖这些机器事实。

### 建立、生成和恢复认知

1. 每个新的 Agent Run 开始时，应先判断：

   - 本仓库是否已经存在可用的完整AOCI索引；
   - 当前上下文中是否已有与本仓库根、当前索引版本和当前AOCI服务相匹配，并且模型仍可可靠使用的完整仓库认知。

2. 仓库已经存在可用的完整索引，但当前Run没有可靠完整认知时，先调用 `aoci_rules`，再调用 `aoci_overview`。

   完整认知仍可靠时直接复用。局部不确定本身不要求机械重读系统全貌。可靠认知建立后，默认以它作为仓库级系统上下文，只读取当前任务直接需要的源码、测试、配置与契约，只有某个缺失的具体事实可能改变回答或验证结论时才扩大证据范围；AOCI不能替代修改对象与验证行为所需的直接源码证据。

   本Run从已知Host上下文压缩恢复时（包括宿主注入的压缩摘要），必须把此前模型认知视为不可靠。压缩handoff不得保留或摘要正式Whole-Index，也不得保留或摘要任何Overview Header、Entry、Chunk、Challenge或Attestation正文；只能保留安全续接所需的receipt身份、未完成write或Recovery状态，以及立即重载指令。复制进handoff的Whole-Index语义或receipt不能证明恢复后模型的当前认知可靠。若当前上下文已无法可靠保留运行合同，先调用 `aoci_rules`。继续业务任务前，使用 `refresh_reasons=["context_compaction"]` 和新的 `refresh_event_id` 调用普通完整Whole-Index `aoci_overview`（不设置 `check_only` 或设为false）；不得使用 `check_only` 或认知probe。原样跟随每个 `next_cursor` 直到 `completed=true`，确认交付，并且只基于新交付正文提交一次Attestation。完成这次新的完整传输后，即使Attestation为partial或fail也消费该generation，并按既有合同继续source-bound任务，不再自动调用第二次Overview。若该请求返回 `delivery_mode=capacity_stop`，说明Whole-Index装不进本Host的上下文：不得重试或调小 `chunk_tokens`；该停止消费本generation，任务按source-bound继续，且不作无保留的完整系统认知声明。

   AOCI可以针对 `context_compaction`、项目 `cognition_refresh_threshold` 下的机器 `semantic_threshold` 或主要 `phase_transition` 提供checkpoint与认知状态事实。只需要这些紧凑事实时使用 `check_only=true`；这些事实只向Agent提供建议，不替模型决定是否需要系统全貌。

   Agent显式调用普通 `aoci_overview`（未设置 `check_only` 或为false）时，只要能形成一致的CognitionSet，AOCI必须完整交付请求scope。不得因为已有receipt、阈值未达到或没有待处理刷新原因而抑制正文；唯一例外是待处理压缩刷新的上述容量停止。正式认知Dirty或Stale时仍交付正文，但必须标记不可靠。存在未决恢复或无法形成一致snapshot时失败关闭，不返回混合正文。

   普通Overview返回 `continuation_required=true` 时，必须原样提交 `next_cursor` 并自动继续到 `completed=true`。不得询问用户、开始业务任务或给出阶段性系统结论。每块单独一次工具调用；不得在一个脚本里连取多块或合并其输出。缺块、重复、乱序、cursor失败、Index变化或`chunk_tokens`变化时停止本次认知链。Attestation完成前不得用Memory、源码、Spec、`aoci.txt`、历史会话、scope、search或Entry读取修补或补充Whole-Index认知。Challenge ordinal是正式Entry序列中的1-based位置；Header内容、注释、空行、Section/Overview/Chunk Marker、Receipt与Metadata均不计数，Chunk Receipt ordinal使用同一序列。Attestation必须原样回绑本次Challenge发布的当前`index_sha256`、`entry_sequence_sha256`与`entry_count`；旧Index、旧Entry序列、旧数量或旧Attestation均无效。完整链结束后只正式提交一次既有模型认知Attestation；同一响应只允许一次不改变语义答案的JSON Schema或字段格式修正。对象、Tag或F不匹配即失败且认知吸收不确定，不得语义重试或旁路补答。首次认知失败时还不得执行Root/Meta、Migration、全局布局或其他未重新绑定的系统级决策。上下文压缩刷新若传输完整、认知身份不变、治理对齐且没有Recovery或第三方冲突，即使Attestation为partial或fail也消耗该refresh generation，并继续原任务，不再自动重读Overview。`system_mastery_percent`只自评系统框架——架构、职责、强关系、稳定外部契约以及高熵安全和维护约束——不表示完整实现或运行实况知识；机器索引覆盖率必须分开。默认只向用户输出由本次真实覆盖率、Challenge、块数、Token和掌握度生成的规定成功或失败一句话。Host截断某一块时，用同一cursor重取一次并核对 `chunk_sha256`，服务端返回完全相同的字节。仍被截断才停止，提示用户把 `overview_delivery.chunk_tokens` 设置为更小的合法值后重新开始，不得自动修改。

   加法认知等级必须与严格证明字段分开解释。`delivery_verified`表示已加载Index且Host交付已确认，但完整认知验证仍未完成；应表达为“已加载且交付已验证”，不得描述为“没有认知”或“没有理解系统”。`cognition_verified`要求Attestation通过（Challenge至少80%的ordinal完全正确且对象身份至多失手一处），`cognition_governed`还要求治理对齐。通用完整读取失败句只用于真实交付故障。

   当Overview响应包含可选`cognition-state/v2`投影时，必须分别解释各维度。其Level止于`model_cognition_usable`；`strict_attestation_verified`、`governance_aligned`与`current_system_cognition_reliable`都是独立状态，绝不参与该Level。ordinal、对象身份、Tag或核心F不匹配可以导致严格Attestation失败，而模型认知仍然可用；不得仅凭这种不匹配就宣称模型没有理解系统。只有`current_system_cognition_reliable=true`允许无保留地声称当前完整系统认知可靠。投影缺失时继续使用上述Legacy解释。

   普通的只读审计、分析、检查、不修改代码或不提交、不push，不自动等于严格零写入，也不改变上述认知有效性判断。Codex Memory和历史Skill只能辅助恢复经验、用户偏好与调查方向，不能替代与当前仓库根、索引摘要、AOCI服务身份和认知范围匹配的当前认知收据；项目AGENTS和当前AOCI身份在AOCI状态上优先于历史Memory。

   只有用户明确禁止Ledger、元数据、`.aoci`运行资产及任何文件写入时，才按严格零写入处理。若必要的认知建立与该边界冲突，必须报告冲突并请求用户裁决或建议使用隔离副本，不得静默以Memory替代当前仓库认知。

3. 仓库没有可用的完整索引，或当前只有最小骨架、Header不完整、Entries未完成、必要Curation尚未裁决时，如果需要建立正式完整AOCI索引，先取得 `aoci_rules`，然后进入当前AOCI Guide。由Guide依据仓库真实状态决定下一阶段并完成必要安全步骤。

   `aoci_maintain` 不替代索引建立流程。

   不在本文件中自行重建或硬编码完整索引生成状态机。

4. 在长程任务中，模型负责保留当前认知收据并正确使用刷新门禁：

   - Host报告上下文压缩或模型已知系统全貌丢失时，执行上述强制 `context_compaction` 重载规则；AOCI不能自行推断Host事件；
   - 进入真正的主要阶段时声明 `phase_transition`，不得把函数、测试运行或小步骤当作阶段；
   - 在有用的稳定检查点通过 `check_only=true` 取得机器语义计数；
   - 除已知压缩的强制重载外，由Agent判断当前任务是否需要再次显式获取指定scope或完整Overview；
   - 在维护和对齐完成前，保留AOCI报告的Dirty或Stale可靠性状态。

### 任务收尾与认知维护

5. 纯只读问答、分析、版本核验，或没有产生受AOCI管理对象变化的任务，不需要调用维护工具。当前AOCI版本是任意`aoci_overview` check_only或`aoci_maintain`响应里的`cognition_receipt.mcp_service_version`；二进制路径是项目`.mcp.json`里的`command`，CLI不必在PATH上。

6. 发生受AOCI管理对象变化时，待其达到本次任务的最终稳定状态后，只调用一次 `aoci_maintain`。不要在每次中间修改后逐文件维护。

7. 若维护结果返回真实语义候选，Host 模型必须基于每个候选绑定的对象和必要证据，独立创作完整标签与F/R/A/S更新。通过 `aoci_update_entry` 一次提交当前机器签发批次的完整候选集合，同时原样保留每项 `source_sha256`、`candidate_id` 与对应domain批次身份。`max_entries`只限制单次请求和原子事务，不限制logical plan、Whole-Index或Managed Scope。`remaining`非零时，在当前批次成功Apply后重新调用Maintain并从新preimage继续；绝不能为满足transport上限缩减Index覆盖或自行截取返回批次。

   没有足够证据且当前布局支持 `aoci_report` 时，使用它而不猜测、套用模板或为消除待办而生成缺乏证据的认知。

8. 必须遵守工具返回的结构化状态和安全边界：

   - `repair_required`：只修复明确命中的候选，再重新提交当前机器签发的完整批次；
   - `stopped`：结束当前写入尝试并检查 `failed_step`、错误、正式写入证据与Recovery。auto模式下，已证明零写入则记录closure并重新Plan；完整Intent和可证明postimage则Resume；策略要求Rollback且preimage可证明则精确恢复后重新Plan。只有证据不足、第三方正式字节冲突、需要审批或外部动作，或命中其他真实安全边界时，才停止整个用户任务；
   - 冲突、审批、人工裁决、权限和安全信号不得忽略；
   - 已经对齐后不得重复维护或重复写入；`refresh_ready_for_overview` 是checkpoint事实，由Agent决定是否为下一阶段请求普通完整Overview。

   维护完成后如果又修改了任何受管理对象，之前的维护结果失效，应在新的最终稳定状态重新完成收尾。

9. 用户只限制业务文件范围，但没有明确禁止仓库托管资产时，AOCI托管资产可以在收尾阶段为保持认知一致而更新，并应在审计和提交中与业务文件区分。

   用户明确禁止修改 `aoci.txt`、`.aoci`、元数据或任何额外文件时，以用户限制为准，不得写入，并如实报告剩余不一致。

### 专项流程

初始化、完整索引生成、Header生成、Entries生成、数据库结构索引、Curation、人工评审和故障恢复，只按当前AOCI Guide或工具在对应阶段返回的指令、命令和安全停点执行。

不预加载、不猜测，也不自行重建这些专项流程。平台调用方式、请求格式、批次上限、审批规则、索引格式细节和恢复步骤由对应Guide、工具说明、模型Prompt和CLI帮助按需提供。
<!-- aoci:end -->
