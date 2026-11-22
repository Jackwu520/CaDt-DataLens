# 设置 →「智能体」迁为应用页面标签页（已完成）

> 状态：2026-11-23 立项并当日实施完成（落地记录见文末 §8）。
> 决策依据：①迁移形态走**外部工具停靠区先例**而非「设置行留置」先例——本页无可写设置项，且模块创建期按 id 捕获元素引用（与 ai-mcp-settings.js 同款约束），节点身份必须保持；②**AI 工具零改动**（get_agents / create_agent 走 aiGroupApi 纯配置读写不碰 DOM），app_control 只改三处文案；③**不新增 `open_app_page` 动作**——外部工具 / 定时任务迁移先例都没加，AI 可达路径保持 `open_settings {pane:"app-pages"}` 目录页；④数据层（ai-agent-model.js、ai-config.json）与 Go 侧、mock-backend 零改动。
> 范围：前端 UI + AI 动作表文案 + 一处群聊功能接线。第 6 个应用页面迁移，机制全部复用，预计 9-10 个文件、净增 100-150 行、无新依赖。

## 1. 背景与现状（代码事实，2026-11-23 核实）

### 1.1 页面本体

- pane DOM：`frontend/index.html:765-776`（`data-pane="agents"`：一张静态卡「新建智能体」按钮 `#ai-agent-create` + 动态列表 `#agents-list`），设置导航项 `index.html:301`（icon `agents`）。
- 实现：`frontend/src/ai/ai-agent-settings.js`（423 行），由 `ai-settings-dialog.js:1387` 创建为 `agentsMod`：
  - **元素捕获**：模块创建期 `document.getElementById` 抓 `listEl` / `createBtn`（ai-agent-settings.js:88-89）——与 `ai-mcp-settings.js:118-120` 同款，决定了迁移形态（见 §3.2）。
  - `bindAgentsPane` 幂等绑定新建按钮（dataset.agentsBound 守卫，:106-110），现在只在设置窗打开时经 `bindSettingsPane` 调用（ai-settings-dialog.js:1358）。
  - `renderAgentsPane` 全量重绘列表（:132-158），由 `refreshSettingsPane` 驱动（ai-settings-dialog.js:285）。
  - 编辑器弹窗 `openAIDialog`（:355-356）与分组建议 popover（:74）**均已接入 overlay-stack**：弹窗走 `ai-manage-dialogs.js:92` 的 `dialogStackHandle`，body 定位、栈配 z-index，**不依赖设置弹窗存在**——「耦合深」的最大疑虑不存在。
  - `setSettingsStatus` 来自 extras（:87），写的是设置窗状态条。
- 数据：`agents[]` 存 ai-config.json（ai-agent-model.js 真源归一化），经 `aiPanel.aiGroupApi.getConfig/saveConfig` 读写（ai-panel.js:19234-19236）。**不在 settings 三条同步通道里**；`settings-tree.js` 对该 pane 无显式引用；pane 内没有可写控件（唯一按钮行被 buildSettingsTree 判 `kind:'action'` 不可写，动态 `#agents-list` 不是 `.set-row` 不进树）。
- 刷新链弱（现状即如此，迁移不变差）：`saveAIConfig` 不广播任何事件，已打开的 pane 在 AI `create_agent`（main.js:2105-2147，落盘走 `aiGroupApi.saveConfig()`）后不会重绘，要等下次 `refreshSettingsPane`。

### 1.2 群聊域的既有接线（唯一功能级耦合）

- 新建群聊弹窗左下角齿轮：`ai-group-sidebar.js:430` 调 `openSettings('agents')`（宿主注入在 main.js:4690）——迁移后必须改指应用页面标签页。
- 文案 5 处写死「设置 → AI → 智能体」：ai-group-sidebar.js:225 / :360 / :423 / :424、ai-group-runtime.js:969。
- AI 侧文案：main.js:2145（create_agent 返回 note）。

### 1.3 与五个已迁页面的形态对比

