# 四项功能评估（2026-11-18）

> 状态：**已归档（2026-11-21）**：四项评估全部有归属——1/3/4 已实施留档，§2 临时文件抽离为独立方案 `docs/finished-plans/scratch-file.md`（2026-11-21 实施完成）。本稿作为历史评估留档，不再承载待办。
>
> 性质：只读评估，未改动任何代码。行号按 2026-11-18 工作区实测。

## 0. 结论摘要

| # | 功能 | 可行性 | 改动面 | 建议优先级 | 估计工作量 |
|---|------|--------|--------|-----------|-----------|
| 1 | 右键菜单定制（先接「新建」菜单） | 高，机制清晰，成本在条目 id 化 | 纯前端 | 中（价值取决于自用频率） | 0.5–1 天 |
| 2 | 临时文件 | 高，UI 占位已就绪；二次复核后补三项（静默落盘 / 独立目录 / 保存容错） | 前端 + 6 行 Go | **高（成本最低）** | 0.5–0.7 天 |
| 3 | 群聊智能体分组 | 高，一个字段 + 三处 UI | 纯前端 | 高 | 0.5–1 天 |
| 4 | AI search 增强 | 高，但受「rg 不打包」约束，新能力须双路径实现 | 前端 + Go | 中高（对 AI 日常增益最大） | 一期 1 天，二期 0.5–1 天 |

依赖关系：四项互相独立，可任意组合。2 和 3 都是一天内的小活，适合一批做掉。

> **同日后续**：1（右键「新建」菜单定制）已实施（方案与改动清单见 `docs/finished-plans/new-file-menu-customization.md`），§1 仅作原始评估留档；3（智能体分组）已实施（commit `db28961`，agents[].group 必有值 + 两处 UI + AI 代建 group 参数），§3 仅作原始评估留档；§2 已按实测二次复核重写（见 2.0）；4（AI search 增强）一期 + 二期已实施（方案与改动清单见 `docs/finished-plans/ai-search-enhancement.md`），§4 仅作原始评估留档。

---

## 1. 右键菜单定制（先接入「新建」菜单）

> **已完成（2026-11-18）**：本节为原始评估；实施结果见 `docs/finished-plans/new-file-menu-customization.md`。

### 1.1 需求解读

以 explorer 右键的「新建」子菜单为第一个接入点：条目可选是否出现、可排序、可新增（自定义条目）。机制上应为后续接入 explorer 主菜单、编辑器右键菜单留好扩展位，但一期只做「新建」菜单。

### 1.2 现状（代码事实）

- 菜单运行时是数据驱动的通用渲染器：`frontend/src/shell/contextmenu.js` 的 `createContextMenu().open(items, x, y)`，条目形状 `{label, icon/iconHtml, shortcut, disabled, danger, description, badge, submenu, action, sep, checked}`（`contextmenu.js:133-190`）。纯展示层——**条目没有稳定 id**，全靠调用方现场组装。
- 「新建」子菜单在 `explorer-ops.js:393-402` `newFileMenuItems(dirPath)`：文件… / 临时文件（灰占位，见 §2）/ 目录… / 分隔线 / `deps.newFileTypeMenuItems(...)`。
- 文件类型表在 `main.js:1863`：`NEW_FILE_TYPES`（10 项一级）+ `NEW_FILE_TYPES_MORE`（15 项收进「更多」二级），`newFileTypeMenuItems(action)`（`main.js:1907`）按固定顺序展开。
- 其余菜单同样硬编码组装：explorer 主菜单 `showExplorerMenu`（`explorer-ops.js:633-721`）、编辑器右键 `showEditorMenu`（`editor-menus.js:173-239`）、空白处 `showBlankMenu`；md 预览 / SVG / 图片另有专用菜单。很多条目是**上下文相关**的（选中数量、git 状态、阅读模式可用性、AI 引用入口），这些条目不适合进定制。
- 设置持久化通道现成：`settings` 对象在 `applySettings` 尾部落 localStorage（`settings-ui.js:631`），已有同构先例 `settings.keyStyle`（三风格键位表）。

