# 前端拆分第二阶段：editor-groups.js + main.js 残余大段

> 状态：未开工（2026-11-14 调研成文）
> 决策依据：structure-cleanup 归档后按文件行数规范复盘——>3000 行的 3 个文件里 editor-groups.js 完全未动；main.js 仍有 dev mock 等大段可拆。作者拍板先出本方案（不派子代理）。
> 前置阅读：`docs/finished-plans/structure-cleanup.md`（抽取模式先例）、`.cadt/memory/frontend-module-refactor-audit.md`（验证方法论）
> 范围：两个文件的域拆分；**不含** style.css（另议）、Go 侧（已记录取舍）、ai-panel.js（交子代理消息化方案消化）
> 原则：函数体逐字搬移；每批独立提交、独立验证、可单独 revert；0 新依赖

## 1. 现状锚点（2026-11-14 实测）

- `frontend/src/editor-groups.js`：5,130 行，`createEditorGroups(deps)` 单工厂，251 个顶层定义（0 缩进，工厂闭包内）。
- `frontend/src/main.js`：7,473 行，227 个顶层定义。
- main.js 组合根接线（`createXxxMod({...getters})` 构造块，约 3,655–3,825、6,280–6,510 两段）是组合根职责，**保留不动**。
- 勘误：structure-cleanup §6 点名的「设置对话框 / CSV 表格 / Markdown 预览」三个隐式段落**实际已被 e00d77a 消化**（分别进了 settings-ui.js / editor-groups.js:2202–3211 / editor-groups.js:3106–3379+4755–4933）。main.js 现在真正的大段见 §3 区段表。

## 2. 抽取模式（沿用既有先例，无新发明）

- 新模块一律 `export function createEditor<域>(deps2)` 工厂，在 `createEditorGroups` 末尾构造：
  - `deps2` = 原样透传外层 `deps`（main.js 传来的 getter 集）+ 工厂内部共享状态的 getter/setter（`get editorGroups(){return editorGroups;}`）+ 跨模块互引的惰性转发箭头（`renderTabs: (...a) => renderTabs(...a)`）。
  - 重赋值 `let`（如 `aiWriteHideTimer`）经 setter 注入或随域迁走，禁止拍快照。
- main.js 侧新模块照 editor-groups 现有接线形态加构造块（getter 全量透传）。
- 禁止循环 import；模块间互引一律经构造时注入的惰性箭头解环（ai-panel 拆分已验证的模式）。

## 3. 阶段 E：拆 editor-groups.js（5 批，5,130 → 约 1,900）

行号区间为本次 grep 锚点，**实施时以 grep 重新定位为准**（structure-cleanup 教训：行号必然漂移）。

| 批 | 新模块 | 锚点区间 | ≈行数 | 内容 |
| --- | --- | --- | --- | --- |
| E1 | `editor-ace-hooks.js` | 987–1180 + 1406–1660 | ~500 | applyAceMode、codeFold hover 全家（11 函数）、multi-cursor、cursor tracking、python token classes |
| E2 | `editor-csv-view.js` | 2202–3105 + 3962–4046 | ~980 | CSV 表格视图族全量：表格/列统计/冻结列/虚拟滚动/单元格编辑/表历史 + enter/show/hide 分发 |
| E3 | `editor-split-preview.js` | 3106–3445 + 3446–3960 + 3260–3379 | ~940 | Markdown 预览+分屏+双向滚动同步、HTML 预览、SVG 渲染族（缩放/菜单前置于 E6）、图片/二进制/纯文本视图、enterSplitView/exitSplitView |
| E4 | `editor-sql-view.js` + `editor-browser-tab.js` | 4047–4283 + 1663–1962 | ~540 | 大文件 SQL 查询视图（2 模块一批）；浏览器标签族（地址/视口/外部打开/同步） |
| E5 | `editor-doc-extras.js` + `editor-export-menus.js` | 668–975 + 1183–1405 + 4284–4362 ＋ 4755–5130 | ~975 | 徽标/横幅/JSON 折叠/书签/视图状态/Git gutter/树右键菜单（extras ~600）；Markdown 块渲染+选区复制+svg/png 导出+svg/image/md/tab 右键菜单（export ~375） |

留守核心（~1,900）：编辑器组/二叉分割树/标签 chrome/DnD/面包屑（16–660）、createDocEditor 分发器（2046–2201）、patchViewContext（1963–2045）、文档生命周期与关闭确认/外部修改检测（4363–4754）。

拆分次序按耦合从低到高：E1（纯 Ace 钩子）→ E2（CSV，最大但域内自洽）→ E3（视图族，与核心分发纠缠最深）→ E4/E5（独立小域收尾）。

**分发器原则**：`enterXView / showXView / hideXView / leaveXView` 随各自视图域走；`createDocEditor` 与 `createDoc`（核心）改为经 ctx 惰性箭头调用各域的分发器。禁止核心直接引用视图域内部函数。

