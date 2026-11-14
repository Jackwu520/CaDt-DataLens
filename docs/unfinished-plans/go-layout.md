# Go 侧目录与拆包评估（附前端归位复核）

> 状态：评估完成，**未开工**（2026-11-14 22:40，前端第三阶段批次进行中）
> 前置阅读：`docs/unfinished-plans/frontend-split-phase3.md`（前端目录归位与剩余批次）
> 问题：Go 后端 135 个 `.go`（33,440 行）全平铺在仓库根、单一 `package main`，本文件回答「能不能像前端那样按域分目录」「该拆什么、不该拆什么」

## 0. 结论先行

1. **Go 的「目录」就是「包」，不存在前端那种「只搬文件、改改 import 就行」的归位。** 任何目录化 = 拆包 + 导出符号 + 改导入路径 + 拆测试。想只分目录不换包，在 Go 里做不到。
2. **`main` 包必须留在仓库根**：`main.go:14` 的 `//go:embed all:frontend/dist` 以包目录为基准，Wails 绑定产物固定落在 `frontend/wailsjs/go/main/`。这两条把「App 挪进 subdir」直接否掉。
3. 因此性价比最高的不是拆目录，而是 **同包拆文件**（零编译风险、不动任何 import）+ **文件前缀补齐**（认知层的分类）。前者能立刻把 2,180 行的 `patch.go`、1,745 行的 `ai.go` 降下来。
4. 真正值得**抽包**的只有 `patch`（补丁族 3,072 行里 2,180 行是纯函数、零 App 依赖、调用方只有 Wails 层与 CLI 两个文件），可作为 `internal/` 试点；其余 26k 行都与 `*App`（发事件、开对话框、读配置）交织，抽包要先立能力接口层 —— 收益是导航，代价是每次跨域调用过一层接口，**当前阶段不建议**。

## 1. 现状锚点（84 个非测试文件，23,540 行；另有 51 个 `_test.go` 9,900 行）

| 域 | 文件 | 行数 | 其中碰 `App` |
| --- | --- | --- | --- |
| AI 会话与流式 | 16 | 5,083 | 10 |
| 阅读模式 | 4 | 2,399 | 4 |
| 补丁 | 5 | 3,072 | 1 |
| 内嵌浏览器 | 8 | 1,616 | 6 |
| 运行与终端 | 11 | 2,111 | 5 |
| Git | 1 | 872 | 1 |
| 插件/技能/市场 | 5 | 1,824 | 5 |
| 数据工具 | 7 | 2,431 | 6 |
| 留痕与监听 | 4 | 723 | 2 |
| 应用与系统 | 23 | 3,409 | 12 |
| **合计** | **84** | **23,540** | **52** |

（`App` 列按「文件里出现过 `App` 标识符」计，包含仅用 `a.log(...)` 这类轻耦合的情况。）

体量集中度：**前 7 个文件占 33%**（patch 2180 / ai 1745 / app 1444 / reading 1123 / sessionindex 948 / gitinfo 872 / plugins 836）。

## 2. 关键约束（决定了什么不能做）

| 约束 | 位置 | 后果 |
| --- | --- | --- |
| `//go:embed all:frontend/dist` | `main.go:14` | main 包必须在根；挪进 `cmd/` 就得改 embed 与构建脚本 |
| Wails 绑定目录 | `frontend/wailsjs/go/main/` | App 换包 → 绑定路径 `go/<pkg>/` 全变，`main.js` 的 `window.go.main.App` 全失效 |
| 全部 135 个文件都是 `package main` | — | 拆任何一个域都要连带搬它的 `_test.go`（测试在同包内用未导出符号） |
| 51 个文件带 `*App` 方法接收者 | — | 抽包必须先决定：这些方法留 main 当薄包装，还是引入 `App` 接口 |
| 52 个非测试文件引用 `App` | — | 同上；`EventsEmit`/`dialogs`/`a.settings` 是最常见的耦合点 |

## 3. 四种做法的取舍