### 1.3 方案建议

**核心动作：给「新建」菜单的条目建立 id 化注册表，配置进 settings，渲染时按配置合成。**

1. 条目 id 化。内置条目给定 id：`file.dialog`（文件…）、`scratch`（临时文件）、`dir.dialog`（目录…）、`type.md` / `type.py` / …（文件类型）、`more`（更多二级）。`newFileTypeMenuItems` 与 `newFileMenuItems` 改为「按 id 生成条目」，注册表保留每项的固定元数据（label、icon、扩展名、danger/disabled 判定函数）。
2. 配置形状（进 settings，随现有 localStorage 通道持久化）：

   ```js
   settings.newFileMenu = {
       order: ['file.dialog', 'scratch', 'dir.dialog', 'type.md', ...],  // 展示顺序
       hidden: ['type.java'],                                            // 不出现的内置 id
       custom: [{ id: 'c1', label: 'Vue 组件', ext: '.vue', content: '<template>...' }], // 自定义模板
   };
   ```

   缺省（无配置 / 字段缺省）= 当前内置顺序与全集，向后兼容零迁移。
3. 「新增」的语义落在新建菜单上就是**自定义文件类型模板**：名字 + 扩展名 + 初始内容。创建走既有链路：`openCreateEntryDialog` 改为带初始内容时直接 `CreateEntry`（`internal/fsops/fsops.go:247`，O_EXCL 空文件）+ `SaveFile` 写模板 + `openPath`，并沿用新建历史（可撤销）。v1 不做模板变量（{date} 之类），要加也是纯函数一行的事。
4. 管理 UI：设置 → 通用（或文件树节）加「新建菜单」小节——列表行 = 显隐开关（`createSwitch`）+ 上移/下移按钮；自定义模板走「添加」弹窗。**不建议做拖拽排序**（成本高、无障碍差），上移/下移足够。另一个入口：右键「新建」子菜单底部加「配置菜单…」直达该设置节（低成本，发现性好）。
5. 范围控制（一期刻意不做）：explorer 主菜单与编辑器右键的上下文条目（Git 差异、AI 引用、比较两文件等）保持硬编码；id 化机制与设置 pane 留出后续扩展位即可。

### 1.4 改动面

- `main.js`：`NEW_FILE_TYPES` 两张表加 id + 默认顺序常量；`newFileTypeMenuItems` 按配置合成（配置读取与归一化抽纯函数）。
- `explorer-ops.js`：`newFileMenuItems` 接配置合成 + 「配置菜单…」入口。
- `settings-ui.js`：settings 默认值与归一化（损坏配置回退默认，不 throw）。
- 设置 pane UI（新代码量最大的一块）。
- 测试：顺序合成 / 配置归一化 / 模板渲染纯函数进 `frontend/test/`（镜像目录）并登记 `npm test` 清单；管理 UI 控件全走 `core/form-controls.js`（表单硬规范，基线只许调小）。

### 1.5 风险与护栏

- **只影响「出现与顺序」，不动语义**：`readOnlyMode` 下「新建」入口的 disabled 判定（`explorer-ops.js:645`）必须保留在合成层，不能被配置绕过。
- 自定义模板内容会写进 settings（localStorage）——模板内容设个长度上限（如 4 KB）防 settings 膨胀。
- 归一化对未知 id（配置残留已删除的自定义项）直接丢弃，不报错。

## 1.6 工作量：0.5–1 天，纯前端，风险低。

---

## 2. 临时文件

> **已抽离为独立方案**：完整内容（复核结论 / 需求解读 / 方案建议 / 改动面 / 风险护栏 / 工作量 / 语言高亮）见 `docs/finished-plans/scratch-file.md`。本节原为 2026-11-18 二次复核版（原稿「落盘草稿」方向正确，三处修正：目录 `.cadt/tmp` → `.cadt/scratch`、补静默落盘与保存容错，工作量 0.5 → 0.5–0.7 天）。

