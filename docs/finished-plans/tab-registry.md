# 「一切皆标签页」的统一模型与接线注册表（实施计划）

> 状态：**已实施**（2026-11-22 审计成文，同日 A+B 两阶段一次落地，成文即归档到 `docs/finished-plans/`）
> 前置阅读：`AGENTS.md`「内容区标签页（「一切皆标签页」，新增一类时必读）」· `frontend/test/editor/virtual-doc-wiring.test.mjs`（现有守卫）· `docs/finished-plans/browser-tab-restore.md`（浏览器标签的恢复方案，P0 个人浏览器已实施；其余虚拟标签页的可行性盘点在其 §4）
> 范围：只动前端内容区标签页模型（`frontend/src/core/`（新模块）、`frontend/src/editor/`、`frontend/src/bridge/`、`frontend/src/writing/writing-ui.js`、`frontend/src/main.js` 的 `appTabViewOf`）。不改 Go 侧、不改流式协议、不改会话存储格式。

## 1. 概念定义（本方案的语义基线）

**内容区里不存在第二种呈现单位**：任何值得人看或操作的东西都是一个 `doc`、占一个标签页，共用同一套标签生命周期（打开 / 激活 / 关闭 / 分栏 / 拖拽 / 跳转 / 描述给 AI）。

- **文件标签页**：`path ≠ null`（磁盘文件、未保存新文档）
- **虚拟标签页**：`path === null`，分两族——
  - **视图型**（本文称 V 族）：doc 上有一个标记位（`doc.browser` 等），`createDocEditor` 有专门分支建自定义面板，没有 `doc.editor`
  - **文本型**（本文称 T 族）：`openVirtualDoc` 产出，`untitled: true` + `viewKind`，**复用通用编辑器**，有 `doc.editor`

**边界**：本概念只覆盖内容区。AI 面板、设置、阅读模式、底部 dock、调试台、各类浮层是**常驻 UI，不是标签页**，理由见 §7。

## 2. 现状审计结论（2026-11-22）

### 2.1 已对齐

V 族 7 类（`browser` / `bgTerm` / `agentView` / `agentTeam` / `sideChat` / `groupMember` / `memo`）在下面 5 个接线点上全部一致：

| 接线点 | 位置 |
| --- | --- |
| 渲染分支 | `editor-groups.js:1288` `createDocEditor` |
| 屏蔽文件视图下拉 | `writing-ui.js:82` `viewOptionsFor`（`return []`） |
| 关闭卸载 | `editor-groups.js:1818` `closeDocNow` |
| 标签图标 | `editor-groups.js:716` `buildGroupTab` 图标链 |
| AI 上下文描述 | `main.js:961` `appTabViewOf` |

### 2.2 已修（2026-11-22 本次）

1. **浏览器标签页图标缺失**：`buildGroupTab` 图标链没有 `doc.browser` 分支，落到 `createFileIcon(doc.name)` 按 URL 尾段当扩展名解析 → 通用文本图标（`core/icons.js:63` 早就有 `browser` 图标但没人用）。已补 `browserTabIcon()` 并接入链条。
2. **守卫覆盖不到 T 族**：`virtual-doc-wiring.test.mjs` 用 `if (doc.X) { … View(doc) }` 反推类型集合，`openVirtualDoc` 产出的文档走通用编辑器，**从未被检测**。已补三条断言：图标链覆盖、T 族保持 `path: null` + `viewKind`、每个 `viewKind` 都能在 `APP_TAB_KIND_LABELS` 找到标签。

### 2.3 未解决（本文要解决的）

**接线逻辑是 5 条各自手写的 `if` 链 / 三元链，同一个「7 元素 + 若干标记位」的集合被枚举了 5 遍。** 加第 8 类需要改 5 处源码 + 记得更新测试，任何一处漏掉都**不报错**——只会静默降级（图标退化成文件图标、视图下拉出现、面板 DOM 泄漏）。

**打开入口是 10 个各自造 doc 的函数**，其中 7 个手写了几乎逐字相同的约 20 字段 doc 字面量：

```js
// bridge-memo-view.js / bridge-terminal-view.js / bridge-agent-view.js /
// bridge-team-view.js / bridge-sidechat-view.js / bridge-group-member-view.js / bridge-ui.js
path: null, content: '', size: 0, eol: 'lf', hasBom: false,
large: false, enc: 'utf-8', treeAvailable: false, dirty: false,
untitled: false, bases: {}, savedText: ''
```

