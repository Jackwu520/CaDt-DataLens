# AI 工作区认知索引：FRAS 卷文件 + drift 治理（方案）

> 状态：**待开工**（2026-11-19 立项；源自对 AOCI（`aoci-spec/aoci-code`）的调研——机制借鉴、自写引擎，**代码与文案一律不搬**：对方许可 FSL-1.1-MIT，本仓 Apache-2.0，source-available 不允许 redistribution）
> 修订：2026-11-19 评审后修订——overview 注入落点改走轮上下文（§5.3，原定系统提示词稳定区会击穿前缀缓存）、锁文件移到 cognition 目录外（§4.3）、清理补 BeforeClear 门闩（§6）、补分批建卷协议（§7 P1）与维护提醒注入（§5.5）、路径归一与 meta 预算行定死（§3.2 / §3.3）
> 修订：2026-11-21 再评估——AOCI 已在本仓实跑（P0 事实完成：1010 条 / 520 KB / 148 目录分组），据此回填标定锚点（§3.2）、补降级第三档（§5.3）、子代理段改白名单口径且 v1 不派 cognition_edit（§5.2）、cognition_read 补响应上限与 status 副作用说明（§5.1 / §8）、P3 试验田改址并声明双索引混淆（§7 / §9）
> 修订：2026-11-21 评审后修订（开工前终版）——① baseline 生命周期补 `cognition_edit` 写后簿记，否则首次维护后永报 Stale / Unbaselined（§4.1 / §5.1）；② CAS 改为前端自动附加 `base` 指纹比对，原「比对 `.state` 登记指纹」恒真、防不了两窗口互覆（§4.3 / §5.1）；③ read 封顶 16 KB 降至 7 000 字符，避开 context-slim 的 8 192 字符回包落盘阈值（§3.2 / §5.1）；④ 计划模式改「不派 cognition_edit」，原「对齐 memo 放行」与代码事实相反（memo 写动作硬拦 `ai-panel.js:10388`、propose_patch 因写 `.cadt/patches` 降 dry_run `ai-panel.js:10719`）（§5.2 / §10）；⑤ drift 清单自带 `.cadt/` 整树排除——已核实 search 忽略表不含 `.cadt`（§4.1）；⑥ `.cadt/cognition` 整树列为 write_file / edit_file 拒绝路径、meta 收口 `cognition_edit` 新增 `meta` 参数——原「`.state` 物理上无从触达」经 write_file 不成立（§3.1 / §3.3 / §5.1）。另补：目录条目 Stale 豁免、`op=add` 撞已有路径报错、注入预取与轮路径范围（§5.3）、meta rule6 提示注入防线（§3.3 / §9）、wailsjs 残留清理与行号勘误
> 动机：AI 助手每次会话都从零探索工作区（`list_dir` → `read_file` → `search_text`），「这个文件是干什么的、动它要先动谁、有什么从代码里看不出来的暗规则」这些知识每轮重新挣一遍。缺的是**任务开始前就存在的全局语义先验**。
> 决策：
> 1. **每文件一行 + FRAS 四字段**的紧凑文本索引，AI 撰写、随工作区存于 `.cadt/cognition/`——S 字段（无法从代码推断但不可违背的约束）是本方案的核心价值，grep 永远搜不到。
> 2. **AOCI 的「索引即上下文」改为「overview 注入 + 按需读」**：整卷动辄数万 token，与 `ai-context-slim` 的瘦身方向相反；新会话首轮只注入路径地图（**1–2K token 量级，硬上限**），细节工具按需取。注入落点是**轮上下文**（`turnContextBundle`，历史里只存一份），**不进系统提示词的稳定区**——卷内容会被 `cognition_edit` 改写，写进稳定区等于每次维护都击穿前缀缓存（§5.3）。
> 3. **治理走轻量版**：baseline + drift 四态（Missing/Orphan/Stale/Unbaselined）保留；AOCI 的 chunk/cursor/receipt/challenge 全套 attestation 简化为「已读回执」（会话内登记读过的卷指纹）；CAS 原子写、跨进程写租约直接复用现有基建。
> 4. **不硬依赖 git**：AOCI 的 scan 以 Git 清单为前提，本应用的工作区常常不是仓库——drift 的文件清单来源退化为准（fs 扫描，预算经验见 wipe-guard 实测：1611 文件全树 stat 10.76 ms）；有 git 时可选加速，不是前提。
> 5. **限代码类工作区**：纯数据目录（CSV/JSON 为主）不建索引——per-file 语义对数据目录价值趋零，判定信号见 §1.3。
> 范围：`internal/cognition` 新引擎包 · `cognition_app.go` 绑定壳 · AI 工具 3 件（read/edit/status）走 `ai-tool-defs` 三处对齐 · `ai-system-context.js` 的守则段 + `turnContextBundle` 的 overview / 维护提醒（§5.5）· 存储清理登记 + `BeforeClear` 门闩 · 与 wipe-guard / multi-instance 租约的联动
> 非范围：数据库 schema 认知（AOCI 的 Database Cognition，本应用不连 DB）· 向量化 / RAG / 全项目内容索引（体积红线，`docs/reports/optimization-proposals.md` 第四节已否决过的方向）· AOCI 多卷激活模型（Volumes 合同，v1 单卷）· LSP / CodeGraph 类精确检索（已有 `internal/search` 与结构面板，分工见 §3.4）

## 1. 背景与问题

### 1.1 已有的三套认知与缺口

| 系统 | 回答的问题 | 真源 | 现状 |
|---|---|---|---|
| 会话检索（`internal/sessionindex`） | 「我们以前聊过什么」 | 会话 JSONL | 已有（SQLite 派生索引） |
| 记忆（`.cadt/memory/`） | 「用户是谁、什么偏好、什么教训不能再犯」 | memory 文件 | 已有 |
| 工作区守则（`ai-system-context.js` 的 `<workspace_rules>`，来源含工作区 `AGENTS.md`） | 「在这个仓库干活要守什么约定」 | 用户手写 | 已有，靠人维护 |
| **工作区认知索引** | 「这个文件是什么 / 改它要动什么 / 有什么暗规则」 | AI 撰写的卷文件 | **缺口——本方案** |

前三套都不回答最后一列：守则是全局的、粒度粗；会话检索要靠运气命中；记忆面向人不对面向代码。于是每个新会话的冷启动都是一遍 `list_dir` / `glob` / 试探性 `read_file`，长会话中段还要重新定位。

### 1.2 AOCI 的机制清单（调研结论，2026-11-19）

AOCI-CODE（Go 单 exe，2.1k stars，v0.2.0-rc2）的定位是「持久化、Git 版本化的代码库与 schema 地图」：本地 stdio MCP 服务器（9 个工具）+ CLI，索引由模型撰写、由治理机制看守，随 Git 跨会话/跨智能体/跨人复用。9 个工具背后是 12 项机制（逐条对照见 §11）。可借鉴的机制：

