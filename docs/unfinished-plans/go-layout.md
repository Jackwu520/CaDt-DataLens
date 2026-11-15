# Go 侧目录与拆包评估

> 状态：复评完成（2026-11-15），**结论更新：分批抽包值得做**。2026-11-14 首轮评估的「暂不抽包」基于当时的高耦合形态，已被本轮实测取代；首轮已落地的部分与判定存档见 §7
> 问题：Go 后端 173 个 `.go`（110 非测试 + 63 测试，38,542 行，module `datalens`）平铺在仓库根、单一 `package main`——能不能像前端那样按域分目录、该拆什么、不该拆什么

## 0. 结论先行（2026-11-15 复评）

1. **硬约束没变，但它只钉住 App，不钉住引擎**：`package main` 与 `type App` 必须留仓库根——`main.go:14` 的 `//go:embed all:frontend/dist` 以包目录为基准；Wails 绑定固定挂 `window.go.main.App`，全部 268 个导出方法必须留在 App 上。所以方向只有一个：**App 留根当壳，引擎下沉 `internal/<域>`**，壳方法委托给包。
2. **首轮「26k 行与 App 交织、抽包先立接口层」的依据已失效**：如今 52/110 非测试文件零 App 引用，`logf`/`appDataDir` 等共享助手已消失，App 结构缩到 16 个字段，候选域的 App 引用几乎全是「挂名绑定方法」（接收者根本不用 `a.`）。抽包从「设计能力接口层 + 全域改写」降级为「搬文件 + 导出符号 + 壳改调用前缀」的机械活，编译器兜底。
3. **前端零影响**：`frontend/src` 没有任何文件 import `wailsjs/go`（全部直接走 `window.go.main.App` 调用），也没有 models 引用——引擎类型挪包对 JS 不可见，`wailsjs/` 产物由 `wails build` 重生成即可。
4. **建议分四批抽包**（§3）：`internal/patch` → `internal/mcp` + `internal/sqlview` → 会话存储族（sessionstore / sessionindex / activity）→ AI 传输层 + `internal/aitimer`。预期根目录 173 → 约 128 个文件、main 包 38.5k → 约 24k 行（§4）。
5. **不做的事**：把剩余 Wails 绑定层全量下沉（仍需能力接口层，收益递减）；把平台 glue（`*_windows/_other` 成对文件、注册表集成等）摊进十几个 internal 包——它们留在根是本分。
6. 首轮的**同包拆文件**（方案 A）落地了一半：patch / ai / app 完成；reading / gitinfo / sqlview / run / sessionindex 未拆。同包拆文件仍是零风险收益，可与对应抽包批次顺手做。

## 1. 现状与首轮对比

| 指标 | 2026-11-14（首轮） | 2026-11-15（本轮） |
| --- | --- | --- |
| Go 文件（非测试 + 测试） | 135（84 + 51） | 173（110 + 63） |
| 总行数 | 33,440 | 38,542 |
| 零 App 引用的非测试文件 | 未测 | **52 / 110** |
| 使用 EventsEmit 的非测试文件 | 未测 | 13 |
| 共享助手 `logf` / `appDataDir` | 存在（当时的主要耦合点） | **已消失** |
| App 结构 | 未测 | 16 个字段，无域状态堆叠 |
| 「纯引擎 + 壳」先例 | 无（仅讨论） | `patch_app.go`、`mcp_app.go` 壳文件模式已成惯例 |

耦合形态的关键变化：候选域文件里的 `App` 引用几乎全是挂名绑定方法——`mcp_manager.go`、`sqlview.go`、`gitinfo.go` 的 `a.` 引用数为 **0**；sessionindex / activity / sessionstore 只有 5–8 处且全在尾部绑定方法里（`sessionindex.go:561` 起、`activity.go:300` 起、`sessionstore.go:430` 起）。候选域真实消费的 App 能力只剩三类：`a.ctx`（事件）、timer 注册表钩子（已回调化）、reading 的两个内部 scan 方法。

