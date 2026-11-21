# AI 面板「始终折叠」模式（默认关闭）

> 状态：**已实施**（2026-11-18 规划；2026-11-19 落地：默认关的 `aiAlwaysCollapse` 设置开关 + 面板「显示方式」菜单项，判定收敛为纯函数 `ai/ai-always-collapse.js` 并配测试）。
> 前置必读：`docs/finished-plans/turn-fold-redesign.md`——同域两次过渡尝试已回滚（整轮外壳吞用户消息、已答提问卡紧凑态），本方案不重走老路。

## 需求

现状是回合进行中把思考链、工具调用卡实时铺开，回合结束后才折叠。需要一个**始终折叠**模式（默认关闭）：过程区（思考链、工具卡、中间回复）从流式开始就不展开，给用户直接显示最终结果；想看过程时点折叠头展开即可。

## 现状（代码事实）

折叠全部是 DOM class（`collapsed`）+ 内存 Map/Set 记忆，不进消息对象、不持久化：

| 体系 | 默认值判定位置 | 现状行为 |
|---|---|---|
| 轮级过程折叠条 `.ai-process` | `ai-panel.js:4146-4149`（`renderTurn`） | **进行中默认展开**（`turnRunning` → true），结束后有最终回答则默认收起（`!finalHasBody` 取反） |
| 消息级工具卡 `.ai-tool-card` | `ai-tool-cards.js:1128-1149`（`renderToolMessage`） | write/edit/command 恒折叠；其余完成后折叠；`toolFoldState` 手动记忆覆盖 |
| 思考块 `.ai-think`（过程区） | `ai-panel.js:4027-4050`（`renderProcessThinking`） | 默认**展开**，仅 `thinkFoldState` 手动记忆可折叠 |
| 思考块 `.ai-think`（最终回答气泡内） | `ai-tool-cards.js:1443-1483` | 流式时展开、非流式收起（`settings.aiShowThinking !== false` 才渲染） |
| 流式实时工具行 `.ai-live-tools` | `ai-tool-cards.js:1542-1565` | 流式 assistant 气泡内一行摘要（spinner + 动词 + 参数摘要） |

进度反馈现有三件套：底部流式状态条 `.ai-streaming-bar`（阶段文案 + 走秒，`ai-panel.js:3701-3731`）、轮级折叠头状态文本（`processFoldLabel`，`ai-panel.js:3810`）、live 工具行。

**天然不受消息流折叠影响的交互**（实施时不得破坏）：
- pending 审批 / AI 提问 / 计划批准：在 composer 接管区 `#ai-takeover`，与消息流折叠解耦；`ai-tool-cards.js:1128` pending 审批卡提前 return 不套折叠。
- 已答提问卡：整卡常显、不参与任何折叠（`ai-panel.js:4124-4126` 注释明确「收起来就等于没问过」）。
- 最终回答与改动汇总卡：渲染在折叠体**外**，永远可见——失败轮的错误正文就是最终回答，可见性天然保住。
- 生成卡进行中（`ai-tool-cards.js:1141-1144`）展开。

## 行为定义

「始终折叠」= 一句话：**把 `renderTurn` 的默认折叠值统一改为「收起」（不再区分 `turnRunning`），并把两处思考块的流式默认展开同步改为收起。**

| 场景 | 默认模式（现状） | 始终折叠模式 |
|---|---|---|
| 流式中：轮级过程条 | 展开，实时看工具与思考 | **收起**，折叠头显示「处理中 · 用时」 |
| 流式中：思考块（过程区 / 回答气泡内） | 展开 | **收起** |
| 流式中：`.ai-live-tools` 实时行 | 显示 | 随折叠体隐藏（body `display:none`），不单独处理 |
| 结束后：有最终回答的轮 | 过程收起 | 收起（不变） |
| 结束后：无正文的纯工具轮 | 过程条展开 | **收起**，折叠头「已完成，用时 X」 |
| 失败 / 停止轮 | 过程收起 + 错误正文在体外 | 收起（不变），错误正文可见 |
| 用户点折叠头 / 卡头 | 手动展开 | 不受限；`processFoldTouched` / `toolFoldState` 语义照旧（轮次结束丢弃手动记忆回到默认收起，正是本模式的默认） |
| pending 审批 / 提问 / 计划批准 | 接管区交互 | 不变 |
| todo 卡 / 头部 chips / 底部状态条 | 不在消息流 | 不变 |

与现有开关的关系：`aiShowThinking`（显示思考链）是「渲染与否」，本开关是「渲染但默认收起」；`aiShowThinking=false` 时思考块根本不渲染，两开关正交。

## 关键决策

