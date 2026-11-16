# Go 侧目录与拆包评估

> 状态：**已实施完毕**（2026-11-16）。B1–B4 四批（`998915c` / `79c4706` / `eb2c5df` / `b09fc32`）+ B5 零耦合收尾（`1692006`）+ B6 三域下沉（`2ec9ca1` / `e7a45c8` / `e088f3b` / `4d48808`）+ B7–B12（`ed790d2` / `52580bb` / `86e5af0` / `28f54e1` / `9b624b5`）全部落地，每批 `go test ./...` 与 `wails build -devtools` 全绿。B11（plugins/market/skills）按收益递减暂缓，施工要点见 §10。根目录 180 → **99 个 .go**（69 非测试 + 30 测试）、main 包 40,712 → **12,391 行**，`internal/` 36 个包（27 域 + 9 叶子）。2026-11-14 首轮评估的「暂不抽包」基于当时的高耦合形态，已被实测取代；首轮已落地的部分与判定存档见 §7
> 问题：Go 后端 180 个 `.go`（112 非测试 + 68 测试，40,712 行，module `datalens`）平铺在仓库根、单一 `package main`——能不能像前端那样按域分目录、该拆什么、不该拆什么

## 0. 结论先行（2026-11-16 复测）

1. **硬约束没变，但它只钉住 App，不钉住引擎**：`package main` 与 `type App` 必须留仓库根——`main.go:14` 的 `//go:embed all:frontend/dist` 以包目录为基准；Wails 绑定固定挂 `window.go.main.App`，全部 268 个导出方法必须留在 App 上。所以方向只有一个：**App 留根当壳，引擎下沉 `internal/<域>`**，壳方法委托给包。
2. **首轮「26k 行与 App 交织、抽包先立接口层」的依据已失效**：如今 52/112 非测试文件零 App 引用，`logf`/`appDataDir` 等共享助手已消失，App 结构缩到 16 个字段，候选域的 App 引用几乎全是「挂名绑定方法」（接收者根本不用 `a.`——`mcp_manager.go`、`sqlview.go`、`gitinfo.go`、`ai_gen.go`、`ai_catalog.go` 的 `a.` 引用数全部为 0）。抽包从「设计能力接口层 + 全域改写」降级为「搬文件 + 导出符号 + 壳改调用前缀」的机械活，编译器兜底。
3. **前端零影响**：`frontend/src` 没有任何文件 import `wailsjs/go`（全部直接走 `window.go.main.App` 调用），也没有 models 引用——引擎类型挪包对 JS 不可见，`wailsjs/` 产物由 `wails build` 重生成即可。
4. **分四批抽包已实施完毕**（§3）：`internal/patch` → `internal/mcp` + `internal/sqlview` + `internal/atomfile` → 会话存储族（sessionstore / sessionindex / activity）→ AI 传输层 + timer + gen/catalog。实测根目录 180 → **135 个文件**、main 包 40.7k → **26,861 行**（§4），与预判一致。
5. **不做的事**：把剩余 Wails 绑定层全量下沉（仍需能力接口层，收益递减）；把平台 glue（`*_windows/_other` 成对文件、注册表集成等）摊进十几个 internal 包——它们留在根是本分。根目录的 `third_party/go-webview2/`（2.2M 本地 fork，供补丁注入点）是子目录，不参与平铺计数，维持现状。
6. 首轮的**同包拆文件**（方案 A）落地了一半：patch / ai / app 完成；reading / gitinfo / sqlview / run / sessionindex 未拆。同包拆文件仍是零风险收益，可与对应抽包批次顺手做。

## 1. 三轮测量对比

| 指标 | 2026-11-14（首轮） | 2026-11-15 | 2026-11-16（本轮） |
| --- | --- | --- | --- |
| Go 文件（非测试 + 测试） | 135（84 + 51） | 173（110 + 63） | 180（112 + 68） |
| 总行数 | 33,440 | 38,542 | 40,712 |
| 零 App 引用的非测试文件 | 未测 | 52/110 | 52/112 |
| 使用 EventsEmit 的非测试文件 | 未测 | 13 | 13 |
| 共享助手 `logf` / `appDataDir` | 存在（当时的主要耦合点） | 已消失 | 已消失 |
| App 结构 | 未测 | 16 个字段 | 16 个字段 |
| 「纯引擎 + 壳」先例 | 无（仅讨论） | `patch_app.go`、`mcp_app.go` | + `ai_gen.go`、`ai_catalog.go` 同款形态 |