只有 `id 前缀 / name / format / 标记位 / mode / spec` 不同。

**其余两处系统性缺口（本方案不解决，另见 §8）**：V/T 两族都不参与会话恢复（`session-restore.js:113` 按 `d.path` 过滤）、都不进「重新打开关闭的标签页」（`editor-groups.js:1833` 要求 `doc.path`）。

## 3. 目标 / 非目标

**目标**

1. 新增第 8 类标签页 = **加一条表格项 + 一个视图工厂函数**，不再需要同步 5 处。
2. 消除 7 份重复的 doc 字面量，字段集单一来源。
3. 现有守卫测试从「正则反推源码结构」升级为「对照注册表断言」，减少误报与漏报。
4. 行为零变化——这是纯结构收敛，不是功能改动。

**非目标**

- 不做统一 UI 打开入口（活动栏 / 文件菜单 / 欢迎页的场景化入口是合理的，见 §6.3）。
- 不做会话恢复与「重新打开」（§8）。
- 不动常驻 UI 的形态（§7）。
- 不重构 `createDoc`（文件 doc 工厂）本身的字段计算逻辑。

## 4. 设计：两层，分批落地

### 4.1 第一层（低风险、高收益）：`createVirtualTabDoc(data)` 工厂

把重复的 doc 字面量收成一个纯函数。

**位置**：`frontend/src/core/virtual-tab-doc.js`（新文件，纯函数，无 deps、无 DOM）。

> **为什么放 `core/` 而不是 `editor/`**（2026-11-22 实施时修正）：`bridge/` 只依赖 `core/` 与 `shell/`，
> 从不 import `editor/`（实测全目录无一处）。工厂要同时被 `editor/` 与 `bridge/` 使用，
> 放 `editor/` 会让 `bridge/ → editor/` 成为首例反向依赖，违反 AGENTS.md 的依赖单向约定。

```js
// virtual-tab-doc.js：虚拟标签页的 doc 字面量工厂（单一来源）。
// 只负责「无路径 doc 的公共字段」，不碰 id 生成策略与视图挂载——
// 那些由各域的 openXxxTab 决定并作为参数传入。
export function createVirtualTabDoc(data, docSeq) {
    return {
        id: data.id,
        path: null,
        name: data.name,
        content: '',
        size: 0,
        eol: 'lf',
        hasBom: false,
        large: false,
        enc: 'utf-8',
        format: data.format,
        treeAvailable: false,
        dirty: false,
        untitled: false,
        bases: {},
        savedText: '',
        mode: data.mode,
        [data.marker]: data.key,      // doc.browser / doc.bgTerm / … = 标识键
        ...(data.extra || {}),        // spec / command / url 等域私有字段
    };
}
```

**注意点**：

- `id` 仍由各域生成（`'bgterm-' + jobId`、`'memo-panel'`、`'agentview-' + key` 等），因为 id 里带身份键，去重依赖它。工厂不接管 `deps.docSeq`。
- `marker` 用计算属性写，保证「标记位 ↔ key」的绑定在工厂内一次成型，不会出现「拿了 key 忘了写标记位」。
- `browser` 是特例：它有 `browserPersist` / `browserUrl` / `browserProfile` 等额外字段，全部走 `extra`。**不要**为了它把工厂变复杂。

**改动面**：7 个 `openXxxTab` 各删约 12 行、加 1 次工厂调用。

**验收**：逐项对比改动前后的 doc 字段集完全一致（可写一次性断言脚本比对 `Object.keys`）。

### 4.2 第二层（中风险）：接线注册表

一张表替掉 5 条 `if` 链。

**位置**：`frontend/src/core/tab-kinds.js`（新文件，纯数据 + 纯函数，不下 DOM、不 import 任何域模块）。

