# 图标统一管理治理方案（icon-consolidation）

> 状态：已实施（2026-11-22，P0–P3 全部落地，护栏红/绿自检通过，全量前端测试与 vite build 通过）。
> 立项日期 2026-11-21。
> 缘起：用户反馈 AI 消息右键菜单 4 个图标完全相同 + 1 个无图标；顺带评估「全软件图标是否需要统一管理」。
> 结论：**统一管理的地方早就存在**（`frontend/src/core/icons.js` + `docs/icon-guidelines.md`），问题不是缺地方，而是「规范存在、执行失效」——注册表建好了但没有强制路径，业务侧各自造轮子。因此本方案是「治理存量 + 收紧后门 + 加护栏」，不是另起炉灶。

## 一、目标与现状

### 目标
让「同语义复用同一份 SVG」成为默认路径而非自觉行为：新增图标必须进注册表，业务代码不再手写重复 SVG，视觉参数（网格 / 线宽 / 着色）全仓一致。

### 现状：三层图标体系并存

| 层 | 位置 | 职责 | 评价 |
|---|---|---|---|
| 通用 UI 图标注册表 | `frontend/src/core/icons.js`（约 90 键 + 40 遗留码位映射） | 菜单 / 工具栏 / 状态栏 / 面板通用图标 | 设计正确，但覆盖与执行不足 |
| 专用图标域 | `core/fileicons*.js`（文件类型）、`ai/ai-provider-icons.js`（品牌）、`core/widget.js` + `core/*-render.js`（AI 可视化引擎） | 各自独立语义 | **合理例外，不要并入通用注册表** |
| 业务侧散落 / 影子注册表 | 21 个业务文件里的内联 `<svg>` + `iconHtml` 字面量 + `ai-panel.js` 本地 `icon()` 工厂 | 各画各的 | **本方案要治理的对象** |

### 盘点数据（2026-11-21 全量只读调查）

- 业务代码内联手写 `<svg>`：**76 处 / 21 文件**，按语义约 85 个——量级已接近整个注册表。
- 重复语义至少 **12 组**：折叠箭头单语义 ≥10 处、刷新 5 处、文件夹 3 处、勾 3 处、文档 ≥3 处。
- 逐字符复制的典型：
  - `explorer/explorer.js:3` ↔ `git-graph/git-graph.js:20`（后者注释自认「与 explorer 同一造型」）。
  - `explorer/explorer.js:8` ↔ `shell/titlebar-popovers.js:16`（refresh/update 路径完全相同：`M12.8 8a4.8 4.8 0 1 1-1.4-3.4…`）。
  - `ai/ai-ask-cards.js:7` ↔ `ai/ai-tool-cards.js:513`（问号圆圈）。
  - `ai/ai-usage-ui.js:185` ↔ `ai/ai-panel.js:5493`（数据库）。
- 视觉参数失控：viewBox 三种网格（`0 0 14 14` / `0 0 16 16` / `0 0 20 20`）、stroke-width 六种值（1.1 / 1.2 / 1.3 / 1.4 / 1.5 / 2），与规范要求（`0 0 16 16` + 1.4）冲突。`editor/editor-groups.js:498` 甚至用 `<text>` 画 binary 图标，脱离「16 网格路径」约定。
- 遗留码位 `E8C8` 等仍在全仓几十处菜单数据里使用，而 `docs/icon-guidelines.md` 明写「新代码禁止使用码位」。
- **零护栏**：`frontend/test` 里没有任何针对图标规范（`ICONS` / `iconHtml` / 内联 `<svg>` / 遗留码位）的断言——这是规范失效的根因，全靠自觉。

### 绕过注册表的两个后门（重点）

1. `main.js:3597` 的 `AI_REFERENCE_ICON_HTML`：手写 `viewBox="0 0 20 20"`，经 `renderMenuIcon` 的 `item.iconHtml` 分支（`core/icons.js:210-211`）直接注入「引用该文件 / 引用选取」右键菜单。注册表已有语义相近的 `sparkles` 却不用；同一图形在 `editor/structure-panel.js:132` 又被复制一次。
2. `ai/ai-panel.js:5485-5497`：本地 `icon()` 工厂 + `icons` 对象，生成 copy/edit/regenerate/retry/rewind/branch/database/sidechat/bringback/deliver 共 10 个图标——业务侧又建了个「影子注册表」，且 stroke-width 用 1.2（非规范 1.4）。