耦合形态的关键变化：候选域文件里的 `App` 引用几乎全是挂名绑定方法——`mcp_manager.go`、`sqlview.go`、`gitinfo.go`、`ai_gen.go`、`ai_catalog.go` 的 `a.` 引用数为 **0**；sessionindex / activity / sessionstore 只有 5–8 处且全在尾部绑定方法里（`sessionindex.go:561` 起、`activity.go:300` 起、`sessionstore.go:430` 起）。候选域真实消费的 App 能力只剩三类：`a.ctx`（事件）、timer 注册表钩子（已回调化）、reading 的两个内部 scan 方法。

（11-16 增量全部来自生图/视频与主题重构提交 649253b：`ai_gen.go`(384) + `ai_catalog.go`(162) 新域 + 4 个 AI 测试文件 + AI 传输层修改；进行中的未提交改动在 browser / plugins / ai_catalog，均在留根域或 B4 待稳定区。）

## 2. 为什么结论反转

首轮否掉抽包的逻辑链是「域逻辑与 App 交织 → 抽包先立能力接口层 → 跨域调用全过一层接口 → 收益不抵代价」。这条链的第一环断了：

- 数据见 §1：耦合主体已经收敛到「绑定方法」这一层，引擎本身是包级自由函数。
- patch 先例跑通且被复制：纯函数引擎 + `patch_app.go` 壳 + CLI 共用；mcp 全域照抄此形态（引擎 9 文件 2,975 行零耦合 + `mcp_app.go` 壳 11 个绑定）；生图/视频通道（`ai_gen.go`）与工具目录（`ai_catalog.go`）直接按此形态新增。
- 因此成本从「接口层设计 + 全域改写」降为纯搬移，风险由编译器与既有测试兜底。

## 3. 分批施工方案

| 批 | 内容 | 搬移（行，含测试） | 留根 | 备注 |
| --- | --- | --- | --- | --- |
| B1 | `internal/patch` | 3,531（types / parse / match / plan / write / store / platform×2 + 2 个测试文件）+ `patch_review.go` 的纯解析函数 | `patch_app.go`(418)、`patch_cli.go`(440)、`patch_review.go` 壳一行 | 按首轮 §5 蓝图执行（已验证零外部依赖）；CLI 先留 main |
| B2 | `internal/mcp` + `internal/sqlview` + `internal/atomfile` | mcp 2,975（9 引擎 + 4 测试，manager 的 `a.` 引用为 0）+ sqlview 引擎 ~855（sqlview.go 737 − 壳 ~100，+ sqlview_test 215） | `mcp_app.go`(134)；`sqlview.go` 尾部 3 个绑定拆出留根 | `writeFileAtomic`/`writeFileAtomicMode` 定义在 sessionstore.go 但已被 4 个域共用（ai_catalog / aiconfig / mcp_config / sessionstore）——B2 时先提为 `internal/atomfile`（~40 行零依赖叶子包），main 与 B3 的 sessionstore 都 import 它 |
| B3 | `internal/sessionstore`（含 lock 平台对）+ `internal/sessionindex` + `internal/activity` | 3,192（10 文件） | 各文件尾部绑定方法拆成 `*_app.go` 留根（~300 行） | 实测三者符号零交叉（sessionindex 不引用 sessionstore 任何符号）；若做首轮方案 A 剩余部分，sessionindex 的同包拆分并入本批 |
| B4 | `internal/aitransport` + `internal/aitimer` + AI gen/catalog | 2,601（ai_types / http / sse / stream / validate / proxy×2 + timer）+ 899（ai_gen + ai_catalog + 各自测试） | AI 绑定、timer 到点回调接线、gen/catalog 的挂名绑定拆出留根 | timer 注册表已回调化，接口化成本低；`ai_test.go`(1,006) 是混合测试，留 main，B4 不强拆。**等生图/视频线稳定后动** |