| 页面 | 迁移形态 | 本页适用性 |
|---|---|---|
| 外部工具 | `#extcap-park` 停靠区搬运，节点身份保持 | **适用**（同款元素捕获约束） |
| 操作记录 | 真·设置项留置设置页 + 页内「去设置」 | 不适用（本页无设置行，无需留置） |
| 使用统计 / 补丁库 | 设置 DOM 整体移除，mount 自建 | 不适用（模块闭包状态会丢） |
| 定时任务 | 面板闭包内容经桥转发 | 桥的注法适用（§3.2） |

### 1.4 语义定位（为什么这个迁移是对的）

**判据的实质是「实体管理面板 vs 偏好开关」，不是字面的「大内容 / 长停留」**。五个已迁页面的共性是管理实体列表（MCP 服务器管理与智能体管理几乎同构）；而设置体系的机械判据是 settings-tree 反射成 AI 可写偏好行（`set_setting_row`）——智能体 pane 在这个体系里本来就是异类：零可写控件（唯一按钮行判 `action` 不可写、动态列表不进树）、数据不在 settings 三条同步通道、AI 对它的操作走专属动作而非 `set_setting_row`。「设置 → 智能体」是塞在设置里的管理面板，位置本身是语义错位，外部工具迁移是完全相同的论证。判定线：可写偏好行（子代理上限 / 注入开关 / 权限）= 设置；实体管理面板 = 应用页面。

**心智模型层，现状才是语义不一致**：`agent` / `agentTeam` 已是内容区标签页类型（tab-kinds.js:39-40，智能体团队详情 ai-panel.js:19511），群聊视图、便签也是标签页——智能体作为被群聊引用的实体（删除时提示「引用它的群聊将显示已删除成员」），唯独编辑入口埋在设置弹窗里。迁移后「管理页 + 运行视图」都在内容区，语义闭环，并解锁与群聊 / 文件并排对照的能力。

**两个诚实的张力点**：①gen-models 与智能体数据形态同构（都是 ai-config.json 列表 + 编辑器弹窗，ai-settings-dialog.js:1384-1387 自认「同 genMod 形态」）但一个迁一个留——回应：形态同构、语义不同类，gen-models 条目是生成能力的资源配置（`generate_image` 直接消费、密钥性质），智能体是被群聊域运行时引用的业务实体；若将来 gen-models 也迁可一起做。②智能体页在「大内容 / 长停留」字面判据上偏弱——回应：长停留是典型症状而非必要条件（外部工具的「并列对照」属性也不强）。

## 2. 目标与非目标

**目标**：
1. 「智能体」成为内容区应用页面标签页（APP_PAGES 登记后，侧栏面板 / 菜单 / 命令面板 / 设置目录页四个入口自动出现，`appTabViewOf` AI 上下文自动生效）。
2. 设置对话框不再有智能体子页；`open_settings` 不再接受 `pane:"agents"`。
3. 群聊建群齿轮、AI 动作 note、群聊空态提示全部改指「应用页面 → 智能体」。

**非目标**：
- 不改 agents[] 数据模型、不迁移存储、不动 aiGroupApi 契约。
- 不新增 AI 工具或 app_control 动作（含 `open_app_page`——见头部决策③）。
- 不做编辑器弹窗 / 列表的视觉重设计（视觉原样搬运；要现代化另立方案，参照 app-pages-redesign.md 的做法）。
- 不给 `saveAIConfig` 加跨窗口广播（现状设置 pane 同样不实时，保持等价；可选小增强见 §3.6）。

## 3. 方案

### 3.1 注册表与标签页基建（大半零改动）

