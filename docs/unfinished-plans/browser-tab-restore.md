# 浏览器标签页的关闭保存与启动恢复

> 状态：待立项（2026-11-21 起草；2026-11-22 补其他虚拟标签页的恢复评估，见 §4）
> 触发问题：「浏览器标签页不会关闭时保存和打开时恢复吗」——答案是**当前不会**，本文给出补齐方案。

## 1. 现状与结论

**当前行为：普通浏览器标签页不参与会话保存/恢复。** 应用关闭再打开，之前开着的网页标签不会回来。这是既定行为，不是 bug。（这个排除是统一的：`path: null` 的**所有**虚拟标签页都会被滤掉，不止浏览器——其余类型的逐类盘点见 §4。）

证据（2026-11-21 核对）：

- 会话持久化全部在 `frontend/src/shell/session-restore.js`。`serializeSession()`（`:107`）用 `deps.groupDocs(g).filter((d) => d.path)`（`:113`）收集标签；浏览器标签是虚拟文档，`path: null`（`frontend/src/bridge/bridge-ui.js:89`），在这一步被整体过滤。`modes` / `views` 的收集同样有 `if (!d.path) continue`（`session-restore.js:124,132`）。
- `restoreSession()`（`session-restore.js:236`）只按快照里的 `groups[].paths` 走 `openPathsHere()` 重开文件，整个模块没有任何 browser 相关代码。
- `frontend/src/editor/editor-browser-tab.js` 全文没有保存/恢复地址的逻辑。
- 关闭标签时只调 `BrowserClose(doc.id)`（`frontend/src/editor/editor-groups.js:1827-1829`），不记录地址。

**一个例外：登录态会留，标签不会。** 「文件 → 打开我的浏览器（保留登录）」开的个人浏览器（`bridge-ui.js:68` `PERSONAL_BROWSER_ID = 'browser-user'`）用固定实例 id + 固定 profile（`browserProfile: 'user'`，`:103`），Go 侧 DataPath = `<appdata>/<ProfileRoot>/browser-user_user`（`internal/browser/browser_windows.go:438`），cookie / 登录态落盘保留（注释见 `bridge-ui.js:64-67`）。但保存的只是 profile 数据，不是「开了哪些网址」。普通标签的 profile 是 `tab-<doc.id>`（`:117`），id 每次 `Date.now()+seq` 新建（`:88`），临时且每次不同——重启后连登录态都不保留。

**还有第三类：AI 会话浏览器，恢复处境最差。** AI 用浏览器工具时经 `ensureBrowserTab()` 为**每个会话**开一个专属标签（`frontend/src/ai/ai-panel.js:6985-7002`）：profileKey 是 `sess-<session.id>`（看起来稳定），但 tab id 走 `open_browser_tab` 的普通分支，是随机的 `browser-<时间戳>-<seq>`（`bridge-ui.js:88`，非 personal 分支）。Go 侧 profile 目录 = `sanitize(tabId + "_" + profileKey)`（`browser_windows.go:438`）——tabId 随机 ⇒ 目录每次不同 ⇒ **登录态也不保留**（不如个人浏览器）。tabId 虽写进会话 meta 并落盘（`ai-session-store.js:388`、`ai-panel.js:7000`），但重启后 WebView2 实例销毁、id 失效；下次 AI 用浏览器工具时 `ensureBrowserTab` 调 `BrowserState(id)` 失败 → 清空 id → 重开 about:blank（`:6987-6999`）。即：**地址不恢复、登录态不保留、标签不自动重建（惰性）**。它同样是 `path: null` 虚拟文档，也被 `serializeSession()` 的 `filter(d => d.path)` 过滤。

## 2. 目标与非目标

### 目标

应用重启后，恢复**上次未关闭**的浏览器标签，让「开着网页直接关应用 → 重开」能续上。

### 分阶段范围

三类浏览器标签，恢复价值与难度各不同：