## 二、治理原则

1. **不新增体系**：一切收敛到 `core/icons.js`，不建第二套注册表、不引入图标库（体积预算为 0）。
2. **保留合理例外**（不算散落，禁止并入）：
   - 文件类型图标 `core/fileicons*.js`（含 mono 文字主题）；
   - 品牌图标 `ai/ai-provider-icons.js`；
   - AI 可视化引擎 `core/widget.js` / `core/*-render.js`（产物是静态 SVG，语义与 UI 图标不同）；
   - `index.html` 静态内联 SVG（规范已允许，但视觉参数需与注册表对齐）。
3. **语义优先于造型**：同语义统一一个键；确实需要两种造型（如 删除=垃圾桶 / 清屏=橡皮）时登记两个键，不复用一个键（规范既有原则）。
4. **先止血再清创**：先加护栏禁止增量，再分批归并存量，避免「一边清一边新增」。
5. **行为不变**：纯视觉重构，不改任何菜单项 / 按钮的标签、快捷键、action 与无障碍语义。

## 三、分期实施

### P0 — 护栏（防增量，最高优先，改动最小）

新增测试 `frontend/test/core/icon-guard.test.mjs` 并登记进 `frontend/package.json` 的 `npm test` 清单，扫描 `frontend/src` 源码：

- **禁止新增内联 `<svg` 字面量**：对允许的例外目录 / 文件（第二节第 2 条 + 存量白名单）放行；白名单必须是**显式文件清单 + 行级基线**，且只减不增（仿 `form-controls-factory.test.mjs` 的基线思路）。
- **禁止新增遗留码位**：菜单数据里不得出现 `icon: 'E####'` / `iconSvg('E####')`；存量同样进只减不增的白名单。
- **`iconHtml` 必须带例外注释**：扫描 `iconHtml:` 使用点，要求同一行或上一行有 `// iconHtml-exception:` 开头的原因说明，否则红。
- **注册表自身规范**：遍历 `ICONS` 的键，断言路径不含硬编码颜色（品牌金等已登记的例外除外）；新键遵循 `0 0 16 16` 由 `iconSvg` 统一包壳，无需逐键校验 viewBox。

P0 完成后，任何新增散落都会让 `npm test` 变红——规范从「靠自觉」变成「靠机制」。

### P1 — 高频语义归并（治存量主体，收益最大）

先把重复最多、注册表已有或极易补的语义补进 `core/icons.js`，再批量替换：

| 语义 | 目标键（注册表现状） | 主要替换点 |
|---|---|---|
| 折叠 / 展开箭头 | `chevron-down` / `chevron-right`（已有） | `ai-panel.js:4619,4755,5175,13570`、`ai-tool-cards.js:930,1647`、`ai-todos.js:147`、`bridge-memo-view.js:699`、`titlebar-popovers.js:22`、`explorer.js:2`、`structure.js:15`、`ai-session-list.js:491,604` |
| 刷新 / 更新 | `refresh`（已有） | `explorer.js:8`、`structure.js:16`、`titlebar-popovers.js:16`、`message-center.js:31` |
| 文件夹 | `folder`（已有，需先统一造型） | `explorer.js:3`、`git-graph.js:20`、`titlebar-popovers.js:13` |
| 铃铛 / 提醒 | `bell`（已有） | `ai-reminders.js:155`、`message-center.js:32` |
| 勾 | `check`（已有） | `ai-ask-cards.js:245`、`titlebar-popovers.js:21`、`message-center.js:29` |
| 叉号 / 关闭 | `close`（已有） | `ai-model-settings.js:445`、`message-center.js:30` |
| 锁 | `lock`（已有） | `main.js:111,112`（与 `editor-export-menus.js:204,209` 的 `iconSvg('lock')` 对齐） |
| 播放 / 暂停 | `play` / `pause`（已有） | `ai-ask-cards.js:10,11` |
| 数据库 | 新增 `database` | `ai-usage-ui.js:185`、`ai-panel.js:5493` |
| 问号 | 新增 `question` | `ai-ask-cards.js:7`、`ai-tool-cards.js:513` |
| 眼睛 / 显示 | `eye`（已有） | `ai-todos.js:163` 等 |
| 结构化目录 | 新增 `structured-dir` | `explorer-ops.js:740`、`structure-panel.js:132` |