## 4. 阶段 M：main.js 第二阶段（4 批，7,473 → 约 4,400）

| 批 | 新模块 | 锚点区间 | ≈行数 | 内容 |
| --- | --- | --- | --- | --- |
| M1 | `dev/mock-backend.js` | 430–2310 | ~1,880 | dev mock 全家（mockBackend、mock 场景、样例数据、mockFindEntry 等）。**唯一非纯移动批**：见下 |
| M2 | `explorer-ops.js`（首选并入 `explorer.js`，接线超预期时退独立模块） | 3825–4427 | ~600 | 路径改码三函数、文件剪贴板、新建/重命名/删除对话框与菜单、explorer 右键菜单 |
| M3 | `editor-menus.js` | 4428–4648 | ~220 | 编辑器右键菜单（selectedText/ctxSelectAll/ctxFind/ctxFold/showEditorMenu/showBlankMenu/initContextMenus） |
| M4 | `structure-panel.js` | 4791–4930 + 5528–5750 | ~360 | 结构面板：解析 worker+缓存 + 面板接线/大纲快照/导出菜单 |

留守（~4,400）：标签核心状态、组合根接线（模块构造块）、设置/settings 对象、文档操作（保存/格式化/新建）、palette 与菜单注册表、init 尾段——均为方案 §2 目标声明的组合根职责。

**M1 动态加载（重要）**：现状 `const backend = hasWails ? window.go.main.App : mockBackend`（main.js:2281）把 mock 静态打进生产 bundle。改为：

```js
// main.js 顶层（index.html 以 type=module 引入，支持顶层 await）
let backend = hasWails ? window.go.main.App : null;
if (!hasWails) {
    ({mockBackend} = await import('./dev/mock-backend.js'));
    backend = mockBackend;
}
```

收益：生产 bundle 预计减 ~1,880 行源码（实施时对比 vite build 产物体积记录实际值）。行为微变仅 vite dev 场景（mock 延迟一拍加载），生产零影响。

## 5. 验证（每批固定，照 .cadt/memory/frontend-module-refactor-audit.md）

1. 三类静态扫描（deps 键一致性 / return 键 vs 调用方解构 / 裸引用+反向悬空）；脚本放 `.cadt/tmp-*.mjs` 用完即删。**必须做对照验证**：往旧版注入一个已知 bug 确认扫描能抓到，防止扫描脚本本身静默失效。
2. `npm test`（170 项）。
3. `npm run build`（vite；**不许用 `wails build -s` 跳过前端**）→ `wails build -devtools`。
4. 定向冒烟（按批）：
   - E1：JSON 大文件折叠 hover、python 文件多光标、Markdown 模式无残留注解
   - E2：CSV 排序/冻结列/列统计/虚拟滚动（大 CSV）/单元格编辑回写/表历史
   - E3：md 分屏滚动双向同步、svg 缩放、图片缩放、html 预览 base 注入
   - E4：SQL 查询跑一条、浏览器标签导航/视口菜单
   - E5：F11 书签、git gutter、AI 写入徽标、树右键展开折叠、md 块级复制、svg 导出 png
   - M1：**全部 mock 场景回归**（`?jsonl ?yaml ?csv ?text ?image ?large ?invalid ?multi ?empty ?gbk`）——动态 import 后必须逐个点开
   - M2/M3/M4：资源管理器新建/重命名/删除/右键、编辑器右键、结构面板大纲跳转/导出
5. 通用冒烟：开 3 种格式标签、切主题、设置保存；`debug-console.jsonl` 无新 error。

## 6. 风险与回滚

- E3 是纠缠最深处（分屏状态机 + 5 种视图的 enter/show/hide 交织）——若单批冒烟不过即 revert 单批，不影响已完成批次；必要时把 E3 再对半分（md+html+同步 / svg+image）。
- M1 是唯一改加载时序的批次：mock 场景回归清单必须全跑；`window.__mockCreated` 等全局副作用随迁后键名不变。
- 行号锚点漂移：每批动手前 grep 重定位；CRLF/紧凑行锚点用行号定位 Edit（既有教训）。
- 每批独立提交 `refactor(frontend): 拆出 <域>`，单批 revert 即回。
- 扫描基线：editor-groups 0 缩进闭包体与 ai-panel 不同，裸引用扫描的白名单/噪音过滤参数需按新文件调整，勿直接复用旧参数。

## 7. 预期终态

| 文件 | 现状 | 终态 |
| --- | --- | --- |
| editor-groups.js | 5,130 | ~1,900 |
| main.js | 7,473 | ~4,400 |
| 新增模块 | — | 8 个（E1–E5 五批 7 个 + M1–M4 四批 4 个，其中 E5/M2 各含一次合并决策） |
| 生产 bundle | 含 mock | 移除 mock（实测记录减量） |

完成后按惯例：AGENTS.md 目录清单同步、CHANGELOG 记录、方案移入 finished-plans。