| 方案 | 内容 | 风险 | 收益 | 判定 |
| --- | --- | --- | --- | --- |
| **A 同包拆文件** | 按小节把大文件切成 `patch_parse.go` 这类同包兄弟文件 | 零（不改包、不改 import、不改绑定） | 单文件可读性直接改善；与前端"拆域"同构 | **推荐，先做** |
| **B 前缀补齐** | `commands.go`/`dialogs.go`/`preview_assets.go`/`debugconsole.go` 补成 `app_*.go` | 极低（仅文件名，git blame 断代） | 顶层 ls 一眼成组，等于"文件名即目录" | **推荐，与 A 同批** |
| **C 抽 `internal/patch`** | 补丁纯逻辑下沉成独立包，`patch_app.go` 留 main 做包装 | 中（导出面 + 测试搬迁 + 错误类型） | 验证 internal 化的真实成本；给后续域立模板 | 可选试点，先做 A 再做 C |
| **D 全量分层** `internal/service` | 为 App 立能力接口，26k 行域逻辑下沉 | 高（跨 33k 行，绑定与 embed 都要复验） | 结构最干净 | **不建议**（本阶段） |

## 4. 同包拆文件清单（方案 A 的施工图）

行号是 2026-11-14 22:40 实测，动手前按小节注释重定位。

| 源文件 | 行数 | 切分 | 锚点 |
| --- | --- | --- | --- |
| `patch.go` | 2180 | `patch_types.go` 1–231（对外结构 + 内部模型）· `patch_parse.go` 232–526（解析 + 路径解码）· `patch_match.go` 527–1002（目标读取 + 匹配 + hunks）· `patch_plan.go` 1003–1629（计划构建 + 存储索引）· `patch_write.go` 1630–末尾（两阶段写入） | `===== 对外结构`/`内部模型`/`解析`/`匹配`/`计划构建`/`存储与索引`/`写入` 七个小节标题 |
| `ai.go` | 1745 | `ai_types.go`（AIConfig/AIMessage 等结构）· `ai_stream.go`（chunkBatcher + 事件归一化）· `ai_chat.go`（AISendChat/AIStop/AITouchStream/AITestConnection） | 类型段 63–230、批处理 155–230、请求段 231+ |
| `app.go` | 1444 | `app_file.go`（读写/保存/编码检测）· `app_fs.go`（目录扫描/复制/stat）· `app_system.go`（剪贴板/系统信息/窗口） | `SaveFileChecked` 617、`GetFileStat` 593、`Clipboard*` 段 |
| `reading.go` | 1123 | `reading_scan.go`（书根扫描）· `reading_structure.go`（结构 profile + 排序）· `reading_meta.go`（元数据 + 书架候选） | `ScanReadingRoot` 227、`--- 结构 profile` 598、`--- 书籍元数据` 916 |
| `sessionindex.go` | 948 | `sessionindex.go`（1–489 建表与写入）+ `sessionindex_query.go`（490–末尾 写路径钩子/Wails 绑定/全局搜索通道） | `---------- 写路径钩子` 490、`---------- Wails 绑定` 559、`---------- 全局搜索接入` 583 |
| `gitinfo.go` | 872 | `gitinfo_status.go`（状态/回滚）· `gitinfo_branch.go`（分支弹窗族 + 克隆/提交） | `===== 分支弹窗` 137 |
| `sqlview.go` | 737 | 不拆：`sqlSession` 类型自洽（建表/插入/查询/释放），尾部只有少量 Wails 绑定 | `sqlSession` 方法群 133+ |
| `run.go` | 650 | `run_prepare.go`（PrepareRun/RunShell 解析）· `run_exec.go`（RunExec/输入队列/停止） | `PrepareRun` 122、`RunExec` 477 |

收益估算：A 之后最大的 Go 文件从 2,180 降到约 630，前五名全部 <800；**零 import 改动**（同包，符号互相可见），唯一要跟的是一起搬的 `_test.go` 与 `//go:build windows` 标签。

风险与纪律：
- 每个新文件头写一句职责 + 原文件归属，便于 `git log --follow` 断代后回溯。
- 搬移只允许"剪切整段"，**不要顺手改逻辑**；一批一提交，`go build ./... && go vet ./... && go test ./...`。
- `_windows.go` / `_other.go` 后缀是构建标签，拆文件时后缀必须保留（如 `patch_platform_windows.go` 不能并进 `patch_parse.go`）。

## 5. 抽包试点：`internal/patch`（方案 C）

可行，且是全部域里最干净的：

- `patch.go` **零外部符号依赖**（实测：不引用 `logf`/`appDataDir`/`EventsEmit`/`App` 任何一个）。
- 调用方只有三个：`patch_app.go`（Wails 导出层，307 行）、`patch_cli.go`（CLI，446 行）、`patch_test.go`（586 行）。
- `patch_platform_windows.go`/`_other.go` 已是构建标签隔离，跟着包走即可。