- **FRAS 字段**：每条目记 F（职责）/ R（必须一起理解的强关联）/ A（对外契约）/ S（非显性约束）。核心洞察：F/A 能从代码猜出来，**R 和 S 是检索永远给不出的**——S 是「改这里必须同时改那里」「这个字段不能为空但类型系统不管」这类只有踩过坑才知道的知识。
- **治理三件套**：baseline 登记 → drift 检测（Missing 工作区有文件而索引没条目 / Orphan 索引有条目而文件没了 / Stale 文件变了条目没跟 / Unbaselined 新条目未登记）→ `verify` / `check` 门禁。
- **meta 卷**：标签字典、撰写约束、配额——索引不会膨胀的机制保证。
- **delivery attestation**：证明模型把整份索引完整读进上下文（chunk/cursor/receipt/challenge）——防「扫一眼就说读完了」。
- **dir / 文件双粒度标签**与紧凑单行格式：token 效率优先，模型写、模型读。

取舍视角：AOCI 为「多智能体协作 + 数据库 schema + 大仓」设计，机制全套；DataLens 是单用户桌面查看器，取「FRAS 索引 + drift 治理 + meta 预算」主干，attestation 简化、Volumes 砍掉、DB 认知不采。

### 1.3 场景限定：代码类工作区才建

DataLens 用户打开的工作区很多是数据目录。per-file 语义索引对数据目录价值趋零（数据文件的「认知」是 schema 和统计，不是 FRAS）。判定信号（软判定，写进 meta 的 `scene` 字段，由 AI 建索引时自行评估，不做硬门槛）：

- `.git` / `go.mod` / `package.json` / `pom.xml` 等项目标记存在；
- 代码类扩展名占比（对照 `internal/toolchain` 的语言清单与 `structure.js` 的 17 语言范围）；
- 用户直接要求「给这个工作区建认知索引」时无条件建。

纯数据目录下 `cognition_*` 工具照常下发但工具描述注明适用场景，模型自己判断不建。

## 2. 目标与非目标

**目标**

1. 新会话冷启动从「全树探索」变成「读一份 1–2K token 的路径地图 + 按需取 FRAS 细节」。**目标量级取 1–2K 而非「几十 token」**：本仓库实测（根 79 + `internal` 172 个 Go 文件、前端 221 个 js、147 个测试）就已是数百文件的规模，纯路径地图不可能压到几十 token；承诺一个做不到的数字比把上限说清更糟。
2. R/S 类知识（强关联、暗约束）跨会话持久，且**带 drift 治理**——索引说「这个文件存在」时它真的存在、没被改过。
3. 索引维护是 AI 的职责而非用户负担：守则 + §5.5 维护提醒 + drift 报告驱动增量维护，用户不重复交代。
4. 多窗口/多实例不互相写坏（单写者租约），索引损坏可校验可重建。
5. 零新依赖、零 vendor 增量：文本卷 + 现有基建（atomfile / resourcelease / watch / storage）。

**非目标**

- 不做向量检索 / 嵌入 / 全项目内容索引——索引只存**语义条目**，不存代码内容。
- 不做数据库 schema 认知（不连 DB）。
- 不做 AOCI 的 lineage / relations / impact / evolution 派生投影（v1 无此需求）。
- 不替代工作区守则（`AGENTS.md` / `<workspace_rules>`）：守则是全局约定（人写、粒度粗），索引是 per-file（AI 写、粒度细）；meta 卷里写明分工，条目不重复守则内容。
- 不追求多宿主共享（AOCI 面向 Claude Code / Codex / Cursor 共用一份索引；本方案索引在 `.cadt/` 内，DataLens 私有）。

## 3. 总体模型

### 3.1 数据布局

```text
<ws>/.cadt/
├── cognition/            # 认知卷目录（设置 → 存储的勾选清理目标）
│   ├── meta.txt          # 元卷：场景类型、标签字典、撰写约束、预算（AI 可读写）
│   ├── code.txt          # 代码条目卷（AI 可读写，v1 唯一条目卷）
│   └── .state/
│       └── baseline.json # baseline：{path: {mtime, size, at}} + 卷指纹（Go 独占管理）
└── cognition.lock        # 写权租约锁文件——在 cognition/ 之外，理由见 §4.3
```

- 卷文件是**纯文本、每条目一行**——人类可直接读、git diff 友好、模型整段读写省 token。刻意不用 JSON/JSONL：这是给模型写模型读的媒介，行式文本的密度优势是 AOCI 实测过的核心设计。
- `.state/` 由 Go 独占管理，`cognition_edit` 拒绝写它——AI 只管语义条目，治理状态是应用的。
- **`.cadt/cognition/` 整树是 AI `write_file` / `edit_file` 的拒绝路径**（`.state/` 在树内；树外的锁文件也一并拒）：已核实 `ai-file-tools.js` 现无任何 `.cadt` 拒写校验——不加这道闸，write_file 今天就能改坏 `baseline.json` / `cognition.lock`，或绕过 edit 直写 `code.txt` 跳过预算、规则与 CAS 校验。卷的一切 AI 变更**单点收口 `cognition_edit`**（§5.1）；用户手工编辑卷不受限（纯文本媒介的设计初衷，人优先），代价是下次 edit 的 base 比对自然要求重读（§4.3）。
- 锁文件**不进** `cognition/`：`internal/memo/memo.go:139` 已立下约定（`<root>.lock` 在受保护目录之外，"目录被移动/回收时不失效"），清理或整目录删除时锁不跟着消失（§4.3）。
- v1 **不设激活入口文件**（AOCI 的 `aoci.txt` Volumes 合同）：单卷约定死，文件名即入口；多卷需求出现时再议。

### 3.2 条目格式（草案，定稿随 P1 实现钉死）

```text
<rel-path><TAB>[标签...]  F: 一句话职责  R: 强关联路径(逗号分隔)  A: 对外契约  S: 暗约束
```