- `core/app-pages.js` 的 `APP_PAGES` +1 条：`{id:'agents', label:'智能体', icon:'agents', group:'AI', desc:'群聊（圆桌讨论）成员管理：模型绑定、人设与职责'}`。icon `agents` 已在 `core/icons.js:49` 注册（tab-kinds 的 agent/team 项共用），无需新图标。
- `core/tab-kinds.js` 的 appPage 项带 `resolve`，标签图标 / 标题 / AI 上下文描述自动细分——零改动。
- `bridge/bridge-app-page-view.js` 的 `openAppPageTab` 单例去重 + `VIRTUAL_TAB_VIEWS.apppage` 分派 + `doc.tabUnmount` 统一卸载——零改动。
- `main.js` 的 `appPageMounters`（:5483-5490）+1 行，照抄 schedules 的惰性桥：

```js
// frontend/src/main.js（appPageMounters 表内新增；schedules 挂载器同款兜底一并补）
'agents': (root) => {
    if (!aiPanel) initAIPanel();
    return aiPanel && aiPanel.bridgeMountAgents ? aiPanel.bridgeMountAgents(root) : null;
},
```

aiPanel 是**惰性初始化**的（`initAIPanel()` 只在面板交互路径触发，main.js:4333 起）：评估时的「启动主流程创建」判断有误（审查 P1-1 证实），照抄 schedules 的裸惰性桥会让「没碰过 AI 面板就开智能体页」得到空白标签页且再激活不自愈（`doc.pane` 守卫挡住重挂）。挂载器先 `initAIPanel()` 幂等兜底（与设置页 AI 子页 settings-ui.js:846、外部工具页 main.js:5636-5641 同款）；schedules 挂载器的同病（HEAD 存量）一并修。

### 3.2 停靠区与挂载器（核心改动）

**index.html**：
- `:765-776` 的整段 pane div 移入文件尾部新停靠容器 `<div id="agents-park" class="hidden"></div>`——**必须放 `#dlg-settings` 之外**（external-tools-page.test.mjs 已钉死同类守卫：buildSettingsTree 只扫 `.settings-pane`，停进弹层会被误索引）。
- 删除设置导航项 `:301`。

**ai-agent-settings.js**（挂载逻辑归元素的所有者模块，`bindAgentsPane` 本就幂等）：
- 返回值扩为 `{bindAgentsPane, renderAgentsPane, mountAgentsPane}`：

```js
// frontend/src/ai/ai-agent-settings.js：应用页面标签页挂载（停靠区搬运，保持节点身份）
function mountAgentsPane(root) {
    const pane = listEl ? listEl.closest('[data-pane="agents"]') : null;
    if (!pane || !root) return null;
    root.appendChild(pane);                       // mount/unmount 只搬不重建，引用与绑定跨开关始终有效
    pane.classList.remove('hidden');              // 离开设置窗的 hidden 切换体系，挂载即显示
    bindAgentsPane();
    renderAgentsPane();
    return () => {
        const park = document.getElementById('agents-park');
        if (park && pane.isConnected) park.appendChild(pane);
        closeGroupSuggest();                      // 编辑中途关标签页：建议弹层收口（编辑器弹窗自身有栈，不在此管）
    };
}
```

- `setSettingsStatus` 依赖处理：保存 / 删除提示（:207、:419）从「设置窗状态条」改为 `ctx` 注入的 `flash`（activity-pane 先例）——标签页场景设置窗多半没开，往里写状态等于写空气。模块经 ctx 拿 flash，main.js / ai-panel 注入链补一个 getter。

**ai-settings-dialog.js**：return（:1406-1409）补转发 `mountAgentsPane: agentsMod.mountAgentsPane`；`:285` 的 `refreshSettingsPane` 调用与 `:1358` 的 `bindAgentsPane` 调用保留无害（pane 不在设置窗时 renderAgentsPane 往停靠区里的 listEl 渲染，幂等且不可见），但按外部工具先例补注释说明「pane 已迁为应用页面标签页，refreshSettings 不再覆盖它」。

**ai-panel.js**：导出桥 +1 行（`bridgeMountSchedules` 同款，:19515 先例）：

```js
// frontend/src/ai/ai-panel.js：智能体应用页面标签页用的桥（列表与编辑器都在 ai-agent-settings 闭包里）
bridgeMountAgents: (root) => settingsMod.mountAgentsPane(root),
```