---

## 3. 群聊智能体分组（强制分组）

### 3.1 需求解读

智能体按用途强制分组（如「写作」「编码」），不选分组归「默认」组。动因：智能体多起来后（上限 32 个，`ai-agent-model.js:10`），平铺列表找不到人；写作任务下会建一批写作相关智能体，希望聚在一起。

### 3.2 现状（代码事实）

- 智能体真源：`ai-config.json` 的 `agents[]`（`main.js:613` 注释；`ai-agent-settings.js:1-4` 头注）。字段归一在 `normalizeAgent`（`ai-agent-model.js:53-79`）：id / name / color / role / modelRef / personaText / replyStyle / temperature / slowTier / chair / enabled / createdAt / updatedAt——**无 group 字段**。
- 管理 UI：设置 → AI → 智能体（`ai-agent-settings.js`），`renderAgentsPane` 平铺卡片列表（:67-125）+ 编辑器居中弹窗（:134-240，表单全走 form-controls 工厂）。
- 新建群聊弹窗：`ai-group-sidebar.js:162` `openCreateDialog`，成员是平铺开关列表（`gc-member-list`，:196-227），逐成员预检徽标，主持人下拉来自 `chair` 标记。
- AI 代建：app_control `get_agents` / `create_agent`（`ai-agent-model.js:194-238`），创建走 `agentsUpsert` 纯函数。
- 群聊按 agentId 引用成员（meta.json memberIds），不按组；群聊方案 `docs/finished-plans/ai-group-chat.md` §6.1 的 schema 未提分组，G5 增强也未含此项。

### 3.3 方案建议

**核心判断：分组不该是独立存储实体，就是 agents[] 上的一个必有值字段。** 「强制分组」的实现即「归一化时字段必有值，空 → 『默认』」——分组列表 = `agents[].group` 的去重集合，天然满足「不选就归默认」，且不产生第三份真源（不进 SQLite、不建单独文件），与现有「agents[] 即真源、就地改 + saveAIConfig」模式（`ai-agent-settings.js:275-286`）完全一致。

1. 数据层（`ai-agent-model.js`）：
   - `normalizeAgent` 加 `group: clampText(source.group, 16) || '默认'`（去空白，NFC）；
   - 加纯函数 `agentGroups(agents)`（保序去重，'默认' 恒在）与 `agentsByGroup(agents)`（分区聚合，供两处 UI 共用）；
   - 旧配置零迁移：归一化时无 group 自动落「默认」。
   - 防膨胀：组数上限（如 12），超出在 `agentsUpsert` 报错；组名走 `agentNameError` 同款校验（禁空白两端、限长）。
2. 管理 UI（`ai-agent-settings.js`）：
   - 编辑器弹窗加「分组」行：`createSelect`，选项 = 现有组 + 「＋新建分组…」（选中弹出命名输入框，非 select 的 optgroup——行式下拉增强不支持嵌套）。缺省「默认」。
   - `renderAgentsPane` 按 `agentsByGroup` 分区渲染：组头（组名 + 计数）+ 组内卡片；空组不显示（组随最后一个成员删除而消失，无需显式删组）。组内排序沿用现有顺序。
   - 重命名组 = 就地改所有成员的 group 字段；删组 = 成员落回「默认」。都是字段操作，无 API。
3. 新建群聊弹窗（`ai-group-sidebar.js:196-227`）：成员列表按组分区渲染（组头行 + 组内开关行），`memberSwitches` / `collectCreateDraft` 数据结构不动（仍按 agentId 收集）。组多（>4）时在成员区顶部加「分组过滤」下拉（全部 / 某组），过滤是纯展示。
4. AI 代建：`create_agent` 参数加可选 `group`（描述写明「缺省归默认分组」），`get_agents` 返回带 group；`resolveModelByKeyword` 等不动。
5. 不受影响：预检（按 agentId）、主持人机制（chair 标记跨组有效——主持人可以在任何组，不强制归组）、群 meta 存储。