## 2. 为什么结论反转

首轮否掉抽包的逻辑链是「域逻辑与 App 交织 → 抽包先立能力接口层 → 跨域调用全过一层接口 → 收益不抵代价」。这条链的第一环断了：

- 数据见 §1：耦合主体已经收敛到「绑定方法」这一层，引擎本身是包级自由函数。
- patch 先例跑通且被复制：纯函数引擎 + `patch_app.go` 壳 + CLI 共用；mcp 全域照抄此形态（引擎 9 文件 2,975 行零耦合 + `mcp_app.go` 壳 11 个绑定）。
- 因此成本从「接口层设计 + 全域改写」降为纯搬移，风险由编译器与既有测试兜底。

## 3. 分批施工方案

| 批 | 内容 | 搬移（行，含测试） | 留根 | 备注 |
| --- | --- | --- | --- | --- |
| B1 | `internal/patch` | 3,531（types / parse / match / plan / write / store / platform×2 + 2 个测试文件）+ `patch_review.go` 的纯解析函数 | `patch_app.go`(418)、`patch_cli.go`(440)、`patch_review.go` 壳一行 | 按首轮 §5 蓝图执行（已验证零外部依赖）；CLI 先留 main |
| B2 | `internal/mcp` + `internal/sqlview` + `internal/atomfile` | mcp 2,975（9 引擎 + 4 测试，manager 的 `a.` 引用为 0）+ sqlview 引擎 ~850 | `mcp_app.go`；`sqlview.go` 尾部 3 个绑定拆出留根 | `writeFileAtomic`/`writeFileAtomicMode` 定义在 sessionstore.go 但被 mcp_config、aiconfig 共用——B2 时先提为 `internal/atomfile`（~40 行零依赖叶子包），main 与 B3 的 sessionstore 都 import 它 |
| B3 | `internal/sessionstore`（含 lock 平台对）+ `internal/sessionindex` + `internal/activity` | 3,192（10 文件） | 各文件尾部绑定方法拆成 `*_app.go` 留根（~300 行） | 实测三者符号零交叉（sessionindex 不引用 sessionstore 任何符号）；若做首轮方案 A 剩余部分，sessionindex 的同包拆分并入本批 |
| B4 | `internal/aitransport` + `internal/aitimer` | 2,169（ai_types / http / sse / stream / validate / proxy×2 + timer 注册表） | AI 绑定与 timer 到点回调接线留根 | timer 注册表已回调化，接口化成本低；`ai_test.go`(1,006) 是混合测试，留 main，B4 不强拆 |

**每批验证**：`go build ./... && go vet ./... && go test ./...` → `wails build -devtools` → 对应链路冒烟（B1：`--check-patch` / `--apply-patch`；B4：AI 连通性测试）→ `git show` 核对是纯搬移。

**纪律**（沿首轮）：每批一提交、纯搬移不顺手改逻辑；`_windows/_other` 成对搬移且后缀保留；测试跟包走，混合测试文件先留 main；新包导出面先 grep 全仓防撞（`createStructurePanel` 教训）；未来包间 import 保持单向（sessionindex → sessionstore 等现无依赖，出现了也要单向）。

## 4. 抽包后的根目录（诚实预期）

| | 现状 | 四批后 |
| --- | --- | --- |
| 根目录 .go 文件 | 173 | 约 128 |
| main 包行数 | 38,542 | 约 24,000 |
| 非测试文件 | 110 | 约 65 |

剩余 ~65 个非测试文件的构成：`app_*` 应用核心（3,212）、`ai_chat/schedule/float/worklog/command`（真 Wails 编排层）、reading（3,344）、run（1,417）、browser（1,987）、gitinfo（1,138）、plugins/skills/market/update、平台 glue（`*_windows/_other`、integration / toolchain / terminal 等）。**这些留在 `package main` 不是债**：它们要么是 268 个 Wails 绑定的宿主，要么是平台差异对，要么真消费 App 状态（`reading.go` 的 14 处 `a.` 引用即此类）。

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