**先行样例**：本次会话已把 AI 消息右键菜单（`ai-panel.js:14191-14221`）的 4 个 `E8C8` 改为命名图标——复制类用 `copy`、引用类用新增的 `quote`、全选补 `select-all`，并在 `ai-quote.test.mjs` 加了断言。这是 P1 的一个小样板，可推广。

每批替换后跑 `npm test` 与手动目视核对菜单 / 按钮外观（暗色 + 亮色主题）。

### P2 — 存量清零（长尾）

处理剩余散落与两个后门：

- 拆掉 `ai/ai-panel.js:5485` 的影子工厂：10 个图标逐个映射到注册表（缺的补键），删除本地 `icon()` / `icons`。
- 收编 `editor/editor-groups.js:490-507` 的 `VIEW_ICONS`（13 个视图模式 + more + plugin）：这批用 14×14 网格，需按规范重画成 16×16 后登记（如 `view-tree` / `view-table` / `view-sql`…），或作为一个「视图模式图标」子表纳入注册表管理。
- 收编 `shell/titlebar-popovers.js:12-23` 的 `POP_ICONS`、`explorer/explorer.js:1-10` 的 `ICONS`、`editor/structure.js:15-18` 的 `ICONS` 等局部表。
- 消除 `iconHtml` 后门：`main.js:3597` 的 `AI_REFERENCE_ICON_HTML` 改为注册表键（新增 `ai-reference` 或复用 `sparkles`），`explorer-ops.js:740` 改为 `iconSvg('structured-dir')`；确实无法收编的保留并写 `// iconHtml-exception:` 注释。
- 遗留码位存量清零：全仓 `E####` 菜单数据批量改为命名图标（映射表已在 `core/icons.js` 的 `LEGACY_ICONS`），清零后可考虑删除该兼容层。

### P3 — 文档收口

- 更新 `docs/icon-guidelines.md`：补充「禁止影子注册表 / 局部图标表」「iconHtml 例外需注释」「护栏测试位置」三条。
- 更新 `AGENTS.md` 前端侧约定：新增图标必须过 `icon-guard.test.mjs`。
- 用户可见变化（若有）同步 `CHANGELOG.md`——本方案纯内部重构，预计无需。

## 四、验证方式

- **每批必跑**：`cd frontend && npm test`（护栏测试 + 全量前端单测），看退出码本身，不接 grep/tail 管道。
- **护栏自检**：P0 后故意在某业务文件加一处内联 `<svg>` 或 `icon: 'E8C8'`，确认 `icon-guard.test.mjs` 变红，再撤销——证明护栏真的生效。
- **白名单单调性**：确认 P1/P2 每批替换后，护栏白名单文件里的条目数只减不增。
- **视觉回归**：暗色 / 亮色主题下目视核对被改菜单与按钮，确认 currentColor 着色正常、尺寸未变、无空白图标。
- **构建**：`wails build` 或 `tools/rebuild-exe.ps1` 通过（前端改动需重新构建才在窗口生效）。

## 五、风险与回滚

- **风险 1：造型微调引发视觉回归。** 归并时注册表键与散落版造型可能不完全一致（如 folder 有三种画法）。缓解：归并前先定「标准造型」，必要时为差异明显的语义登记新键而非硬套。
- **风险 2：14×14 → 16×16 重画走样。** `VIEW_ICONS` 那批需逐个重画，不能简单改 viewBox 数字。缓解：P2 单独一批，逐个目视核对。
- **风险 3：护栏误伤合理内联 SVG。** 缓解：例外目录 + 显式白名单，且白名单只减不增；误伤时优先修正白名单边界，不放宽扫描规则。
- **回滚**：每批一个 commit（conventional commits + 中文描述），可单独 revert；护栏测试独立成文件，回滚不影响业务代码。

## 六、工作量预估