| 类别 | 谁开的 | profile | 登录态跨重启 | 当前恢复行为 |
| --- | --- | --- | --- | --- |
| 个人浏览器 | 用户「打开我的浏览器」 | 固定 `browser-user_user` | **保留** | 不恢复地址（只留登录态） |
| AI 会话浏览器 | AI 浏览器工具，每会话一个 | `sess-<id>` 但 tabId 随机 ⇒ 目录随机 | **不保留** | 不恢复；下次工具调用惰性重开 about:blank |
| 普通临时标签 | 用户「新建浏览器标签页」 | `tab-<随机 id>` | **不保留** | 不恢复 |

- **P0（本次要做）**：只恢复**个人浏览器**（`browserPersist: true`）的标签地址列表。它有持久 profile，恢复后登录态、页面状态都在，价值高、实例数固定为 1、风险可控。
- **P1（暂不做，需先解决前置问题）**：恢复 AI 会话浏览器与普通临时标签。两者的 profile 目录都因 tabId 随机而每次不同——要恢复必须先让 tabId / profile 目录跨启动稳定（否则只恢复出未登录的空白页，意义不大），且一次恢复多个 WebView2 实例会拖慢启动。
  - AI 会话浏览器还有一层：**tabId 已存进会话 meta**（`ai-session-store.js:388`），可借此把「会话 ↔ 标签」关系持久化；若把 tabId 改成稳定值（如 `ai-browser-<session.id>`），就能恢复出带会话归属的标签，甚至可考虑恢复时只重建、不自动导航。但 profile 目录随 tabId 稳定后才会保住登录态。
  - 两者都列入后续评估，不在本次范围。
- **其余虚拟标签页**（应用页面 / 便签 / 支线对话 / 子代理详情等）逐类可行性评估见 §4：应用页面与便签可行性最高、无运行态依赖，适合作为后续阶段优先项；本轮不与浏览器恢复捆绑。

### 非目标

- 不改动现有文件会话（`cadt.session.v1` / `cadt.workspace-sessions.v1`）的任何逻辑。
- 不恢复滚动位置、表单内容、打开过的历史记录——只恢复「哪些地址」。
- 不给 AI 暴露新的读写接口，不进 `cadt.*` API。

## 3. 为什么不能塞进现有 session-restore

把浏览器文档硬塞进 `cadt.session.v1` 会踩四个坑，必须独立通道：

1. **工作区串台**：快照有全局 key + 按工作区 key 两层，写入靠 `inside(path)` 按路径过滤归属（`session-restore.js:51`）。浏览器标签 `path: null`，没有归属概念；塞进全局 key 会导致 A 窗口的网页在 B 窗口启动恢复出来。个人浏览器更是全局单实例，本就不属于任何工作区。
2. **空快照保护会丢弃**：`serializeSession()` 里 `if (!groups.length && !deps.workspaceFolder) return null`（`:121`）。浏览器标签在 `filter(d => d.path)` 那步被滤掉，`groups` 为空 → 只有网页没文件时整个快照不写。
3. **空快照覆盖逻辑会误伤**：`allowEmpty` 粘滞（`:168-169`）与空快照保护（`:173-182`）都是围绕「带 path 的标签」设计的，浏览器标签混进来会让「关掉最后一个网页标签」被误判成过程性保存。
4. **个人浏览器单实例**：固定 id `browser-user`，注释明确同一 user data 目录不能被两个 environment 同时用（`bridge-ui.js:65-67`）。多窗口同时恢复会撞车，必须与「已开着就切过去」分支（`:73-85`）协调。

## 4. 其他虚拟标签页的恢复评估（2026-11-22 补充）