- **一行一条，TAB 分列**；字段以 `F:` / `R:` / `A:` / `S:` 前缀自标识，值内禁 TAB（空格代替）——解析器不需要转义机制。切分口径：TAB 之后按「空格 + `F`/`R`/`A`/`S` + `:`」识别字段起点，因此**值内同样禁止出现 ` F:` / ` R:` / ` A:` / ` S:`** 这一序列（`R:` 值里要写「见 S: 说明」这类交叉引用时改写为「见 S 字段」）。R 字段的逗号是唯一的分隔符，路径里含逗号时该路径不单列（罕见，出现则退化为目录条目）。
- **路径归一（Windows 必做，否则 drift 全是假阳性）**：卷内 rel-path 一律**正斜杠、保留原始大小写**；比对时统一小写 + 正斜杠 + 去 `.\` / 前导 `/`。`Internal/` 与 `internal/`、`a\b.js` 与 `a/b.js` 必须视为同一路径，否则一次扫描就会同时报出成对的 Missing + Orphan 噪音，把真正的 drift 淹没。
- 字段可缺省（尾部缺省省 token）；`rel-path` 是第一列恒在；目录级条目以 `/` 结尾，覆盖「不单列」的成员文件（伸缩机制：大目录一条目录条目，重要成员再单列）。
- 标签为自由 token，字典在 meta 卷（如 `hot` 高频改动 / `fragile` 易碎 / `generated` 生成物 / `ai` AI 域）；索引不发明业务含义，标签只做筛选键。
- Go 解析器对每行独立容错：坏行跳过并计数上报，不炸整卷。
- 卷大小预算：条目 ≤ 600 / 字节 ≤ 256 KB（超出即触发 meta 里的收敛指引——合并目录条目、降级次要文件）。**预算的唯一权威是 Go 常量**；meta 里只有一行 `budget:` 供模型自查，Go 读到与常量不一致（改大改小都算）即拒绝写并报出正确值——只比对一行、不解析 `ruleN` 自由文本，AI 无法用等价写法绕过。
- overview 预算另算且更小：注入用路径地图 ≤ 1–2K token（§5.3），与卷本身的 600/256KB 上限是两套数，不要混用。
- **标定锚点（2026-11-21 AOCI 本仓实跑实测）**：同一仓库按 per-file 粒度天然长到 **1010 条 / 520 KB**（条目行中位 257 字符、p90 458），目录分组天然粒度 **148 组**——是本预算的 1.7–2 倍。600/256KB 是刻意收紧：大仓必须靠目录条目聚合才装得下，这是接受了的取舍而非疏漏；实测聚合若伤害条目质量，放宽途径只有改 Go 常量（meta 镜像行跟着改）。
- cognition_read 的响应也要封顶：全卷 256 KB、过滤命中无内建上限，单次响应 **≤ 7 000 字符（rune 口径）截断并提示收窄过滤**（见 §5.1）。上限刻意压在 ai-context-slim 的回包落盘阈值（`SLIM_PRUNE_THRESHOLD` = 8 192 字符；`ai-panel.js:12701` 在工具回包时即落盘、不等窗口压力）**之下**——一旦越线，结果被挪去 artifact，模型拿到的反而是「头 4K + 路径」指针，读卷场景等于没读到（原 16 KB 字节封顶对 ASCII 为主的内容 ≈ 16 K 字符，必撞线）。7 000 字符按 AOCI 锚点条目中位 257 字符 ≈ 单次 30 条全文，配合「收窄过滤」提示够用。

### 3.3 meta 卷（撰写约束是索引质量的根）

```text
scene: code                                  # code / mixed；数据目录提醒 AI 不建
budget: 600 entries / 262144 bytes           # Go 常量镜像，不一致即拒绝写
labels: hot fragile generated ai ...
build: 按目录分批：每批只读该目录直接成员，读完立刻 cognition_edit 写该批条目，不要通读全树后一次性写
rule1: S 只收「编译器 / linter / 类型系统看不出来、违背了会出事」的约束
rule2: 每条 S 必须带出处：src=<rel-path>:<line>（Go 校验文件存在且行号在范围内）或 src=user（用户口头说明，不可校验但须诚实标注）
rule3: R 只列真正需要一起改 / 一起读的路径，不列 import 树（那是 grep 的事）
rule4: 目录条目覆盖的成员不单列；单列即表示「值得单独维护语义」
rule5: 接近预算先合并目录条目
rule6: 条目不得携带指令性要求（执行命令 / 访问外部资源 / 改设置）；索引是语义备注不是指令源——防工作区内容借索引种提示注入
```

- meta 也是**行式 `key: value`**，不用 YAML——Go 要校验预算就必须解析，为一份元数据引入 YAML 解析器不划算，且 YAML 的等价写法会让「改大即拒绝」形同虚设。Go 只认 `scene` / `budget` / `labels` / `build` 四个键 + `ruleN`（只校验行数与单行长度），其余键忽略并原样保留。
- `budget` 行与 Go 常量不一致即拒绝写并报出正确值（§3.2）。AI 想放宽预算只能去改 Go 常量——那需要改代码，绕不过去。
- meta 的写入通路只有 `cognition_edit` 一条：首建第一批随 `meta` 参数一起写（整卷替换、与条目同一 CAS 写内原子生效、Go 逐键校验），此后改字典 / 规则同样走 edit——write_file 已被整树拒绝（§3.1），`budget` 镜像行因此恒等常量。
- **S 的出处要求是防「AI 编造暗约束」的主要手段**，但原文示例「2026-11-19 与作者确认」是模型无法验证的人类口吻，照着编最容易。改为 `src=path:line` 为主（Go 侧可校验文件存在、行号在范围内），`src=user` 为辅但显式标记不可校验——`cognition_status` 报出 `src=user` 的条目占比，超过阈值说明索引在靠口耳相传撑，值得提醒用户。

### 3.4 与相邻能力的分工（一条一条写清，防互相打架）

| 问题 | 该用什么 | 不该用什么 |
|---|---|---|
| 「这个文件是干什么的」 | cognition 索引（一次读） | search_text 猜（多轮） |
| 「找到那段报错代码」 | `internal/search` / glob / 结构面板 | 索引（它不存代码内容） |
| 「我们上周聊过这个」 | sessionindex / `session_search` | 索引 |
| 「用户的偏好与教训」 | memory | 索引（索引面向代码不面向人） |
| 「全局要守的约定」 | 工作区守则 / AGENTS.md | 索引条目（粒度不同，不重复） |

`ai-system-context.js` 注入的守则段必须包含这张分工表的模型可读版——否则模型会拿索引当 grep 用。

## 4. 治理机制

### 4.1 baseline 与 drift 四态

- **首建**：AI 按 §7 P1-4 的分批协议建卷，每批 `cognition_edit` 的写后簿记（见下）逐批落 baseline 记录；末批调 `cognition_status` 校验收口——baseline 缺失（`.state` 被清 / 损坏后的恢复）才全量补生成（fs 扫描 + 读卷），这是唯一的全树成本（预算内，wipe-guard 实测经验：千文件级 < 20 ms，超预算走采样并标记）。
- **edit 写后簿记（baseline 的正常维护路径，2026-11-21 评审补）**：CAS 写卷成功后，对本批 `entries[]` 涉及的文件条目逐一 stat——存在的刷新 / 新增 baseline 记录（mtime / size / at），并更新卷指纹（成为该会话下一轮 CAS base，§4.3）。没有这一步，AI 改完文件再更新条目后会**永报 Stale、新条目永报 Unbaselined**（status 的 baseline 生成只在缺失时触发，治理闭环合不上）；有了它，AI **未**维护的改动照报 Stale——那正是合法 drift 信号。目录条目不写 baseline 记录（Stale 豁免）。
- **drift 判定**（纯函数，Go 表驱动测试）：

| 态 | 条件 | 含义 |
|---|---|---|
| Missing | 工作区有文件、索引无条目（目录条目已覆盖的除外） | 索引落后于代码 |
| Orphan | 索引有条目、文件不存在 | 索引过时，条目该删 |
| Stale | 文件当前 mtime+size ≠ baseline 记录 | 文件变了，条目语义可能失效 |
| Unbaselined | 索引条目不在 baseline 里 | AI 新写条目没跑校验 |

- **目录条目豁免 Stale**：目录 mtime 随子项增删全变，按文件口径必噪音化——目录条目只参与 Missing 覆盖与 Orphan 判定；目录内文件的语义漂移靠维护轮与重读兜底，与下条接受的 mtime 漏报同一档取舍。
- **清单来源**：fs 遍历（复用 `internal/search` 的 SkipDir 忽略表 + 预算思路，**并自带 `.cadt/` 整树排除**——已核实 SkipDir / SkipPath 都不含 `.cadt`，只排 `.cadt/worktree`，`.cadt/tmp` 等明示可搜；不加这道闸 `meta.txt` / `code.txt` / `baseline.json` / `cognition.lock` 每次必报 phantom Missing，对齐 wipe-guard「忽略表是搜索的、drift 自己再加一层」的做法），**git 不是前提**（决策 4）；有 `.git` 时 P4 可选 `git ls-files` 加速，行为不变。
- `mtime+size` 判 Stale 有漏报（同尺寸内容改写）——接受：索引的语义修正本来就靠维护轮，drift 是提醒不是保证；精确 hash 留给 P4 可选项。

### 4.2 变更感知：不新增常驻监听

- 索引标脏走**现成链路**：工作区 watcher 已推 `workspace-changed`（`internal/watch`），`cognition_status` 被调用时**现算** drift（成本 = 一次预算内扫描），不做内存态的实时 drift 推送。
- 理由：drift 只在「AI 决定动手之前」需要，查询时算最省、最新鲜、无状态；实时推送对 AI 回合没有消费点（AI 生成中途不能插话），与 `ai-agent-notices` 的轮边界注入机制也不匹配。如果将来要「开新会话时自动注入 drift 摘要」，走轮边界注入而不是监听器。

### 4.3 写权租约与原子写

- 单写者：`internal/resourcelease` per-workspace 键（对齐 memo 的「多窗口单写者，第二个窗口只读」模式），锁文件放 **`<ws>/.cadt/cognition.lock`——在 `cognition/` 之外**。这不是偏好是既有约定：`internal/memo/memo.go:139` 的原话是「锁文件在被保护的 memo 目录之外（`<root>.lock`）：目录被移动/回收时不失效」。放进 `.state/` 会在清理或整目录删除时把锁一起删掉，而另一个窗口可能还握着它；`resourcelease` 的锁文件也本就设计成与被保护对象解耦（见 `resourcelease.go` 的 key 归一与 `Probe`）。租约范围：edit 全程独占，status 的 baseline 全量生成短暂取同一把独占租约——所有写路径一把锁，read 不取锁。
- 卷写入走 `internal/atomfile`（temp + rename）；`cognition_edit` 是**全卷读改写**还是**行级补丁**？→ 全卷读改写：卷 ≤ 256 KB，全卷 CAS 最简单且天然防并发撕裂；行级补丁的复杂度在这个体量下不划算。
- CAS：`cognition_edit` 由**前端自动附加 `base`**（调用方会话指纹登记表里的卷指纹，模型不可见，§4.4），Go 比对 `base` 与盘上当前卷内容哈希——不一致拒绝并要求重读，`base` 缺失（本会话从未 read/status 过）一律拒绝。原定「比对 `.state` 里登记的卷指纹」防不了互覆：每次成功 edit 后登记值 = 盘上值，比对恒真；真 CAS 必须比对**调用方**最后读到的版本。edit 成功后前端把登记值更新为新指纹（自己刚写的版本无需重读），`.state` 不再登记卷指纹——needsReread 用前端登记表就够，少一份要同步的状态。

### 4.4 已读回执（attestation 的简化版）

AOCI 用 chunk/cursor/receipt/challenge 证明「整份索引完整进了上下文」。本方案整卷 ≤ 256 KB，没有 chunk 问题，简化为：

- `cognition_read` 返回内容 + `fingerprint`（卷内容哈希 + 时间；哈希口径 = `meta.txt` 与 `code.txt` 拼接字节的 sha256，拼接顺序定死）；前端在会话内存登记 `sessionId → fingerprint`（纯函数 + Map，可测）。**登记表同时是 `cognition_edit` 的 CAS `base` 来源**（§4.3）——edit 成功后登记值更新为新指纹。
- `cognition_status` 的响应带当前 `fingerprint` 与 `needsReread`（= 会话登记的指纹 ≠ 当前）——维护轮开始前模型若没读过最新卷，status 明说「先 read 再 edit」。
- challenge 全套不做：单用户单模型场景，「没读就改」由 CAS 直接拒绝兜底，够了。
- **登记表只存内存，不持久化**：应用重启、会话从磁盘恢复、换窗口查看同一会话，登记表都是空的 → 首次 `status` 必报 `needsReread=true`。这是预期行为不是缺陷（保守方向，误报一次重读的代价远小于基于脏指纹改卷），不要为消掉它去做持久化。子代理沿用父会话的 `sessionId` 登记，不单独维护一份。

## 5. AI 工具设计（3 件）

### 5.1 工具与参数

| 工具 | 参数 | 语义 |
|---|---|---|
| `cognition_read` | `paths?`（过滤路径前缀数组）、`labels?`、`query?`（关键词，命中 F/R/A/S 值） | 读条目卷；无参 = 返回 overview（路径 + 标签，不含 FRAS 正文，省 token）；有过滤 = 返回命中条目全文，**单次响应 ≤ 7 000 字符（rune 口径，压在 context-slim 的 8 192 字符回包落盘阈值之下——越线会被 artifact 指针化，模型反而拿不到内容），超出截断并提示收窄过滤**（Go 侧封顶）。响应带 fingerprint |
| `cognition_edit` | `op`（add / update / remove）、`entries[]`（路径 + FRAS 字段 + 标签）、`meta?`（整卷替换 meta.txt）、`reason`；另有前端自动附加的 `base` 卷指纹（模型不可见，CAS 基准 §4.3） | 增量维护条目与 meta；CAS 写（`base` 与盘上哈希比对，缺失 / 过期一律拒绝）；违反 meta 规则 / 超预算 / 条目 rel-path 非法（绝对路径、含 `..`、以 `.cadt/` 开头）一律拒绝并报原因；`op=add` 命中已有路径**显式报错**（逼先 read，与 needsReread 同语义）。**写入目标只有 `meta.txt` / `code.txt`**：`.cadt/cognition/` 整树已列为 write_file / edit_file 拒绝路径（§3.1），`.state/` 与锁文件由 Go 独占。写后簿记见 §4.1 |
| `cognition_status` | `verbose?` | drift 四态报告 + fingerprint + needsReread + 预算余量；无索引时返回「未建立」与建索引指引。**唯一副作用**：索引存在但 baseline 缺失（首建末批收尾，或 `.state` 被清 / 损坏后的恢复）时全量生成 `baseline.json`——正常维护的 baseline 簿记在 edit 侧（§4.1），这里只是兜底；工具描述写明，其余调用零写入（§8 有测试断言） |

收敛为 3 个的理由：AOCI 拆 9 个是因为职责面宽（规则/报告/维护/证据分离、多宿主工作流）；本方案单宿主，`aoci_rules` 的内容由 meta 卷 + 系统守则承担，`aoci_report` / `aoci_header` 并进 status，update/remove 合并进 edit 的 op——工具目录预算宝贵，3 个封顶。

### 5.2 档位与审批

- 下发范围：`toolsForScope` 各档——`cognition_read` / `cognition_status` 全档；`cognition_edit` 不进 read 档（写卷虽限 `.cadt/`，但首次建索引会诱导大量探索，read 档场景不该发生）。
- 计划模式：`cognition_edit` **不派**（2026-11-21 评审修正，原定「对齐 memo 放行」与代码事实相反）：计划模式契约是零副作用，两个先例都是拦——memo 写动作硬拦（`ai-panel.js:10388`「计划模式下禁止写快捷便签」），propose_patch 因会写 `.cadt/patches` 降级 dry_run（`ai-panel.js:10719`）——「写的是应用状态区」恰是被拦的那类。实现零成本：`toolsForScope` 按 planMode 收窄，纵深防御层（`ai-panel.js:9533`）自动兜底；首建 / 维护挪到执行阶段，探索期发现的 S 约束先记进计划正文。
- 审批：不进 `analyzeDangerousCommand` 体系（不是命令）；写路径硬校验在 Go 侧（§5.1），不依赖前端档位判断。
- 子代理：**v1 一律不派 `cognition_edit`**。这不是收紧而是对齐代码现状：`subToolsForScope`（`ai-subagents.js`）是**手工白名单**而非档位表，其成文不变量是「子代理拿不到任何写工具」（`ai-subagents.js:205`），唯一写例外是隔离 worktree 子代理的 write/edit（写效应圈定在隔离前缀内）。`cognition_read` / `cognition_status` 推进白名单；子代理发现条目该维护时汇报回父代理、由父代理 `cognition_edit`。隔离 worktree 子代理同样不给——它的工作区是隔离前缀，不覆盖主工作区的 `.cadt/`，硬给只会造成两套写权判定并存（本方案自己警告过的形态）。指纹登记沿用父会话 `sessionId`（§4.4），父代理的 edit 子代理 `status` 直接可见。
- 群聊：v1 **不派** `cognition_edit`。写权租约是 per-workspace 单写者，多个群成员并发维护只会互相 `Busy`；群共享索引的读写边界留 P4。

### 5.3 注入策略（与 context-slim 对齐）

**落点是轮上下文，不是系统提示词。** 这一条是硬约束，不是实现细节：

`ai-system-context.js` 自 2026-11-15 起的核心约定是「稳定区 / 动态块分离」——文件头注释写明动态块（工作区状态 / 清单 / 提醒 / 附件）全部移出系统提示词、经 `turnContextBundle` 随起轮的用户消息落盘，目的是「系统提示词每轮完全一致，服务商前缀缓存可整段命中」。cognition 卷是**会被 `cognition_edit` 改写的可变内容**；把它塞进 `assembleSystemContext` 意味着每次维护都改系统提示词，而系统提示词是前缀的第一段——一变则整个会话历史缓存全废、按非缓存价重算。省下 1–2K，赔掉几十万 token 的缓存折扣，与 §2 的目标 1 完全相反。

- **只注入一次**：起轮路径判定「本会话历史里还没有 `cognition_index` 块」时才生成，块随首轮用户消息落盘，此后成为历史的一部分——永久可缓存、只付一次钱。判定抽成纯函数 `shouldInjectCognitionOverview(messages)` 配单测，不要靠会话字段（恢复会话时字段可能已丢）。auto-compact 裁掉历史后块可能消失、判定自然再次为真——**压缩后重注入是预期恢复行为不是缺陷**，明文写死防止实现时当 bug 修掉。
- **注入路径范围与预取**：v1 只挂主会话的 `startSessionTurn`（支线对话 / 群聊 / 子代理不注入）。`turnContextBundle` 是同步组装（`ai-panel.js:11848` 无 await），overview 快照必须在会话打开 / 切工作区时**预取**进 `ai-cognition.js` 的缓存，bundle 只消费缓存、不自己调后端；预取失败按无索引处理，不阻塞起轮。
- **内容**：场景 + 条目数 + **纯路径地图**（每行 `path [标签]`，无 FRAS 正文）+ 一句使用守则（含 §3.4 分工表的模型可读版）。
- **预算 1–2K token（约 4–6K 字符），硬上限**，与卷的 600 条目 / 256 KB 上限是两套数（§3.2）。超限降级**三级**：① 只注入 `hot` 标签条目 + 目录条目；② 只注入目录条目 + 一句「细节用 `cognition_read` 取」；③ 只注入**顶层目录**（深度 ≤ 2）+ 一句「目录全貌与细节用 `cognition_read` 取」。**第三级不是理论兜底**：AOCI 本仓实跑的目录分组是 148 组，纯目录路径地图 ≈ 8–10 KB，连②都顶破 4–6K 字符上限——**500+ 文件的仓库稳态就落在③**，①②是中小工作区的主路径。降级档位写进响应 meta，便于 P3 实测回填。
- **不整卷注入、不每轮重复、不随 `cognition_edit` 刷新**（决策 2）：会话内索引被改后，模型靠 `cognition_status` 的 `needsReread` 发现该重读，而不是靠宿主重注。
- 开关：`aiInjectCognition`（默认开），在 `ai-context-slim` 的注入统计里以 `meta.cognition` 可见字符数与降级档位——和 AGENTS.md / 记忆同一套口径，用户能看见它吃了多少上下文。

### 5.4 系统守则

`ai-system-context.js` 新增守则段。**文案常驻、不按「索引是否存在」条件注入**——条件注入会让系统提示词在索引被建立/清理的那一刻变一次，缓存就断一次；存在性判断交给动态块（§5.3 的 overview 只在有卷时出现），守则本身只描述「有索引时该怎么做、没有时可以用 status 建」：

- 动手改代码前，先确认相关文件的条目（overview 命中或 `cognition_read` 过滤），条目里的 R/S 是「改这里必须知道的事」；
- 完成一次实质改动后，维护受影响条目（`cognition_edit`），这是职责不是可选项；
- 发现 drift（status 报 Missing/Stale 且与当前任务相关）时顺手修；
- S 条目与代码冲突时，以代码现状为准并修正条目，同时在回复里向用户点出冲突。

守则段本身属稳定区（文案固定、不随卷内容变化），放 `assembleSystemContext` 是正确的——与 §5.3 拒绝把卷内容放进去并不矛盾：**变的是卷，不是守则**。

### 5.5 维护提醒（让守则真的被执行）

§5.4 把维护写成「职责」，但只靠守则约定的动作在长会话里会被遗忘——记忆区之所以有效，是因为有占位引导 + 内容每轮注入；守则只有一次性文字。补一条**低成本、无侵入**的提醒，复用 `turnContextBundle` 的现成机制：

- **条件**（纯函数 `shouldNudgeCognition(messages, indexState)`，配单测）：本会话已发生 `write_file` / `edit_file` / `apply_patch` 且涉及的文件在索引里有条目（或目录条目覆盖）→ 且此后没有**成功的** `cognition_edit`。
- **文案**：一行，`<cognition_nudge>` 块——「本会话已改动 N 个文件（列出 ≤5 个路径），认知索引里有对应条目但未更新；相关就顺手 `cognition_edit`，不相关忽略。」加「不相关忽略」是有意的：不允许把提醒变成强制仪式，否则模型会为了消掉提示而写垃圾条目。
- **不做的事**：不进 `ai-agent-notices` 信箱（那是唤醒新轮的语义，太重）；不做实时 drift 推送（§4.2 的结论不变）；不阻断本轮（不是审批）。
- 每轮最多一次、同一批文件不重复提醒（提醒过后改文件集合未变则不再出）。
- 三级降级落到③（只有顶层目录地图）时，文件级覆盖判定退化——**方向必须是「少提醒」而非「误提醒」**，与文案里「不相关忽略」同一取向；宁少勿滥。

这一条是本方案「索引不腐烂」的最关键接线——没有它，§9 第一行风险（AI 不维护）就只能靠自觉。

## 6. Go / 前端分工与接线点

**Go（`internal/cognition` 新包，Deps 注入 Root/Logf，不 import main）**

- `parse.go`：卷解析（§3.2 格式，行级容错）+ 校验（预算常量 / 路径合法性 / meta 的 `scene`·`budget`·`labels`·`build`·`ruleN` 键）+ 路径归一（正斜杠 + 小写比对，§3.2）。
- `drift.go`：清单扫描（search 忽略表 + 自带 `.cadt/` 整树排除 §4.1 + 预算）+ 四态判定（纯函数）+ baseline 读写。
- `service.go`：Read / Edit（base CAS 全卷写 + 写后 baseline 簿记，§4.1 / §4.3）/ Status；resourcelease 租约（锁在 `<ws>/.cadt/cognition.lock`，写路径一把锁）；atomfile 落盘；`LockForClear(ws)` 供清理门闩调用（与 `memo.LockForClear` 同签名）。
- `cognition_app.go` 绑定壳：`CognitionRead / CognitionEdit / CognitionStatus`；v3 无 wailsjs（前端经 `Call.ByName` 动态解析），只需 `dev/mock-backend.js` 补三个同名 mock。
- `storage_app.go:39` 的 `BeforeClear` 表新增一项：`"cognition": func(ws string) (func(), error) { return cognition.LockForClear(ws) }`——**这是必须项不是可选项**。已有先例是 `ai-sessions` / `memo` / `ws-memo` / `wipe-guard` 四条，语义都是「资源正被另一窗口持有时拒绝清理」；漏了它，第二窗口 `cognition_edit` 写到一半被用户点清理，卷删在写路径中间，CAS 与租约都救不回来。
- `internal/storage/specs.go`：登记 `.cadt/cognition` 勾选清理条目（`inCache: false`）；**不进** `TestCacheIDs`（索引重建要 AI 重写一遍，成本高——对齐 wipe-guard 的负向断言先例），并补一条 `cognition ∉ CacheIDs` 的负向断言。

**前端**

- `ai-tool-defs.js`：3 个 def + `AI_TOOL_CATALOG` + `AI_TOOL_GROUPS` 登记（守卫 `ai-tool-wiring.test.mjs` 三方对账：描述提及的参数 ↔ properties ↔ executeTool 分支）；执行分支在 `ai-panel.js` `executeTool` 加 case，工具卡 `ai-tool-cards.js` 补 `toolMeta`（verb + icon，图标在 `core/icons.js` 注册）。
- AI 写工具拒绝路径：`write_file` / `edit_file` 的路径校验处加 `.cadt/cognition/` 前缀拒绝（落点实施时核对 `ai-panel.js` 执行分支与 `ai-file-tools.js`；对齐 `ai-read-roots` 硬拒的镜像思路），配接线测试——这是 §3.1 单点收口的前端半边。
- `ai-cognition.js`（新）：工具执行 + 会话指纹登记（CAS `base` 来源，§4.3 / §4.4）+ overview 预取缓存（§5.3，会话打开 / 切工作区时取）+ 三组纯函数——`resolveNeedsReread`（§4.4）、`shouldInjectCognitionOverview`（§5.3 只注入一次）、`shouldNudgeCognition`（§5.5 维护提醒）+ overview 渲染与三级降级；配 `frontend/test/ai/ai-cognition.test.mjs` 并在 `npm test` 登记。
- `ai-system-context.js`：**守则段进稳定区**（§5.4，文案固定）；**`cognition_index` 与 `cognition_nudge` 两个动态块进 `turnContextBundle`**（§5.3 / §5.5，可变内容不进系统提示词；消费预取快照、保持 bundle 同步组装）。
- 设置页 v1 不做专门 pane：开关复用 AI 设置页现有结构（实施时并入最近的设置分区），状态查看靠 `cognition_status` 工具卡本身。

## 7. 实施步骤

### P0 · 前置验证（**已完成，2026-11-21 结清**）

原计划「把 aoci（用户自装二进制）经 MCP 接入真实仓库试用」，事实上已经发生：本仓库自 2026-11-19 起由宿主侧 AOCI 实跑（根目录 `aoci.txt` + `.aoci/`），实测结论直接回填本方案：

- **天然规模**：per-file 粒度下本仓长到 1010 条 / 520 KB / 148 目录分组，是 §3.2 预算（600 / 256KB）的 1.7–2 倍——预算收紧是刻意取舍，锚点记录在 §3.2；
- **首建成本**：`.aoci/drafts/` 30+ 个候选批次（7 KB–160 KB）跨两天重度迭代才收敛——per-file FRAS 首建是重活，P1-4 分批协议与 §5.5 维护提醒按「必然发生」设计而非锦上添花；
- **overview 粒度**：目录分组级路径地图 ≈ 8–10 KB，顶破原两级降级的 4–6K 字符上限——据此补了第三级（顶层目录），见 §5.3；
- **质量体感**：FRAS 确实装得下 grep 给不出的 R/S 类知识；S 字段质量高度依赖撰写纪律——meta 的 `ruleN`（§3.3）与 `src=` 出处要求不能省。

aoci 不是本方案的依赖，只是验证工具；它给验收留下的混淆变量见 P3 引言。

### P1 · Go 引擎

1. `internal/cognition`：parse / drift（自带 `.cadt` 排除）/ service（base CAS + 写后簿记）三件 + `*_test.go`（格式向量、行级容错、路径归一、四态判定表、预算拒绝、CAS 三态（缺失 / 过期 / 通过）、edit 簿记闭环、租约互斥、清理门闩互斥、`.cadt` 不进清单）；
2. `cognition_app.go` + `dev/mock-backend.js` 三件 mock（v3 无 wailsjs）；
3. `storage_app.go` 门闩表加 `cognition` + `internal/storage/specs.go` 登记 + 负向断言（cognition ∉ CacheIDs）；
4. **建卷协议**（写进工具描述与 meta 的 `build` 行）：首次建卷必须**按目录分批**——一批只读该目录的直接成员、读完立即 `cognition_edit` 追加该批条目、末批完成后跑 `cognition_status` 收 baseline。理由是本仓库规模（根 79 + `internal` 172 个 Go 文件、前端 221 个 js）一次通读必然触发上下文压缩，压缩后前面的认知丢失，写出来的条目会退化成"凭目录名猜职责"。分批还有一个副作用是好的：每批都能立刻看到 CAS 与预算反馈。

### P2 · AI 工具接线

1. `ai-tool-defs.js` 三处登记 + `toolsForScope` 档位（含 `subToolsForScope` 与群聊不派 `cognition_edit`）+ 计划模式不派 `cognition_edit`（按 planMode 收窄）；
2. `ai-panel.js` executeTool 三 case + `ai-tool-cards.js` toolMeta + 图标；
3. `ai-cognition.js`（指纹登记与 CAS `base` 附加 / overview 预取缓存 / `resolveNeedsReread` / `shouldInjectCognitionOverview` / `shouldNudgeCognition`）+ `frontend/test/ai/ai-cognition.test.mjs` 登记 `npm test`；
4. `ai-system-context.js` 守则段（稳定区）+ `turnContextBundle` 的 `cognition_index`（首轮一次，消费预取快照保持同步）与 `cognition_nudge`（§5.5）+ `aiInjectCognition` 开关与 `meta.cognition` 统计；
5. AI 写工具拒绝路径：`write_file` / `edit_file` 路径校验加 `.cadt/cognition/` 前缀拒绝（§3.1）+ 接线测试。

### P3 · 端到端验收（**试验田改用无 AOCI 的普通代码仓库**）

> 本仓库已由宿主侧 AOCI 维护一份并行索引（P0 实跑，1010 条 / 520 KB），在这里验收测出的是「内置索引在 AOCI 之上的边际价值」而非净价值；且 DataLens 自己的 AI 会话经 `<workspace_rules>` 吃进 AGENTS.md 里 14 KB 的 AOCI 契约块（教模型调 `aoci_*` 工具，而它并没有这些工具），探索轮数的统计会被这层噪音污染。**试验田换一个无 AOCI、无宿主注入合同的普通代码仓库**；本仓库降级为「双索引共存」观察点——`cognition_status` 检测到根目录 `aoci.txt` 清单时在响应里提示一句「已有外部认知索引，是否建/续维护由用户决定」（P3 可选项，不做自动合并，见 §9）。

1. 让 AI 给试验田仓库建索引（条目结构参考本仓的包/域划分：十几个包 + 分域前端目录是天然的目录条目骨架），**观察它是否自发分批**；不分批就说明 P1-4 的协议没写进工具描述；
2. 人工改动几个文件 → `cognition_status` 报 Stale/Missing → AI 维护轮收敛 → status 干净；**再改一次但故意不提维护**，看 §5.5 的提醒是否在下一轮出现且被采纳；
3. 删一个文件 → Orphan 被报出；两个窗口同时 edit → CAS 拒绝一方；第二窗口 edit 期间点清理 → 被门闩拒（不是删一半）；
4. 用两个不同会话验证 overview 注入 + 按需读的 token 实测开销，回填参数；**同时验前缀缓存**：会话里调用一次 `cognition_edit` 后，确认系统提示词未变（若变了说明注入落点又跑回稳定区了）；
5. **量化对比**（这是"值不值"的唯一判据）：同一任务在两个空白会话各跑一次——有索引 / 无索引——记首轮工具调用次数、首次改对文件前的探索轮数、总 token。差值为负就是该砍的信号。

### P4 · 打磨（可选，按 P3 体感决定）

- 有 git 工作区的 `git ls-files` 清单加速；精确 hash 判 Stale 的可选项；
- `cognition_edit` 写路径挂 wipe-guard Backup（原文本已在内存，成本 ≈ 0）；
- 群聊场景：群成员共享索引的读写边界（若群聊智能体也要维护索引）。

### P5 · 文档收口

`AGENTS.md`（`internal/cognition/` 进 Go 后端清单、AI 工具域补 `ai-cognition.js`）· `CHANGELOG.md` · `README.md` AI 小节；方案移入 `docs/finished-plans/`。

## 8. 验证方式

| 层 | 验证 |
|---|---|
| 格式解析 | Go 表驱动：标准行 / 缺字段 / 目录条目 / 坏行跳过计数 / TAB 注入拒绝 / 值内 ` F:` 视为字段起点（不误吞正文）/ 超预算拒绝 / meta `budget` 行与常量不一致即拒 |
| 路径归一 | `Internal/` vs `internal/`、`a\b.js` vs `a/b.js`、前导 `./` 视为同一路径；一次扫描不产生成对 Missing + Orphan |
| drift 判定 | 四态各造一例 + 目录条目覆盖豁免（且目录条目豁免 Stale）+ `.cadt/cognition/**` 与 `cognition.lock` 不进清单（无 phantom Missing）+ 预算采样降级标记 |
| 写路径 | CAS 三态：`base` 缺失（未读过）拒绝 / 过期拒绝 / 匹配通过后新指纹成为下轮 base；`op=add` 撞已有路径报错；条目 rel-path 非法（绝对路径、`..`、`.cadt/` 前缀）拒绝；**edit 写后簿记闭环：改文件 → edit 条目 → 下轮 status 不再报 Stale / Unbaselined**；`write_file` / `edit_file` 写 `.cadt/cognition/**` 被拒；edit 无目标路径参数（`.state/` 不可达）；租约互斥（第二窗口 Busy）；锁文件在 `<ws>/.cadt/cognition.lock` 而非卷目录内 |
| 工具响应 | `cognition_read` 过滤命中 > 7 000 字符截断并提示收窄过滤（且该上限 < `SLIM_PRUNE_THRESHOLD` 的 8 192，回包不被指针化）；`cognition_status` 仅在索引存在但 baseline 缺失时写 `baseline.json`，其余调用零写入（Go 测试断言） |
| 清理联动 | `BeforeClear` 门闩：另一窗口持租约时清理被拒；`cognition ∉ TestCacheIDs` 负向断言 |
| 注入 | `shouldInjectCognitionOverview` 只在无 `cognition_index` 块时为真；压缩裁掉历史块后再次为真（预期行为断言）；三级降级逐档触发（大仓稳态落③）；**系统提示词在 `cognition_edit` 前后逐字相同**（前缀缓存不失效的回归守卫） |
| 维护提醒 | `shouldNudgeCognition`：改过条目内文件且无成功 edit 才为真；提醒过后同批文件不再重复；无索引时不出现 |
| 前端 | `resolveNeedsReread` / overview 渲染截断 / 过滤命中——`ai-cognition.test.mjs`；工具接线由 `ai-tool-wiring.test.mjs` 守卫 |
| 端到端 | P3 清单（含量化对比） |

Go 测试一律后台执行、显式带 `-timeout`（AGENTS.md 约定）。

## 9. 风险与取舍

| 风险 | 处置 |
|---|---|
| 索引腐烂（AI 不维护 / 内容过时） | 守则把维护定为职责 + §5.5 维护提醒（改过条目内文件却没 edit 时下一轮一行提示）+ status 的 drift 报告——腐烂的索引比没有更糟，所以治理是本方案一等公民而非附属 |
| AI 编造暗约束（S 字段污染） | S 必须带 `src=path:line`（Go 校验文件存在与行号范围）或显式 `src=user`；status 报 `src=user` 占比；守则「S 与代码冲突以代码为准」；用户可直接改纯文本卷 |
| 卷内容被工作区内容投毒（提示注入经索引持久化） | 索引定位是「模型写的语义备注」不是指令源：meta `rule6` 禁指令性内容（执行命令 / 访问外部资源 / 改设置）+ 守则「S 与代码冲突以代码为准」+ 用户可直读纯文本卷审计；信任面与 `AGENTS.md` 同级、不扩大 |
| token 开销失控 | overview 封顶 1–2K + 三级降级（大仓稳态落③）+ 只注入一次 + 按需读；P3 实测回填 |
| **overview 注入击穿前缀缓存** | 落点固定在 `turnContextBundle`、只在无 `cognition_index` 块的会话注入一次；§8 有"edit 前后系统提示词逐字相同"的回归守卫——这是最容易在实现时走回旧路的一条 |
| **首建时上下文被压缩** | P1-4 的分批建卷协议（一批目录一写）+ meta 的 `build` 行；P3 明确观察是否自发分批 |
| 大工作区条目爆炸 | 目录级条目伸缩 + 600/256KB 硬预算 + meta 收敛指引 |
| 多窗口互覆 | resourcelease 单写者（锁在卷目录外）+ CAS 指纹拒绝 |
| 清理与写卷撞车 | `BeforeClear` 门闩按 memo 先例挂 `cognition`；租约持有时清理被拒而非删一半 |
| 索引随 `.cadt/` 被整仓误删 | wipe-guard 是另一方案的事；本方案索引可由 AI 全量重建（条目都来自 AI 的认知，损失 = 重建成本非数据损失） |
| 数据目录误建索引 | 场景软判定 + 工具描述注明 + meta.scene 记录 |
| 工作区已有外部认知索引（如宿主侧 AOCI），双份并行互相漂移 | 不做自动合并（两套格式的语义映射是另一个方案的事）；`cognition_status` 检测到根目录 `aoci.txt` 清单时提示一句，建/续维护由用户裁决（§7 P3 可选项）；P3 试验田改用无外部索引的仓库规避污染 |
| 新包维护成本 | 文件 ≤ 1500 行、函数 < 200 行、纯函数表驱动测试（项目红线） |

## 10. 明确否决的方案

| 方案 | 否决理由 |
|---|---|
| 打包 / sidecar aoci 二进制 | 体积红线 + FSL-1.1-MIT 不允许 redistribution + 违背「系统提供引擎」哲学 |
| 抄 AOCI 的 spec 文本、格式文案、代码 | license：思想借鉴自由，表达不搬；本方案全部自定格式与自写实现 |
| 9 个工具照搬 | 单宿主场景职责面窄，3 个封顶（§5.1 论证） |
| 索引进 SQLite | 「不要把会话正文搬进 SQLite」的同一精神——卷是文本媒介，行式格式对模型读写的 token 效率是核心设计；派生索引（sessionindex 先例）只在「检索」场景成立，这里没有检索需求（grep 值由 search 承担） |
| 向量化 / 嵌入索引 | 体积红线 + `optimization-proposals.md` 第四节已否决全项目索引方向 |
| 整卷每轮注入上下文 | 与 `ai-context-slim` 方向相反；overview + 按需读（决策 2） |
| overview 放进系统提示词「稳定区」 | 卷是可变内容，写进稳定区等于每次维护都击穿前缀缓存；落点固定 `turnContextBundle` 且只注入一次（§5.3） |
| meta 卷用 YAML | 为校验一行预算引入解析器不划算，且 YAML 等价写法会让"改大即拒绝"失效；改行式 `key: value`（§3.3） |
| 锁文件放卷目录内（`.state/lease.lock`） | 违反 memo 已立下的"锁在被保护目录之外"约定；清理/删目录时锁跟着消失而另一窗口还握着它（§4.3） |
| 计划模式放行 `cognition_edit`（原决策，2026-11-21 翻转） | 计划模式契约是零副作用；已核实两个先例都是拦——memo 写动作硬拦（`ai-panel.js:10388`）、propose_patch 因会写 `.cadt/patches` 降 dry_run（`ai-panel.js:10719`），「写的是应用状态区」恰是被拦的那类；改为计划模式不派、`toolsForScope` 按 planMode 收窄（§5.2） |
| Volumes 多卷激活模型（`aoci.txt` 入口） | v1 单卷，约定死文件名；多卷需求出现再议 |
| Database Cognition（读 DB system catalog） | 本应用不连 DB，超出查看器定位 |
| 实时 drift 推送（监听器 → AI） | AI 回合无消费点；查询时现算（§4.2） |
| challenge 全套 attestation | 单用户单模型，CAS 拒绝兜底够用（§4.4） |
| 硬依赖 git 清单 | 工作区常非仓库；fs 扫描为准、git 加速可选（决策 4） |

## 11. 附：AOCI 机制对照

| AOCI 机制 | 处置 | 落点 |
|---|---|---|
| FRAS 四字段 | **采纳**（本方案核心） | §3.2 条目格式 |
| per-file 单行紧凑索引 + 模型撰写 | **采纳** | §3.1 / §3.2 |
| 目录级条目（伸缩） | **采纳** | §3.2 |
| meta 卷（字典 / 约束 / 配额） | **采纳** | §3.3 |
| baseline + drift 四态门禁 | **采纳**（fs 清单为准） | §4.1 |
| CAS 原子写 + 跨进程锁 | **采纳**（复用现有基建） | §4.3 |
| delivery attestation | **简化**（已读回执） | §4.4 |
| Volumes 多卷 + 激活入口 | **不采**（v1 单卷） | §3.1 |
| Database Cognition | **不采** | §10 |
| lineage / impact / evolution 投影 | **不采**（v1 无需求） | §10 |
| 多宿主共享（写入各宿主配置） | **不采**（DataLens 私有） | §2 |
| `aoci ui` 本地面板 | **不采**（status 工具卡够用） | §5 |