**每批验证**：`go build ./... && go vet ./... && go test ./...` → `wails build -devtools` → 对应链路冒烟（B1 已跑 `--check-patch`；B4 的 AI 连通性冒烟需真实账号，未跑——由完整单测与绑定重生成覆盖）→ `git show` 核对是纯搬移。

**实施进度（2026-11-16）**：B1–B4 全部完成，一批一提交：

| 批 | 提交 | 落地内容 |
| --- | --- | --- |
| B1 | `998915c` | `internal/patch`（8 引擎 + 2 测试）；顺带把引擎真实依赖提为共享叶子包：`internal/chardec`（编解码簇）、`internal/atomfile`（原子替换）、`internal/recycle`（回收站）；根留 `patch_app.go` / `patch_cli.go` / `patch_review.go` |
| B2 | `79c4706` | `internal/mcp`（9 引擎 + 4 测试，含假 server `TestMain` 随包迁移）、`internal/sqlview`、`internal/executil`（合并重复的 hide 窗口助手）；根留 `mcp_app.go` / `sqlview_app.go`；`writeFileAtomic` 族下沉 atomfile |
| B3 | `eb2c5df` | `internal/sessionstore`、`internal/sessionindex`、`internal/activity`、`internal/sessionlock`（三方共用的写锁独立成包）、`atomfile.RepairTornTail`（sessionstore / activity 共用）；根留 `sessionstore_app.go` / `sessionindex_app.go` / `activity_app.go`，`app_atomfile.go` 过渡壳删除 |
| B4 | `b09fc32` | `internal/aitransport`（三协议构造/SSE/重试/看门狗/校验/代理 + 事件契约）、`internal/aitimer`、`internal/aigen`、`internal/aicatalog`；根留 `ai_chat.go`（绑定壳）、`ai_stream.go`（流注册表）、`timer_app.go`、`ai_gen_app.go`、`ai_catalog_app.go`、`ai_transport_app.go`（钩子注入）。混合测试 `ai_test.go` 拆两半：传输用例随包，App 层用例留根 |

实施中修正的两处评估偏差：① sessionindex 与 sessionstore 并非「零交叉」——索引同步需要 `store.list/read`，用包内最小 `Store` 接口解耦（sessionindex 不 import sessionstore），标脏调用留在根壳；② `activity.go` 复用 sessionstore 的 `repairTornTail`、`ai_worklog.go` 复用会话写锁，两者按「上提共享叶子」处理，未在包间互相 import。

**纪律**（沿首轮）：每批一提交、纯搬移不顺手改逻辑；`_windows/_other` 成对搬移且后缀保留；测试跟包走，混合测试文件先留 main；新包导出面先 grep 全仓防撞（`createStructurePanel` 教训）；未来包间 import 保持单向（sessionindex → sessionstore 等现无依赖，出现了也要单向）。

## 4. 抽包后的根目录（诚实预期）

| | 抽包前（11-16） | B1–B3 后 | **四批后实测** |
| --- | --- | --- | --- |
| 根目录 .go 文件 | 180 | 146 | **135**（84 非测试 + 51 测试） |
| main 包行数 | 40,712 | 31,636 | **26,861** |
| 非测试文件 | 112 | 89 | **84** |

四批共移走约 13,900 行、45 个文件；根目录剩 `app_*` 核心、Wails 绑定壳、reading/browser/run/gitinfo 等真 App 编排与平台 glue——按方案预期留在 main。

剩余非测试文件的构成（行数为 11-16 实测）：`app_*` 应用核心（3,214）、AI 编排层 `ai_chat/schedule/float/worklog/command`（1,321，真 Wails 编排）、reading（3,344）、browser + devtools（2,292）、run（1,417）、gitinfo（1,138）、plugins/skills/market/update（1,458）、平台 glue（`*_windows/_other`、integration / toolchain / terminal 等）。**这些留在 `package main` 不是债**：它们要么是 268 个 Wails 绑定的宿主，要么是平台差异对，要么真消费 App 状态（`reading.go` 的 14 处 `a.` 引用即此类）。

若之后想继续下沉 reading / run / browser，需要先接口化它们消费的 App 能力（EventsEmit、对话框、settings），成本中等、收益递减；§5 的实验若成立可大幅降低这类成本，先做 spike 再定。