> 问题：「其他虚拟标签页能否恢复？」——**当前同样全部不恢复**。`serializeSession()` 的 `filter((d) => d.path)`（`session-restore.js:113`）按 `path: null` 一刀切：`core/tab-kinds.js` 的 `TAB_KINDS` 登记的全部 8 类视图型（浏览器 / 快捷便签 / 后台终端 / 子代理详情 / 智能体团队 / 支线对话 / 群聊成员 / 应用页面）与 `openVirtualDoc` 产出的文本型（计划 / 差异 / 只读文档）都在被滤之列。本节逐类盘点恢复所需状态与可行性，作为后续分阶段依据；本轮（P0）范围不变，仍只做浏览器。

逐类评估（2026-11-22 核对）：

| 类型 | 标签 key（doc 标记位值） | 重启后依赖的运行态 | 可行性 |
| --- | --- | --- | --- |
| 应用页面 appPage | `doc.appPage` = 页面 id（`core/app-pages.js` 注册表，稳定） | 无——mount 函数启动后即就绪 | **高**：`openAppPageTab(pageId)` 一步重开，单例语义现成 |
| 快捷便签 memo | 固定 `'panel'`（每窗口单例） | 数据在 memo-store（后端持久化）；作用域在 `cadt-memo-scope` | **高**：重开面板数据自动读回 |
| 支线对话 sideChat | sessionId（会话 JSONL 持久） | 会话正文懒加载可读回；须处理「母会话不在场」的失联态（`docs/finished-plans/side-chat-tab.md` §3） | **中**：可重开，接线要进 AI 面板 |
| 子代理详情 agentView | subId（spec 已带 sessionId / parentSessionId / agentArtifactDir，注释明说「重启后详情视图靠它们从磁盘补读转录」，`ai-subagents.js:772`） | 运行态在内存丢失；转录在 `ai-artifacts/<根会话>/sub-<id>.txt`，详情视图已有磁盘补读路径（`ai-subagents.js:2245`） | **中**：终态可看，运行中状态不可恢复 |
| 智能体团队 agentTeam | sessionId | 团队运行态在面板内存注册表，重启即空；视图无磁盘回落（`ai-team-view.js` 无转录补读） | **低**：恢复出来是空态，除非先做「从会话转录重建历史」 |
| 群聊成员 groupMember | `groupId:agentId` | 群运行态在内存 | **低**：同团队视图 |
| 后台终端 bgTerm | jobId | 作业是应用子进程，随退出而死；输出缓冲在内存 | **几乎无意义**：恢复出来是 notfound 空壳 |

文本型（`openVirtualDoc` 的计划 / 差异 / 只读文档 / 粘贴文本）：正文是内存文本，恢复必须把全文写进快照；这些多为一次性产物（diff、审阅块、粘贴暂存），且计划文档的正文本可从 AI 计划存储重建——**不建议恢复**。

若后续把上表「高 / 中」几类纳入范围，存储建议**合并成一份虚拟标签快照**（如 `cadt.virtual-tabs.v1`，按 kind 分节），而不是每类再开一个 key：多窗口守卫（`auxWindowNoSession` 等价物）、pagehide 兜底、「只有真的持有该类标签的窗口才写」都是同类问题，一份快照一套机制；`cadt.browser-tabs.v1` 若先行落地，扩展时迁移合并即可（数据量都很小，迁移成本低）。多窗口语义与浏览器不同：这些标签是**每窗口状态**（便签每窗口一个、支线上限 3、子代理上限 8），恢复归属按「最后保存的那个窗口」口径即可接受，不必做 owner 租约。

## 5. 方案设计

### 4.1 独立存储

新 key：`cadt.browser-tabs.v1`（localStorage，与现有会话 key 并列，**全局单份，不按工作区分桶**——个人浏览器是全局单实例）。

数据格式（只存个人浏览器地址列表）：

```json
{
  "urls": ["https://example.com", "file:///D:/docs/a.html"],
  "savedAt": 1763664000000
}
```

- `urls`：当前打开的个人浏览器标签地址，按打开顺序；去重、过滤空白与 `about:blank`；上限 20 条（防止异常膨胀）。
- 纯函数负责归一化/序列化/反序列化，便于单测。