**style.css**：停靠容器与标签页节奏 class（`.extcap-root` 先例，:11566）：

```css
/* 智能体应用页：沿用设置 pane 纵向节奏（set-card 堆叠），容器 flex+gap */
.apppage-root.agents-root { display:flex; flex-direction:column; gap:12px; }
```

`.agent-*` 系列样式（style.css:13834）是全局类，出了设置窗不受影响。

### 3.3 设置侧摘除

- `settings-ui.js:824` / `:845`：AI 组 pane 列表（`inAI` 展开逻辑）去掉 `'agents'`。
- `selectSettingsPane` 无 agents 专属分支，无需动；settings-search / settings-tree 对该 pane 无显式引用，pane 消失即自动从树与搜索里退出。
- `get_settings_tree` 返回里 agents pane 消失（其中的 action 行本就不可写），AI 写入面不变。

### 3.4 群聊域接线与文案

- `ai-group-sidebar.js:430`：`openSettings('agents')` → `openAppPageTab('agents')`；main.js:4690 注入点同步（deps 键名改 `openAppPageTab`，值取 bridgeUI 解构出的 `openAppPageTab`，main.js:7512 已有）。
- **交互语义已核实（2026-11-23）**：齿轮处理器本来就先弃草态再跳（:426-431 `createControls = null; closeDialog(); openSettings('agents')`，注释原话「先去设置里把智能体备齐，再回来建群」）——「离开建群流程去备成员」是显式设计，不存在模态遮挡问题，迁移后 `closeDialog(); openAppPageTab('agents')` 语义完全等价；也不引入新的状态丢失（建群表单草态在点齿轮时就丢弃是现状行为）。
- 文案 5 处改口径「应用页面 → 智能体」：ai-group-sidebar.js:225（「先到 设置 → AI → 智能体 创建成员」）、:360（「已创建默认主持人智能体」）、:423-424（齿轮 data-tip / aria-label）、ai-group-runtime.js:969（「先到 设置 → AI → 智能体 启用成员」）、main.js:4689 注释。

### 3.5 AI 侧：app_control 动作表与指引（只改文案）

`frontend/src/ai/ai-constants.js` cadt-ui 技能动作表：
- `:328` `open_settings`：pane 枚举去掉 `agents`；仿外部工具句式补一句「智能体不在设置弹窗里，指引时说『应用页面 → 智能体』」。
- `:336` `create_agent`：「只新建，不修改/删除已有智能体（那由用户在设置页操作）」→「…（那由用户在 应用页面 → 智能体 操作）」。
- `main.js:2145` create_agent 返回 note：「人设/角色可在 设置 → AI → 智能体 再编辑」→「人设/角色可在 应用页面 → 智能体 再编辑」。

**不动的**：`get_agents` / `create_agent` 实现与参数、`APP_ACTIONS` 清单、`runAppAction` 分支、`MCP_CONFIG_ACTIONS`、UNDOCUMENTED 表——动作名一个不变，`ai-app-actions.test.mjs` 三方对账不会红；`AI_TOOL_DEFS`（spawn_agent 等子代理工具与本页无涉）；`ai-system-context.js`（无具体路径指引）。

### 3.6 可选小增强（1 行，建议顺手做）

`main.js:2147` 附近（create_agent 落盘后）：若 `docs.find(d => d.appPage === 'agents')` 且 `appPageRoot.isConnected` 则 `aiPanel.bridgeRefreshAgents?.()`——标签开着时 AI 建完即时可见（schedules-changed 订阅先例 main.js:4779-4791）。不做也行：与现状（设置 pane 同样不实时）等价，下次打开标签页 mount 时 `renderAgentsPane` 必然重绘。

## 4. 风险与注意点