### 3.4 改动面

- `ai-agent-model.js`（数据层 + 纯函数）、`ai-agent-settings.js`（列表分区 + 编辑器行）、`ai-group-sidebar.js`（成员分区 + 过滤）、`ai-panel.js` 的 `create_agent` 分支（透传 group）。
- `frontend/wailsjs/`：无 Go 改动则不需要重新生成（group 是 ai-config.json 内部字段，不走 Wails 绑定）。
- 测试：`ai-agent-model` 纯函数用例（归一化落默认 / 组聚合保序 / 组数上限 / AI 代建 group 透传）；登记 `npm test`。

### 3.5 风险与护栏

- 低。注意两点：组名「默认」本身是保留组名（用户不能新建一个叫「默认」的第二组——去重集合天然保证，但 UI 要禁住）；`@点名` / 保留名机制（`AGENT_RESERVED_NAMES`）不受影响，组名与成员名是两个命名空间。

## 3.6 工作量：0.5–1 天，纯前端，风险低。

---

## 4. AI search 增强

> **已完成（2026-11-18，一期 + 二期全做）**：本节为原始评估；实施结果见 `docs/finished-plans/ai-search-enhancement.md`。

### 4.1 需求解读

给 AI 的 `search_text` 受限：只支持字面量子串，而 AI 自己写 grep（run_command）表达力强得多。评估封装工具能否更丰富，而不是逼 AI 绕 shell。

### 4.2 现状（代码事实）

- 工具面：`search_text`（`ai-tool-defs.js:59-72`）参数仅 query / path / caseSensitive / filePattern，默认 200 条；描述里明确调度原则「有专用工具就不要用 run_command 绕：…搜索…用 search_text」（`ai-tool-defs.js:1172`）。
- 执行：`ai-panel.js:8611-8661`，走 `resolveScanRoot` 读根授权链（这是它比 run_command 安全的根本原因：不弹审批卡也能受控出工作区，`ai-read-roots.js`）。
- Go 引擎双路径（`internal/search/`）：
  - 系统 rg 路径：`exec.LookPath("rg")`（`search_rg.go:222`）——**rg 不打包**（体积红线），用户装了才有；参数 `-F`（**固定串，无正则**）+ `-i` + `--glob` + 两趟产物档降权（`search_rg.go:24-66`）。
  - 内置 Go 扫描兜底（`search.go:285-383`）：字面子串匹配，同样无正则；fzf 式模糊（`SearchWorkspaceFuzzy`）只给 UI 全局搜索用，AI 面不走。
  - 共同限额：预算 3.5s、单文件 30 命中、单文件 4 MB、结果 ≤1000（`search.go:22-30`）。
- 结果输出：`相对路径:行号: 预览` 纯文本（`ai-panel.js:8647-8660`）。

### 4.3 用户判断的评估

**部分成立，且根因明确：受限的不是架构而是匹配表达力（字面量 only）与输出形态（纯行命中）。** 「AI 自己写 grep 更强」的另一面是：run_command 要审批、引号/编码转义易错、还有权限旁路风险——调度原则（1172 行）的方向是对的，正路是**把 grep 最常用的那部分表达力搬进 search_text 参数**，而不是放开 shell。约束只有一条是硬的：**rg 不打包 → 新能力必须 rg 路径与内置扫描路径同时实现**，否则「装没装 rg」行为分裂（内置路径现在是纯手写字面量循环，加正则要用 Go `regexp`，RE2 线性时间，无回溯风险）。

### 4.4 方案建议（按性价比排序）