### 4.2 保存时机

由新模块 `frontend/src/shell/browser-tab-restore.js`（factory + deps 注入，与 `session-restore.js` 并列）统一管理内存中的 `urls` 列表：

1. **地址变化时**：`main.js:6350-6365` 的 `browser-nav` 事件里，当 `doc.browserPersist` 且 `data.url` 变化时，通知模块更新对应地址并 debounce（500ms）写盘。
2. **打开/关闭个人浏览器标签时**：`openBrowserTab()` 建个人标签（含「已开着切过去并导航」分支，`bridge-ui.js:73-85,110-112`）与 `closeDocNow()`（`editor-groups.js:1827`）通知模块增删地址。**关闭个人浏览器标签 = 用户不想看它了，从恢复列表移除**（登录态仍留在 profile 里，符合当前「关标签再开不用重新登录」的语义）。
3. **退出兜底**：模块自己注册 `pagehide` 监听，写一次盘；带与 `auxWindowNoSession()` 等价的守卫（AI 浮窗 / 调试控制台共享 localStorage，不能覆盖主窗口数据）。

关键：**只有真正持有个人浏览器实例的窗口才写这个 key**。其它窗口的 `docs` 里没有 `browserPersist` 文档，其保存路径必须「什么都不做」，绝不能把列表清空——否则 A 窗口开着网页、B 窗口退出就把 A 的地址抹掉了。

### 4.3 恢复时机与单实例冲突

- 恢复放在主窗口启动编排末尾：`frontend/src/bridge/bridge-ui.js:220-245` 的 `restoreSession` 之后（文件标签先恢复，再恢复网页），仅主窗口执行（复用 `floatWindow` / console 守卫）。
- 读 `cadt.browser-tabs.v1` → 拿到 `urls` → 逐个 `openBrowserTab(url, 'user', {personal: true})`。因为个人浏览器是单实例，第一次创建、后续走「已开着切过去并导航」分支即可。
- **多窗口同时启动的 owner 租约**：localStorage 是共享的，两个窗口同时启动会各自尝试创建 `browser-user`，而 WebView2 不允许两个 environment 共用同一 user data 目录（第二个初始化失败）。用一个轻量租约键 `cadt.browser-tabs.owner`（值 `{id, ts}`）：
  - 恢复前 CAS：owner 不存在或 `ts` 过期（>15s）→ 写入自己的窗口 id 并恢复；否则跳过。
  - 持有者每 5s 刷新 `ts`（心跳），关闭个人浏览器标签或退出时释放（仅当 owner 是自己的 id）。
  - 思路与项目现有 `internal/resourcelease` 一致，但这是 WebView 启动早期的前端逻辑，先用 localStorage 轻量实现；若实施时能直接复用 Go 侧 windowreg 的所有权判定，优先复用，避免重复造轮子。

### 4.4 用户开关（可选）

在设置里加「启动时恢复上次网页标签」开关（默认开），复用现有设置树。若嫌范围大，P0 可先不做开关、默认恢复，但要在方案评审时明确。

## 6. 涉及文件与改动清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/shell/browser-tab-restore.js`（新建） | 模块主体：纯函数（归一化/序列化）+ 控制器（保存/恢复/租约/心跳）+ `pagehide` 监听。factory + deps getter 注入，不 import main.js。 |
| `frontend/src/main.js` | ① import 并创建模块实例、注入 deps getter（参照 `createSessionRestore` 在 `:5239` 的接线）；② `browser-nav` 事件（`:6350`）里通知地址变化；③ 导出 getter 给 bridge-ui 与 editor-groups。 |
| `frontend/src/bridge/bridge-ui.js` | ① `openBrowserTab()` 的个人标签创建/导航分支（`:73-85,110-112`）通知模块；② 启动编排（`:220-245`）在 `restoreSession` 之后调用恢复。 |
| `frontend/src/editor/editor-groups.js` | `closeDocNow()` 的个人浏览器分支（`:1827-1829`）通知模块移除地址。 |
| `frontend/test/shell/browser-tab-restore.test.mjs`（新建） | 纯函数 + 保存/恢复/租约逻辑的单元测试。 |
| `frontend/package.json` | 把新测试登记进 `scripts.test` 清单（`:9`）——`test/core/test-manifest.test.mjs` 双向守卫会卡漏登记。 |
| `CHANGELOG.md` | 用户可见变更：新增「重启后恢复个人浏览器标签」。 |