```js
// tab-kinds.js：虚拟标签页类型的单一来源（元数据 + 谓词，不含视图实现）。
// 视图工厂仍由各域提供，经 deps 注入——本模块只回答「这是哪类标签页」。
export const TAB_KINDS = [
    {kind: 'browser',     marker: 'browser',     icon: 'browser',  label: '浏览器'},
    {kind: 'bgTerm',      marker: 'bgTerm',      icon: 'terminal', label: '后台终端'},
    {kind: 'agentView',   marker: 'agentView',   icon: 'agents',   label: '子代理详情'},
    {kind: 'agentTeam',   marker: 'agentTeam',   icon: 'agents',   label: '智能体团队'},
    {kind: 'sideChat',    marker: 'sideChat',    icon: 'sidechat', label: '支线对话'},
    {kind: 'groupMember', marker: 'groupMember', icon: 'group',    label: '群聊成员'},
    {kind: 'memo',        marker: 'memo',        icon: 'memo',     label: '快捷便签'},
];

// 谓词：doc → 类型项（无标记位返回 null）
export function tabKindOf(doc) {
    if (!doc) return null;
    return TAB_KINDS.find((k) => doc[k.marker]) || null;
}

// 视图下拉策略：视图型虚拟文档一律无文件视图
export function suppressesViewOptions(doc) { return !!tabKindOf(doc); }

// 图标名：无标记位返回空串（调用方回落 createFileIcon）
export function tabIconName(doc) {
    const kind = tabKindOf(doc);
    return kind ? kind.icon : '';
}
```

**5 个接线点的替换方式**：

| 位置 | 改法 |
| --- | --- |
| `createDocEditor` | 7 条 `if (doc.X) { … View(doc) }` → 保留**视图工厂分派**（每个域的 create 函数仍由 deps 注入，无法纯数据化），但入口判断改 `tabKindOf(doc)`，用一个 `switch (kind.kind)` 收敛到一处 |
| `viewOptionsFor` | `if (suppressesViewOptions(doc)) return [];` |
| `closeDocNow` | 7 条卸载 `if` → 保留（各域卸载契约不同），但改由 `tabKindOf(doc)` 前置守卫，且**每条卸载分支必须写 `doc.<marker>Unmount`**，由守卫测试对照 |
| `buildGroupTab` | 图标链 → `const name = tabIconName(doc); const icon = name ? tabIconSpan(name) : createFileIcon(doc.name, 'tab-icon');` |
| `appTabViewOf` | 7 条 `if/else if` → `const kind = tabKindOf(doc); if (kind) return {kind: kind.kind, label: kind.label, …}`，T 族的 `viewKind` 分支保留在其后 |

**为什么表放 `core/`**：`editor/` 与 `bridge/` 是两个同级域，AGENTS.md 规定「域模块之间不互相 import」。`core/` 是被两边共同依赖的纯函数层（先例：`core/readonly.js`、`core/formats.js`），依赖方向 `editor → core`、`bridge → core` 均合法。

**为什么 `createDocEditor` 不能纯表格化**：视图工厂是各域闭包（`deps.createAgentView` 等），塞进 `core/` 会反向依赖。表只回答「是哪类」，实现仍在各域——这是有意的分层，不是妥协。

### 4.3 守卫测试升级

`virtual-doc-wiring.test.mjs` 改为**对照注册表**，而不是从源码正则反推：

```js
// 现在
const editorKinds = virtualKinds(createEditorBody);   // 正则推出来

// 改成
import {TAB_KINDS} from '../../src/core/tab-kinds.js';
const declared = TAB_KINDS.map((k) => k.marker).sort();
```

保留并强化的断言：

1. 注册表 `marker` 集合 ↔ `createDocEditor` 的 `case` 分支一致
2. 注册表 `marker` 集合 ↔ `viewOptionsFor` 的虚拟判定一致（新版本为 `suppressesViewOptions` 的实现）
3. 每个 `marker` 在 `closeDocNow` 里都有卸载处理
4. 每个 `marker` 在 `src/bridge/` 有创建点
5. 每个 `marker` 在 `buildGroupTab` 图标路径上能被识别（新版本为 `tabIconName`）
6. 每个 `icon` 名在 `core/icons.js` 已注册（**新增**，防「图标名写错渲染为空不报错」）
7. T 族：`openVirtualDoc` 保持 `path: null` + `viewKind`；每个 `viewKind` 在 `APP_TAB_KIND_LABELS` 有标签（本次已加）

第 6 条是补一个真实盲区——`iconSvg` 拿不到图标名时静默输出空字符串，和本方案要根治的「静默降级」是同一类问题。

## 5. 实施步骤

### 阶段 A：doc 工厂（§4.1）