1. **元素捕获约束**：`listEl` / `createBtn` 在模块创建期按 id 捕获（:88-89）——停靠区搬运保持节点身份即可，**禁止**改成 mount 时重建 DOM（会丢 `dataset.agentsBound` 绑定守卫、编辑器中间态与分组折叠记忆）。
2. **停靠区位置**：`#agents-park` 放 `#dlg-settings` 之外，否则被 buildSettingsTree 误索引成设置行（守卫测试钉这条）。
3. **hidden 类**：pane div 带着 `settings-pane hidden` 两个类进停靠区，mount 时摘 `hidden`；unmount 不用加回（停靠区容器整体 `hidden`）。若嫌语义混乱，搬运时把 `settings-pane` 类也一并去掉（树 / 搜索只认 `.settings-pane`，去掉更干净，但要同步核对外层 `.set-card` 间距样式不依赖该父类——实施时验证）。
4. **编辑器弹窗跨标签页**：`openAIDialog` 是全局栈弹窗，编辑中途关标签页不会关弹窗（弹窗不属于 pane）——可接受（与设置窗关闭时弹窗仍开的现状一致）；`closeGroupSuggest` 在 unmount 里收口，防建议弹层悬空。
5. **`ai-panel.js` 行数红线**：1.1 万行超线存量「只减不增」，桥方法 +1 行与 `bridgeMountSchedules`（:19515）同性质，可接受。
6. **标签页开着时的实时性**：`saveAIConfig` 不广播，另一窗口 / AI 动作改了 agents[] 标签不重绘——§3.6 可选增强覆盖最常见的 create_agent 场景；完整方案（ai-config-changed 广播）影响面大，不进本次范围。

## 5. 实施顺序

1. **基建**：`core/app-pages.js` 登记 + `index.html` 停靠区与 pane 搬家 + `ai-agent-settings.js` mountAgentsPane + `ai-settings-dialog.js` / `ai-panel.js` / `main.js` 三级桥 + `style.css` 节奏类——此刻标签页已可用，设置窗里 pane 还在（双入口并存，可先手工验证）。
2. **摘设置侧**：删导航项 `:301`、`settings-ui.js` 两处 inAI 列表、`ai-agent-settings.js` 状态条换 flash。
3. **群聊接线与文案**：齿轮跳转 + 5 处用户可见文案 + AI 侧 3 处（ai-constants / main note）。
4. **守卫测试 + 收尾**：新增页面守卫测试、登记 `npm test`、CHANGELOG / README。

每步可独立提交（conventional commits + 中文描述）；步骤 1 完成后即为可用中间态。

## 6. 验证清单

- **新增守卫**：`frontend/test/settings/agents-page.test.mjs`（external-tools-page.test.mjs 先例，登记 `npm test`）：
  - `#agents-park` 存在且在 `#dlg-settings` 之外（innerHTML 断言，防树误索引）；
  - park 包含按 id 捕获的 `agents-list` / `ai-agent-create`（节点身份契约）；
  - APP_PAGES 有 `agents` 条目且 icon `agents` 已在 icons.js 注册；
  - main.js `appPageMounters` 登记 agents；settings-ui 的 inAI 列表不含 agents；
  - mount / unmount 搬运契约（jsdom 下模拟 root appendChild + 搬回）；
  - 群聊侧栏齿轮不再调 `openSettings('agents')`（源码断言 + 文案口径）。
- **既有守卫回归**：`virtual-doc-wiring.test.mjs`（appPage 对账自动装下新页）、`ai-app-actions.test.mjs`（动作名不变应全绿）、`ai-constants.test.mjs`、`test-manifest.test.mjs`（新测试登记）、icon-guard / form-controls / overlay-esc 三护栏。
- **手工验收**：四个入口开标签页且单例去重；编辑器弹窗 / 分组建议 popover 在标签页里正常（Esc 栈序）；建群齿轮直达标签页；AI `create_agent` 后 note 文案新口径；`open_settings {pane:"agents"}` 报错信息可读；设置搜索不再出现智能体行；双窗口场景标签页互不干扰。

## 7. 契约边界与后续