## 5. 可选实验：App 嵌入域服务（未验证，先 spike）

`type App struct { *gitinfo.Service }` 这种嵌入：Go 反射会把提升方法算进 App 的方法集，若 Wails v2 按方法集绑定，域服务可以连方法带逻辑整体下沉、省掉全部壳方法。**这是非文档化行为，先写 10 行 spike 验证**（嵌入一个带导出方法的包级 struct，`wails build` 后看 `frontend/wailsjs/` 绑定产物是否出现该方法）。成立则 reading / run / browser 的下沉成本大降；不成立则维持壳文件模式，本方案不受影响。

## 6. 判定汇总（首轮 vs 本轮）

| 方案 | 首轮判定 | 本轮判定 |
| --- | --- | --- |
| A 同包拆文件 | 推荐 | patch / ai / app 已落地；reading / gitinfo / sqlview / sessionindex 剩余部分仍推荐（零风险，随对应批次做） |
| B 前缀补齐 | 推荐 | 已落地（commands → app_commands 等） |
| C 抽 `internal/patch` | 可选试点 | **B1，照做** |
| D 全量分层 | 不建议 | 绑定层留根这部分维持不建议；但「纯引擎分批下沉」从 D 中拆出，升级为推荐（B1–B4） |

## 7. 首轮评估存档（2026-11-14）

- 首轮判定「暂不抽包」的三个前提——52/84 非测试文件碰 App、26k/33.4k 行与 App 交织、`logf`/`appDataDir` 共享助手横跨全仓——在 2026-11-15 实测中全部消失或弱化，判定随之更新。
- 首轮方案 A 施工图已执行：`patch.go`(2,180) → 7 个 `patch_*.go`；`ai.go`(1,745) → `ai_types` / `ai_chat` / `ai_stream` 等；`app.go`(1,444) → `app_file` / `app_fs` / `app_window`；`commands` / `dialogs` / `preview_assets` / `debugconsole` 补齐 `app_` 前缀。未执行：reading / gitinfo / sqlview / run / sessionindex 的同包拆分。
- 首轮 §6 前端 misfit 四条全部落地：`diff-dialog` → `editor/`、`core/plugins` → `shell/`、`core/widget` 借驻标注（AGENTS.md）、`shell/debugconsole` → `terminal/`。
- 首轮 §5（`internal/patch` 施工要点：错误不回引 main 助手、`patch_test.go` 拆两半、CLI 冒烟链路）并入本轮 B1。
- 2026-11-16 增量记录：649253b 新增 `ai_gen.go` / `ai_catalog.go`（均为纯引擎 + 挂名绑定形态，归入 B4）并修改 AI 传输层；`third_party/go-webview2` 本地 fork 已存在（2.2M，子目录不影响平铺）。

## 8. B5 零耦合收尾与嵌入服务 spike（2026-11-16，提交 `1692006`）

**spike 结论：成立**。把 `*probesvc.Service`（`internal/probesvc`，带一个导出方法）嵌入 `App` 后跑 `wails build -devtools`，`frontend/wailsjs/go/main/App.d.ts` 与 `App.js` 都生成了 `ProbeEmbeddedMethod` 绑定——Wails v2 按 App 的**方法集**生成绑定，提升方法对前端可见；运行时派发未做 UI 冒烟（生成侧证据已足够）。探针随后撤除。含义：reading / run / browser 这类真消费 App 状态的域，可以把域服务整体嵌入 App、省掉逐方法壳；服务内仍需回调注入 EventsEmit/对话框等能力。

**B5 范围**（实测零 `a.` 引用的收尾域）：

| 域 | 去向 | 备注 |
| --- | --- | --- |
| gitinfo（873 行，15 绑定） | `internal/gitinfo` | 纯引擎；`LooksBinary` 上提 `chardec` 共用 |
| webtools（522） | `internal/webtools` | 搜索/抓取，代理沿用 aitransport |
| envvars（199 + 平台对 101） | `internal/envvars` | DPAPI 平台对随包；`MergeEnv` 导出给命令桥/运行/终端 |
| aiworklog（182） | `internal/aiworklog` | Logf 注入 |
| structuredir（216） | `internal/structuredir` | 对话框与写盘留根 |
| runproject（155） | `internal/runproject` | 只读探测 |
| aiusage（318） | `internal/aiusage` | Version 注入 |
| update（119） | `internal/update` + `internal/vercmp` | 版本比较上提共享叶子 |
| skills（229） | **保留根目录** | `//go:embed all:docs/skills` 路径相对包目录，不能下沉 |