1. 新建 `frontend/src/editor/virtual-tab-doc.js`，写工厂 + 单测 `frontend/test/editor/virtual-tab-doc.test.mjs`（表驱动：7 种输入 → 期望字段集）。
2. 逐个改造 7 个 `openXxxTab`（每改一个跑一次相关测试，一域一 commit）。
3. 全量 `npm test` + 手动冒烟：7 类标签各开一次、关一次，确认图标 / 面板 / 卸载正常。

**阶段 A 收益**：净减约 80 行重复；字段集单一来源；风险低（纯字面量搬运，行为不变）。

### 阶段 B：注册表（§4.2）

1. 新建 `frontend/src/core/tab-kinds.js` + 单测 `frontend/test/core/tab-kinds.test.mjs`。
2. 逐点替换 5 个接线点（一点一 commit，每点跑守卫测试）。
3. 重写 `virtual-doc-wiring.test.mjs` 为对照注册表版本，补第 6 条图标断言。
4. 全量 `npm test` + 手动冒烟。

**阶段 B 收益**：新增第 8 类从「改 5 处 + 记得改测试」变成「加 1 行表项 + 1 个视图工厂」；守卫从源码正则升级为结构断言。

**两个阶段可独立上线**，A 不依赖 B。建议先 A 后 B（A 是 B 的前置：注册表要接管 `id`/`marker` 的生产，先有工厂更顺）。

**实施记录（2026-11-22，两阶段同批完成）**

落地后与计划的差异，均在实施中判定：

1. **两个新模块都放 `core/`**（而非计划里的 `editor/virtual-tab-doc.js` + `core/tab-kinds.js`）：实测 `bridge/` 全目录从不 import `editor/`，放 `editor/` 会造出首例反向依赖。
2. **`closeDocNow` 也统一了**（计划里本想保留 6 条 if 链）：实施中发现 6 个域的卸载钩子（`bgTermUnsub` / `agentViewUnmount` / `agentTeamUnmount` / `sideChatUnmount` / `groupMemberUnmount` / `memoUnmount`）**只在 `closeDocNow` 被消费**，于是统一成 `doc.tabUnmount` 一条契约。浏览器仍走 `BrowserClose`（要调 Go 侧释放 WebView2）。这条让「新增第 8 类完全不用碰 `editor-groups.js`」成立。
3. **视图工厂分派表 `VIRTUAL_TAB_VIEWS` 留在 `editor-groups.js`**（键是 `kind`）：工厂本体在各域，表只做分派，用箭头函数保持 deps getter 惰性。
4. **`APP_TAB_KIND_LABELS` 删掉 7 个视图型条目**，只留 `plan` / `diff` / `document` / `untitled`（文本型）。视图型的 kind / label 以注册表为准。
5. **措辞纠正**：原文说 `viewOptionsFor` 的虚拟判定"漏了 → 视图下拉出现"，实际 T 族是**有意不屏蔽**（`.md` 计划文档需要预览），已在 `viewOptionsFor` 上补注释并由守卫测试钉住边界。

### 阶段 C：文档同步

- `AGENTS.md`「内容区标签页（「一切皆标签页」，新增一类时必读）」那一节：从「四处必须同时改」重写为注册表驱动的 4 步清单，并补常驻 UI 豁免边界；`core/` 模块清单补 `tab-kinds.js` / `virtual-tab-doc.js`。
- `CHANGELOG.md`：B 阶段后写一条（用户不可见的结构调整，简要提及）。

## 6. 风险与取舍

### 6.1 风险

| 风险 | 缓解 |
| --- | --- |
| 工厂漏字段导致某类标签页行为变化 | 阶段 A 每域单独 commit；用一次性脚本比对改动前后 `Object.keys(doc)` 与值 |
| 注册表引入循环依赖 | 表放 `core/`，只放纯数据 + 谓词，绝不在表里 import 域模块 |
| 守卫重写后误报（新断言太严） | 先写新守卫、跑通绿，再删旧的正则推导逻辑；两版短暂共存一轮 |
| `createDocEditor` 改造触碰热路径 | 只改入口判断（`tabKindOf` + `switch`），视图工厂调用体原样保留 |

### 6.2 明确不做的