1. **只改默认值，不加新折叠层**。不做整轮外壳、不吞用户消息与提问卡、不做两级折叠——turn-fold-redesign.md 的两条回滚红线。折叠体仍只含过程（工具卡 / 中间回复 / 思考），结构不动。
2. **设置项走 main.js 的 `settings`（localStorage），不走 ai-config.json**。它是 UI 显示偏好，不是给模型的内容；先例照 `aiAutoCollapseEditor`（`main.js:1340/1520`）的「四处齐全」接线。命名 `aiAlwaysCollapse`，默认 `false`。
3. **入口两处**：① AI 设置对话框显示区（`aiShowThinking` 旁边）；② 面板头部「…」菜单 →「显示方式」二级菜单加 checked 项（`showMoreMenu`，`ai-panel.js:12354-12359` 现成模式）——不打扰不用的用户，想切的人不用进设置页。不加新 chip/pill，头部已经够挤。
4. **判定逻辑抽纯函数**。把 `ai-panel.js:4146-4149` 的默认值判定抽成 `turnProcessDefaultExpanded(turnRunning, finalHasBody, alwaysCollapse)`，`ai-tool-cards.js` 两处思考块判定抽成同类纯函数， settings 经 ctx getter 延迟求值（不拍快照）。纯函数进测试。
5. **进度反馈不新增组件**：底部状态条（阶段文案 + 走秒）+ 折叠头状态文本已够。**可选增强**（实施时视效果决定）：流式期间折叠头文本带当前工具动词摘要（复用 `liveToolSummary`，`ai-tool-cards.js:50`），如「处理中 · 正在编辑 config.json」——纯文本更新，符合零 DOM 写约束；若加，遵守 turn-fold-redesign §4.4 不重建容器。
6. **中间回复的流式文本**：始终折叠模式下，过程中的 assistant 短语（如有）随折叠体隐藏；用户看到的流式动态只有底部状态条与折叠头。若实测「完全黑盒感」不可接受，退一步的兜底是只折叠工具卡与思考、保留中间回复——先按全折叠实施，冒烟后定。

## 改动清单

**前端**（无 Go 改动）：
- `main.js`：`defaultSettings` 加 `aiAlwaysCollapse: false` + 存量归一（参照 `aiAutoCollapseEditor` 四处）。
- `frontend/index.html`：AI 设置页显示区加开关 `id="ai-opt-always-collapse"`（用 `createSwitch` 规范或静态 class 结构）。
- `ai-settings-dialog.js`：回填 + change 写入（参照 `ai-settings-dialog.js:406/799-803` 先例）。
- `ai-panel.js`：opt 收集表登记；`renderTurn` 默认值判定换纯函数；`renderProcessThinking` 默认收起；「显示方式」菜单加项。
- `ai-tool-cards.js`：回答气泡内思考块流式默认收起（读 `settings.aiAlwaysCollapse`）。
- 纯函数放 `src/ai/` 或复用现有文件，测试镜像 `test/ai/`。

**测试**：
- 新增 `test/ai/ai-always-collapse.test.mjs`：判定表（turnRunning × finalHasBody × alwaysCollapse）+ 接线四处齐全护栏（照抄 `ai-auto-collapse.test.mjs:114-122` 模式）+ 菜单项存在性。**登记进 `frontend/package.json` 的 npm test 清单**。
- 回归关注：`ai-turn-fold.test.mjs`（R1–R4 结构护栏不得破坏）。

**文档**：CHANGELOG.md + README 对应小节。

## 实施注意 / 风险

- **R1 流式折叠下的 body 增量渲染**：现状流式默认展开所以折叠条 body 总是活的；改默认收起后，需确认折叠态 body 的懒建/签名增量在流式期间仍持续更新——用户流式中途点开折叠头必须看到**当前**内容，不能空白或停在旧签名（`data-render-sig` 机制）。这是本方案最大的实施风险点，动手前先验证 `ensureBody` 路径。
- **R2 滚动跟随**：折叠/展开大幅改变容器高度，遵守 turn-fold-redesign §4.3：贴底态补底、非贴底保锚点，`ai-scroll-follow` 判定不得误判。
- **R3 收尾瞬间**：轮次结束「丢弃手动记忆回到默认」现有逻辑在始终折叠模式下回到收起，无行为突变；但流式→结束的高度跳变要确认不触发 CSS 动画回弹（`planLiveRowOrder` 同类问题）。
- **R4 不碰的边界**：回合边界语义（`groupTurns` / `isTurnBoundaryMessage`）、已答提问卡整卡常显、pending 接管区——一律不动。

## 手动冒烟清单（实施后）

1. 开启开关 → 新回合：全程只见折叠头（「处理中」走状态）+ 底部状态条 + 最终回答；结束后折叠头变「已完成，用时 X」。
2. 流式中途点开折叠头：能看到正在流式的过程内容（R1）；再收起、结束后默认仍收起。
3. 手动展开过的轮次，结束后回到收起（记忆丢弃语义）。
4. 审批 / AI 提问 / 计划批准弹出时照常接管区交互，不被折叠影响。
5. 失败轮：折叠 + 错误正文（最终回答）可见。
6. 关闭开关 → 行为与现状完全一致（默认模式零回归）。
7. 设置页开关与面板「…」菜单开关双向同步，重启后保持。