施工要点：
1. 建 `internal/patch/`，`package patch`，把 `patch.go` 整段 + 平台文件搬过去；对外类型本就在导出（`PatchPlan` 等 86 行"对外结构"）。
2. `internal/patch` 内的错误用 `errors.New`/自定义类型，**不要**回引 main 的格式化助手（当前确实没有）。
3. `patch_app.go` 保留在 main，只改调用前缀 `patch.BuildPatchPlan(...)`；`patch_cli.go` 两种选择：留 main（它用 `os.Args`/`flag`，与 App 无关）或一并进 `internal/patchcli`——建议**先留 main**，少一个包。
4. `patch_test.go` 拆两半：纯函数用例进 `internal/patch/patch_test.go`（`package patch`），涉及文件系统夹具的留 main。
5. 验证：`go build ./...`、`go test ./...`、`wails build -devtools`、以及 `--check-patch` / `--apply-patch` 的 CLI 冒烟（这条链路不依赖窗口，最好验）。

预期收益：main 包 33.4k → 30.4k 行，换来一个**真正有边界**的包，为「以后要不要给 reading/sqlview 也抽」提供成本样本。若成本超预期（>2 小时或需要为测试写 shim），就停在这个包，不再扩。

## 6. 前端归位复核（本轮 Z 之后）

现状（2026-11-14 22:36 实测）：

| 目录 | 文件 | 行数 | 评价 |
| --- | --- | --- | --- |
| `ai/` | 30 | 25,662 | 最大域，自身有消息化方案；本阶段只拆 4 批 |
| `editor/` | 17 | 9,400 | 合理（编辑器内核 + JSON 工具 + 结构面板） |
| `shell/` | 17 | 3,675 | 略杂（见下） |
| `reading/` | 7 | 3,602 | 既有目录，不动 |
| `core/` | 14 | 3,071 | 语义是"跨域共享"，有 2 个例外（见下） |
| `explorer/` | 4 | 2,642 | 1 个 misfit（见下） |
| `terminal/` | 4 | 2,048 | 合理 |
| `settings/` | 2 | 1,338 | S1/S2b 后会补到 6–7 个 |
| `bridge/` | 4 | 669 | 合理 |
| `writing/` | 1 | 2,943 | 单文件目录，S2a 后才成形 |

四条 misfit 修正建议（都在本轮 Z 的语义范围内，可一批改完）：

1. **`explorer/diff-dialog.js` → `editor/`**：双文件对比对话框，入口在菜单/命令面板，与资源管理器无关；`core/diff.js` 是它的算法层，同域更顺。
2. **`core/plugins.js` → `shell/`（或独立 `plugins/`）**：插件运行时持有全局注册表与 `cadt.*` API 生命周期，与 `core/` 的"无状态共享"语义相反。
3. **`core/widget.js` 保留但标注"借驻"**：它本是 AI 回答的可视化卡片，因 `core/markdown.js` 依赖它才不能进 `ai/`（否则 core→ai 反向依赖）。AGENTS.md 需写明这条理由，别让后来人以为放错了。
4. **`shell/debugconsole.js` → `terminal/`**：它渲染的是底部面板的一档，真正管 dock 的是 `terminal/terminal-ui.js` 的 `applyDockView`。

`writing/` 的处理建议：若 S2 继续推进，保持单文件目录（S2a 会加 `writing-mode.js`）；若 S2 被推迟，临时并入 `editor/`，避免长期 1 文件目录。

## 7. 建议顺序

1. **前端 misfit 四条**（§6，约 4 个 `git mv` + import 改写 + 打包验证）——趁 Z 的余温做，成本最低。
2. **Go 方案 A + B**（§4，同包拆文件 + 前缀补齐）——零风险，分 4 批：patch / ai / app / reading+gitinfo，每批 `go build && go vet && go test`。
3. **`internal/patch` 试点**（§5）——独立一批，验成本样本。
4. 之后回到前端的 S1 / S2 / A2 / A3 / A4 / X1。

不做的事：把 Go 摊进 10+ 个 `internal/` 包、为 App 立接口层（方案 D）。理由已写在 §0/§2：33k 行里 26k 与 `*App` 交织，把导航收益换成接口跳转成本，且 Wails 绑定与 embed 都要重新验证。