- **不把视图工厂塞进注册表**：会形成 `core/ → editor/` 反向依赖。
- **不统一 id 生成规则**：`bgterm-<jobId>`、`agentview-<subId>` 这类带身份键的 id 是去重依据，统一成 `doc-<seq>` 会破坏 `docs.find(d => d.bgTerm === jobId)`。
- **不动 `closeDocNow` 的卸载顺序**：`disposeSqlDoc → disposePatchView → releaseVideo/Audio/HtmlPreview → disposePluginView` 的顺序有注释依据（视频要先断源再摘节点），重排有风险。

### 6.3 不做统一 UI 打开入口的理由

活动栏（`ab-browser` / `ab-memo`）、文件菜单（新建浏览器标签页 / 快捷便签面板）、欢迎页常用入口、各域内部触发（AI 打开子代理详情等）服务不同场景。收成单一「新建…」入口会：

- 多一次点击（最常用的浏览器 / 便签要多跳一层）
- 无法承载场景专属参数（`openBrowserTab(url, profileKey, {personal})` 的"保留登录"分支、`openAgentTab(spec)` 的会话上下文）

**统一的是数据模型与接线，不是入口。**

## 7. 豁免清单（常驻 UI，不是标签页）

写进概念，避免将来被当成"漏了"而误改：

| 区域 | 形态 | 理由 |
| --- | --- | --- |
| AI 面板 `#ai-panel` | 侧栏单例 | `#ai-panel` 42 处 id 选择器硬约束，`side-chat-tab.md` 明确「不做多实例」 |
| 设置 | 模态对话框 | 有保存/取消语义与遮罩栈，不是浏览对象 |
| 阅读模式 `#reading-view` | `#editor` 的兄弟节点，`.hidden` 切换 | 独占式模式（`reading.js` 的 `show()`/`close()`），有专注模式与 TTS；与标签栏互斥更合理 |
| 底部面板 `#terminal-panel` | dock 单容器 | `dockView` = terminal / debug / run / graph（`terminal-ui.js`）——**它自己已是一套 4 态切换器** |
| 调试控制台 / Git 图谱 | dock 的一个 view | 同上 |
| 欢迎页 `#welcome` | 空状态 | 不是内容 |
| 快速切换 / 命令面板 / 灯箱 / 右键菜单 | overlay | 瞬时交互，不承载持久内容 |
| 文件对比窗口 / 实时预览窗口 | 独立 OS 窗口 | 辅助窗（`window_geometry.go` 记忆位置），不在内容区 |

## 8. 遗留缺口（本方案不解决，各自立项）

1. **会话恢复不含虚拟标签页**：`session-restore.js:113` 按 `d.path` 过滤。浏览器那条已有 `docs/finished-plans/browser-tab-restore.md`（P0 个人浏览器已实施，2026-11-22；其余类型的可行性盘点见其 §4）；其余 6 类 + T 族无方案。恢复注册表后，可以给 `TAB_KINDS` 加 `restorable` 与 `snapshot(doc)` 字段，届时一并做。
2. **「重新打开关闭的标签页」不含虚拟标签页**：`editor-groups.js:1833` 只对 `doc.path` 入栈 `closedTabs`，`reopenClosedTab` 走 `openPath(entry.path)`。同上，注册表是天然的落点（加 `reopen(doc)` 钩子）。
3. **T 族的视图下拉是"有意保留"但没写明**：`viewOptionsFor` 不屏蔽 `.md` 计划文档的预览选项（正确），但源码里没有注释说明这是有意的。阶段 B 顺手补一句注释。

## 9. 验收标准

**阶段 A**

- `frontend/test/editor/virtual-tab-doc.test.mjs` 覆盖 7 种输入
- 7 个 `openXxxTab` 的 doc 字段集与改动前逐字段一致
- 全量 `npm test` 绿；手动冒烟 7 类标签开/关正常

**阶段 B**

- `frontend/test/core/tab-kinds.test.mjs` 覆盖 `tabKindOf` / `suppressesViewOptions` / `tabIconName`
- `virtual-doc-wiring.test.mjs` 6 条断言全绿，且**新增一条失败验证**：临时删掉注册表里的一项，测试必须变红（证明守卫真的在起作用）
- 新增第 8 类的演练：本地加一条假表项（如 `{kind: 'test'}`）+ 空视图工厂，确认除视图工厂外无需改任何其它文件，演练后删除
- 全量 `npm test` 绿；手动冒烟 7 类标签开/关/拖拽/分栏正常