- **不可动契约**（全部复用、零改动）：`core/app-pages.js` 清单结构、`core/tab-kinds.js` appPage resolve、`bridge/bridge-app-page-view.js` 单例标签 + `mount(root)→卸载函数` + `doc.tabUnmount`、`main.js` 的 `appPageMounters` 注入形态、`aiGroupApi` 契约、agents[] 数据模型。
- 与外部工具同款的已知代价：停靠区是过渡形态，彻底组件化要连 ai-settings-dialog 的模块创建契约一起重构（agentsMod / genMod / prefMod 同族），另立方案——本页 423 行体量小，若将来随「AI 设置子页组件化」一并做，停靠区可整体拆除。
- 若后续要做智能体页视觉现代化（列表列对齐、整行可点、详情抽屉），照 `app-pages-redesign.md` 的 ui-kit 路子另立方案，不在本页迁移范围内。

## 8. 落地记录（2026-11-23，当日实施完成）

- **按 §5 顺序四步走完**，全部落地：注册表 / 停靠区 / `mountAgentsPane` / 三级桥 / `.agents-root` 节奏类 → 设置侧摘除（导航项、settings-ui 两处、flash 替换 setSettingsStatus）→ 群聊齿轮接线与 6 处文案 → AI 侧动作表两处 + create_agent note + 开标签即时刷新（§3.6 可选增强已做）。
- **与方案的偏差**：一处实质修正——§3.1 原判「aiPanel 在启动主流程创建」有误（实为惰性初始化），子代理审查（2026-11-23，全项 ✅ 除该项）证实裸惰性桥会让「没碰过 AI 面板就开智能体页」得到空白标签页且不自愈；挂载器补 `initAIPanel()` 幂等兜底（§3.1 已改写），schedules 挂载器的同病（HEAD 存量）一并修，两个测试文件各加一枚兜底钉子。其余原样落地：§3.2 参考实现、§4.3 的「settings-pane 类去除」选择静态改类（park 里直接 `agents-root hidden`），无需运行时摘类。
- **审查遗留（P3，刻意不做）**：模型惯性传 `open_settings {pane:"agents"}` 会得到空白设置弹窗且动作仍报 `{opened:true}`——与 external-tools 迁移后语义一致、动作表已声明 agents 不在设置窗；若要失败信号需对已迁 pane 做纠偏路由，另立小改动。
- **触点清单**（13 个代码/测试文件）：`core/app-pages.js`（+1 条）、`index.html`（导航项删除 + pane 搬家 + `#agents-park`）、`ai/ai-agent-settings.js`（头注释 / flash / `mountAgentsPane`）、`ai/ai-settings-dialog.js`（转发 + 两处注释）、`ai/ai-panel.js`（两个桥）、`main.js`（mounter 含面板兜底 + 群聊侧栏 deps + create_agent 刷新与 note）、`settings/settings-ui.js`（inAI 两处）、`ai/ai-group-sidebar.js`（齿轮 + 3 处文案 + deps）、`ai/ai-group-runtime.js`（1 处文案）、`ai/ai-constants.js`（动作表两处）、`style.css`（节奏类 + 2 处注释）、`frontend/package.json`（测试登记）、`test/ai/ai-schedule-page.test.mjs`（schedules 挂载器兜底钉子）；文档面：本方案、CHANGELOG、README:135/157/162/163（157/162/163 是外部工具 / 使用统计迁移的 README 欠账，顺带清掉）、AGENTS.md 应用页面段。
- **验证**：新增 `frontend/test/settings/agents-page.test.mjs` 10 例守卫全绿（已登记 `npm test` 的 `test:ui-shell`）；相邻守卫（external-tools-page / ai-app-actions / ai-constants / virtual-doc-wiring / test-manifest / settings-tree / ai-schedule-page / ai-group-runtime / ai-group-chat / usage-stats-pane / activity-pane）100 例全绿；全量 `npm test` 通过；`npm run build` 通过。