**最终结构（2026-11-16）**：根目录 **125 个 .go**（82 非测试 + 43 测试）、main 包 **22,948 行**；`internal/` **25 个包**（19 个域包 + 6 个共享叶子）。剩余根目录文件全是 Wails 绑定壳、真消费 App 状态的编排（reading / browser / run / ai_chat）与平台 glue。

## 9. B6 三域下沉与共享叶子补齐（2026-11-16）

嵌入服务 spike 成立后，B6 分四个可单独回滚的提交完成：

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `2ec9ca1` | B6-0 `internal/appdata` | 应用数据路径拼装下沉共享叶子，根目录留同名薄包装 |
| `e7a45c8` | B6a `internal/reading` | 扫描/解析/搜索与 4 个测试随包；`Reader` 嵌入 App；注入 Logf / Emit / DebugEnabled / RegisterPreviewRoot，启动清理改 `CleanupCacheOnStartup` |
| `e088f3b` | B6b `internal/run` + `internal/procctl` | 运行通道与平台 shell 探测随包；`Runner` 嵌入 App；run 与命令桥共用的取消表/进程树终止/参数校验提为 `internal/procctl`，命令桥改调共享实现 |
| `4d48808` | B6c `internal/browser` | WebView2 宿主、CDP 桥、平台 stub 与 5 个集成测试随包；`Host` 嵌入 App；注入 Logf / Emit / FindParent；`ProfileRoot` / `ActiveProfileDirs` 导出给存储清理 |

**结果**：根目录 125 → **114 个 .go**（78 非测试 + 36 测试）、main 包 22,948 → **17,161 行**；`internal/` 30 个包（22 域 + 8 叶子）。Wails 绑定产物在四批前后无差异（提升方法与原壳方法同名），前端零改动；每批 `go test ./... -timeout 300s` 与 `wails build -devtools` 全绿，browser 批含真实 WebView2 集成用例。

## 10. B7–B12 批次与 B11 暂缓（2026-11-16）

| 提交 | 范围 | 说明 |
| --- | --- | --- |
| `ed790d2` | B7 `internal/search` | search / search_rg / glob 与测试随包；`Searcher` 嵌入 App；`SkipDir` 导出给目录树共用忽略表 |
| `52580bb` | B8 `internal/aischedule` | 调度器与派生 SQLite 随包；`Scheduler` 嵌入 App；导出 `Start` / `Close` / `Path` |
| `86e5af0` | B9 `internal/cmdbridge` + `internal/shellpath` | 进程桥与 AI 终端命令随包；`findGitBash` / `findPwsh` 提为共享叶子，run 去掉钩子、终端留薄包装 |
| `28f54e1` | B10 `internal/terminal` | ConPTY 会话与 AI 读取接口随包；`Terminal` 嵌入 App |
| `9b624b5` | B12 `internal/toolchain` | 语言环境检测随包；`Toolchain` 嵌入 App |

**结果**：根目录 125 → **99 个 .go**（69 非测试 + 30 测试）、main 包 22,948 → **12,391 行**；`internal/` 36 个包（27 域 + 9 叶子）。每批 `go test ./... -timeout 300s` 与 `wails build -devtools` 全绿，`frontend/wailsjs` 无差异。

**B11（plugins / market / skills）暂缓**：`plugins.go` 反复读改写根 `AppConfig`（PluginsPathMode / DisabledPlugins），`market.go` 读 DataSource，另有两个 runtime 文件对话框；`skills.go` 的 `//go:embed all:docs/skills` 需改由根壳传 `embed.FS`。施工要点：注入窄配置钩子（读写插件路径模式与禁用列表、读市场源）、文件选择器、embed.FS；测试需改为构造测试服务而非 `NewApp()`。按「收益递减」与平台 glue 留根口径，暂不实施——剩余根目录为 App 核心、绑定壳、平台 glue、CLI 与插件/技能宿主。