| 参数 | rg 实现 | 内置扫描实现 | 价值 | 建议 |
|------|---------|-------------|------|------|
| `regex: true` | 去掉 `-F`，pattern 直传（`-e`） | Go `regexp` 逐行匹配 | **最大**（`\w+\(` 、`foo|bar` 、锚点） | 一期 |
| `wholeWord: true` | `-w` | `regexp` `\b` 包裹 | 中高 | 一期 |
| `excludePattern` | `--glob !pattern` | walk 时 `globMatchPath` 取反（`:464` 旁） | 中高（「除 tests 外」） | 一期 |
| `outputMode: 'files'/'count'` | rg 原生 | 聚合 hits | 高（大结果先拿文件清单再 read_file，省大量 token） | 二期 |
| `context: N`（≤3） | `-C` | `scanSearchFile` 加前后行缓冲 | 中（token 成本放大，必须限 N） | 二期 |
| maxResults 参数化（100–1000） | 透传 | 透传 | 中 | 一期顺带 |

明确不做：多行正则（rg `-U` + 内置跨行扫描，复杂度/收益比差）；把 rg 任意 flags 透传给模型（失控面）；用 run_command 跑 rg 作为常规路径（与调度原则冲突）。

### 4.5 改动面（按 AGENTS.md「AI 工具增删改」清单核对）

- Go：`internal/search` 的 `searchWorkspace` / `rgGlobalArgs` / `scanSearchFile` 加参数（建议聚成一个 options struct，避免第八个位置参数）；`*_test.go` **两条路径同断言**（可用 `DATALENS_NO_RG=1` 强制内置路径对拍，环境变量钩子已存在，`search.go:423`）。
- `app_fs.go` / 绑定层：`SearchWorkspace` / `SearchWorkspaceFiltered` 签名变化或新增 `SearchWorkspaceAdvanced`（旧签名保留兼容 UI 全局搜索——它也调这两个绑定，`global-search.js` 走 fuzzy 路径不受影响）；`frontend/wailsjs/` 重新生成。
- `ai-tool-defs.js`：参数 properties + 描述（何时用正则、何时字面量、outputMode 的 token 语义）；`AI_TOOL_CATALOG` blurb 若变同步测试断言。
- `ai-panel.js` executeTool 分支透传。
- **`dev/mock-backend.js` 补同名 mock**（漏了 dev 模式调用即崩——工具改动清单明确项）。
- 守卫：`ai-tool-wiring.test.mjs` 会核对「描述提到的参数名 ↔ properties ↔ 分支读取」，新增参数三处对齐；调度原则段（`ai-tool-defs.js:1172-1184`）检查分工句是否要补「正则用 regex:true」。
- 测试：Go 表驱动 + 前端纯函数（参数归一化、files/count 聚合格式化）。

### 4.6 风险与护栏

- 中低。主要风险是两条路径行为漂移——护栏就是双路径对拍测试进 CI；正则来源是模型输入，Go `regexp`（RE2）天然线性时间，无灾难性回溯，比直接放 shell 安全得多。
- token 预算：context 与 maxResults 放开都会放大结果体积，输出端保留现有 200 条截断 + 截断提示逻辑（`ai-panel.js:8638-8656`）作为最后一道闸。

## 4.7 工作量：一期（regex + wholeWord + excludePattern + maxResults）1 天；二期（outputMode + context）0.5–1 天。

---

## 5. 综合建议

1. **2（临时文件）已实施**：独立方案见 `docs/finished-plans/scratch-file.md`（2026-11-21 落地，含实施记录 §8）。
2. ~~**再做 4 一期**~~：**4 已一期 + 二期全做**（2026-11-18，见 `docs/finished-plans/ai-search-enhancement.md`）；对 AI 日常使用增益最大，Go 侧改动可控（环境变量对拍钩子现成）。
3. **1 最后**：价值最主观（取决于自用频率），且管理 UI 成本最高；机制不影响其他三项，随时可插入。
4. 立项后按本仓惯例各自另立方案文档（从本稿对应章节拷贝事实底座），实施完成移 `docs/finished-plans/`。