| 阶段 | 文件数 | 性质 | 建议 |
|---|---|---|---|
| P0 护栏 | 2（新增测试 + package.json） | 低风险，可独立交付 | 优先做 |
| P1 高频归并 | 约 15 | 中风险，纯替换 | 按语义分批 commit |
| P2 存量清零 | 约 10（含 ai-panel 大文件） | 中高风险，含重画 | 单独批次，重点目视核对 |
| P3 文档 | 2–3 | 低风险 | 收尾 |

总量约 20+ 文件，建议 P0 先落地止血，P1/P2 按批次推进，每批可独立回滚。

## 七、实施记录（2026-11-22）

> 施工前按用户要求做了全量重评，行号与存量已漂移，以下为修订口径与实际落地结果。

**重评修正（相对原方案的差异）**

- 行号全部漂移（如 `AI_REFERENCE_ICON_HTML` 3597→3968、影子工厂 5485→5585、VIEW_ICONS 490→524），语义未变。
- 原方案漏了 `ai/ai-monitor-view.js` 的 `iconSvgOf` 影子工厂（close/new-window/refresh，自述「不引 core/icons 全表」）——已一并拆除。
- 原方案笔误：`AI_REFERENCE_ICON_HTML`（四角星花）与 `structure-panel.js` 并非同一图形；真正的重复对是 `structure-panel.js:132` ↔ `explorer-ops.js:746`（同为 20 网格缩进目录线），收编为 `structured-dir` 键。
- 遗留码位存量实测 **162 处 / 11 文件**（原方案估「几十处」），逐码核对全部在 `LEGACY_ICONS` 映射内，机械替换安全，已清零。
- 扫描误报处置：护栏用 `['"`]<svg` 启发式放行正则字面量与报错文案；`dev/mock-backend.js`（mock 数据）、`shell/plugins.js`（插件字符串检查）文件级豁免；`git-graph.js` 泳道画布留 1 行基线（图表产物，同 layout-render 性质）。
- `AI_CHEVRON_SVG` 是经 ctx 共享给 4 个兄弟模块的常量，只需改 ai-panel 定义点，13 处消费一次性收敛。

**注册表新键（27 个）**：`chevron-left` `question` `circle-check` `circle-x` `database` `structured-dir` `unlock` `rewind` `bringback` `deliver` `tag` `collapse-all` `expand-all` `locate` `checklist` `env` `plan` `more-vertical`（18）+ `view-*` 族（tree/table/binary/video/audio/render/patch/split/panel，9）+ `tree`（复审补登记，见下）。
节省项：`view-sql`→`database`、`view-code`→`code`、`view-text`→`doc`、view-preview/view-image→`image`（原两键逐字符相同）、POP_ICONS `commit`→`check`、`push`→`upload`（注册表注释本就声明 upload 覆盖「上传/推送」）。

**造型裁量（按风险 1 的缓解措施「差异明显就登记新键」）**

- 消息中心成功/失败与分支弹层当前分支是**圆圈徽标**造型，直接套裸 `check`/`close` 会丢圆圈——登记 `circle-check` / `circle-x` 两个键，视觉零回归。
- main.js 的 UNLOCK/LOCK 是解锁/锁定成对语义，都套 `lock` 会丢解锁态——登记 `unlock` 键。
- ai-panel 影子工厂映射：`edit`→`rename`（同为笔造型）、`regenerate`/`retry`→`refresh`（同为循环箭头）、`branch`→`git`、`sidechat`→`sidechat`（去掉装饰点）；`rewind`/`bringback`/`deliver` 为独有语义，登记新键。

**尺寸护栏事实**：SVG 无 width/height 属性时按 100% 默认撑满容器——收编时逐一核对了消费容器 CSS，4 个无 `svg` 规则的容器（`.ai-ask-icon`/`.ai-plan-takeover-icon`/`.app-toast-icon`/`.ai-session-*-chev`）显式传尺寸保持撑满，其余靠 CSS 规则覆盖。AI 引用菜单的 iconHtml 后门改 `icon: 'sparkles'`（renderMenuIcon 命名图标通道）。

**验证**：护栏注入自检红→撤销回绿；全量 `npm test` 2066/2066（两处钉旧实现形态的断言 `video: '<svg` / `audio: '<svg` 同步更新为注册表键形态）；`vite build` 通过。收编后基线仅剩 git-graph 泳道画布 1 处，码位与 iconHtml 基线为空表。`LEGACY_ICONS` 保留（外部插件菜单数据兼容），注释已说明。

## 八、复审修正（2026-11-22，双子代理只读复审后）

复审发现 4 个护栏盲区问题，全部已修：

1. **[P1] explorer `iconSvg('tree')` 键未登记**——树视图按钮静默渲染为空（iconSvg 未知键返回空串，npm test 全绿也看不见）。补登记 `tree` 键（按 HEAD 原造型收编），护栏新增**规则⑤「字面量键引用必须已注册」**（`iconSvg('x')` / `icon: 'x'` 的键名要在 ICONS 中，ECharts 内置名走放行名单）把这类错误固化成红灯。
2. **[P1] 4 处三元式遗留码位漏迁**——`icon: cond ? 'E70D' : 'E70E'`（bridge-memo-view ×3）与 `icon: entry.isDir ? 'E8B7' : undefined`（app-actions）不紧跟冒号，原正则看不见；已迁为 `chevron-down`/`chevron-up`/`folder`，LEGACY_CODE_RE 收紧为「任何带引号的 E 码字面量」。
3. **[P1] `collapse-all`/`expand-all` 原四角斜线正反画渲染像素级一致**（这是被收编的存量缺陷，两态本就不可区分）——重画为「上下箭头指向/背离中线」的折叠造型。
4. **[P2] `rewind` 弧底描边溢出 16 网格被裁约 0.5px**——弧半径 4→3.7 收进网格；`unlock` 锁梁弧弦长超直径触发 SVG 自动放大半径——2.4→2.5 归一。

护栏自检随之加强：INLINE_SVG_RE 补 `'<svg'` 拼接首段形态；扫描器自测覆盖三元式/点赋值/case 标签。复审确认无问题的面：尺寸保真（全部抽查点有 CSS 规则或显式尺寸）、映射语义（无打架）、import 健康（24 文件恰好一次且被使用）、162 处码位迁移与 CHANGELOG 数字精确一致、基线三表与快照一致。

> **事故记录(2026-11-21 18:35)**:复审修复过程中的护栏自检,误用 `git checkout -- explorer.js`
> 撤销注入,把该文件上**并行会话未提交的 scratch 树节点改动层一并丢弃**(icon-consolidation 自身
> 的编辑层已逐字重放恢复;并行改动层发生在 16:21 快照之后,wipeguard L3/L1 均未覆盖)。
> 处置:icon 层已恢复、全量测试绿;scratch 树节点接线(explorer.js 的 scratchNode /
> LIST_SKIP_DIRS 树侧过滤)待并行会话按其上下文重放,恢复依据见 `finished-plans/scratch-file.md` §8。
> 教训:撤销自检注入一律用精确反向 Edit,不许对有未提交多方改动的文件动 git checkout。
>
> **事故根因补记(2026-11-21 18:50)**:并行改动层无备份的原因查清——wipeguard 三层各自盲区叠加:
> ① L1 写前快照挂在应用自身 AI 工具写路径(`write_file`/`edit_file`/patch),并行会话是外部
> ZCode 会话,写文件不经 datalens 进程,L1 天然看不见(index.jsonl 仅有的 28 条全是历史 patch 备份);
> ② L3 定期快照一直在跑(16:40→18:41 每 10 分钟 13 次),但每次都死于 `git add -A` exit 128:
> 并行会话在 16:21–16:40 间意外创建了 `frontend/nul`(Windows 保留设备名,1047 字节,应为
> Git Bash 下 `> nul` 重定向落地成真文件),git 枚举可见、Win32 打不开 → 整张快照放弃,最后一张
> 成功快照停在 16:21:39,并行改动恰在其后;③ L2 只告警不备份数据。
> 处置:`nul` 文件已用 `DeleteFileW` + `\?\` NT 路径删除(.NET/常规 API 全被设备名守卫挡住,
> 其 1047 字节内容因同一路由未能读出);删除后 `git add -A` 恢复正常(临时索引验证 exit 0),
> L3 自下个周期起恢复出快照。此文件同时会卡用户后续任何 `git add -A` / `commit -a`。
> 硬化建议(另行立项):L3 对单个不可索引文件应「跳过+警告」而非整张失败;快照连续失败应升级为
> 用户可见告警(目前仅 debug-console warn)。