不改动：`session-restore.js`、`session-restore.test.mjs`、任何 Go 文件、`wailsjs/`。

## 7. 验证方式

**单元测试**（`frontend/test/shell/browser-tab-restore.test.mjs`）：

- 地址列表归一化：去重、过滤 `about:blank`/空白、上限截断；序列化/反序列化往返。
- 只有持有个人浏览器实例的窗口写 key；其它窗口的保存路径不覆盖。
- 关标签从列表移除、退出兜底写盘。
- owner 租约：无 owner 时获取并恢复、未过期时跳过、过期后接管、释放后他人可接管。

**接线护栏**（源码断言，参照 `session-restore.test.mjs:96-103`）：main.js 的 getter 注入、bridge-ui 的恢复调用点、editor-groups 的关标签通知点必须存在。

**手工验收**：

1. 打开「我的浏览器」访问两三个网址 → 直接关应用 → 重开 → 标签与登录态都在。
2. 关掉个人浏览器标签 → 退出 → 重开 → 不再自动恢复该标签（但手动打开仍保留登录）。
3. 只开普通临时标签 → 退出重开 → 不恢复（P1 未做，符合预期）。
4. AI 用浏览器工具开标签 → 退出重开 → 不自动恢复；下次调用工具时惰性重开 about:blank，且登录态不保留（P1 未做，符合预期）。
5. 双窗口同时启动 → 只有一个窗口恢复个人浏览器，另一个不报「user data 目录被占用」。

**回归**：`npm test`（清单守卫确保新测试真的跑）、`go test ./...`（本方案不改 Go，仅确认无连带影响）。

## 8. 风险与取舍

- **WebView2 启动成本**：P0 只恢复 1 个个人浏览器实例，可接受；P1 多标签需评估。
- **地址可能失效/需重新登录**：只恢复地址，不保证页面可用；这是「恢复标签」的固有语义，用户可接受。
- **localStorage 租约的时钟依赖**：多窗口时钟一致（同机），15s 过期 + 5s 心跳足够；极端卡顿下可能双方都认为过期而双开，属于低概率边界，可在评审时决定是否改用 Go 侧 windowreg。
- **不按工作区分桶**：个人浏览器全局唯一，按工作区分桶反而会导致「换工作区登录态丢失」的错觉；地址列表全局一份是正确语义。

## 9. 待拍板

1. P0 是否接受「只恢复个人浏览器，AI 会话浏览器与普通临时标签不恢复」？（推荐：接受，P1 另立）
2. 是否要「启动时恢复」开关？（推荐：P0 先默认恢复、不加开关，若用户明确要控制再加）
3. 多窗口 owner 用 localStorage 轻量租约，还是复用 Go 侧 windowreg？（推荐：先轻量租约，实施时若能直接接 windowreg 则优先）
4. P1 若做 AI 会话浏览器：是否把 tabId 改成稳定值（如 `ai-browser-<session.id>`）以保住登录态与会话归属？这会改变 profile 目录命名，需评估旧目录兼容。（推荐：P1 单独立项时再拍板，本次不动）
5. §4 里高可行性的应用页面 / 便签两类，是否随本方案一起做、还是留在后续阶段另立项？（推荐：不捆绑——两者同样走独立通道、代码路径几乎不相交，但两批一起上线会让「恢复语义」的首次验证混在一起；单独立项按 §4 的合并快照思路做更干净）
