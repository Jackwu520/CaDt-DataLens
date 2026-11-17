# 快捷便签面板（工作区/全局两份分组便签 + AI 经 app_control 读写）

> 状态：**已实施**（2026-11-18）。代码与测试全部落地（Go / 前端全绿，vite + wails build 通过），待 `wails dev` 手动冒烟后移入 `finished-plans/`。
> 修订记录：初版为「快捷 Todo 面板 + 4 个独立 quick_todo_* 工具」；2026-11-18 按作者决定改名「快捷便签」并把 AI 读写收进 app_control（初版判断是独立工具，复核后认同：低频、用户驱动、UI 属性强的功能不值得占 4 个工具位与目录文案）。

## 需求

- 快捷便签面板：可粘贴图、AI 可调用、添加 / 删除 / 修改；像 ipynb 那样**分块**；**工作区唯一 + 全局唯一**两份；打开后是内容区标签页；**活动栏有快捷入口**。
- 已确认设计：**块 = 分组小节**（块有小节标题，块内多条目）；AI 走 **app_control 动作**（初版的 reminder 式独立四工具已收编）。

## 架构

```
bridge-memo-view.js（视图 + doc 工厂 + 粘贴图 + 作用域切换）
    └─ memo-store.js（按作用域缓存 · 1s 防抖 · CAS 保存 · 变更广播）
          └─ memo-model.js（纯函数：归一化 / 增删改移 / 上限 / AI 文本格式）
                ↕ 同一套变更通路（store.mutate）
          main.js runAppAction（app_control 的 get_memo / add_memo / update_memo / remove_memo / open_memo_panel）
                ↕ Wails 绑定
memo_app.go（薄壳）→ internal/memo（Load / Save / SaveImage）
    工作区：<ws>/.cadt/memo/memo.json + img/      全局：<appdata>/memo/ 同构
```

## 数据模型

```json
{"version":1,"updatedAt":0,"blocks":[
  {"id":"blk-x","title":"阶段一","collapsed":false,
   "items":[{"id":"it-x","text":"…","status":"pending|in_progress|completed",
             "createdAt":0,"updatedAt":0,"images":["img/img-x.png"]}]}]}
```

- 状态枚举与会话 todo_write 一致（pending/in_progress/completed）；块 id 前缀 `blk-`、条目 `it-`。
- 上限：块 ≤50、块内条目 ≤100、条目文本 ≤500 字、块标题 ≤60 字、每条目图 ≤6、单图 16 MB、memo.json ≤512 KB。前端模型层统一执行，Go 只卡总量与图片字节。

## 关键决策

1. **多窗口 = 多进程**（`internal/newwindow` 拉起新实例），Wails 事件不跨窗口 → 同步走文件系统：
   - 保存带 **mtime CAS**（`Save(scope, workspace, doc, baseMtimeMs)`）：文件比读入时新即判冲突（毫秒级即算，「文件更旧」方向才有 2s 粒度放宽，FAT 类文件系统）；`baseMtimeMs==0`（载入时无文件）但文件已存在也判冲突。冲突 → 前端重载磁盘版本 + flash，不合并不覆盖。
   - 工作区作用域复用现有 `workspace-changed` watch 事件（`internal/watch` 保留 .cadt 事件），变更路径含 `/.cadt/memo/memo.json` 才重读；有未保存修改时跳过重读（让防抖保存的 CAS 去判，不丢用户正要写的内容）；全局作用域窗口 focus 时静默对账。
2. **结构级上限只在 Go 卡总量**：块/条目/文本上限归前端 `normalizeMemoData` 统一执行，Go 校验 JSON 合法性 + 512 KB 尺寸，避免两套口径。
3. **贴图只信魔数嗅探**（png/jpg/gif/webp/bmp），命名 `img-<unixnano36>.<ext>` 天然防覆盖；图片文件不随条目删除回收，孤儿图由「存储与清理」兜底。
4. **AI 走 app_control 而非独立工具**（修订）：低频、用户驱动的 UI 功能不值得占 4 个工具位；动作表在 cadt-ui 技能（先 `skill_use` 取动作表），app_control 的常驻 description 里点名便签动作族保证可发现性。**计划模式 per-action 拦截**放 ai-panel 的 app_control 分支（get_memo 只读放行，三个写动作拒绝）——工具级 PLAN_MODE_DENIED_TOOLS 无法按动作切分。
5. **AI 不自动注入便签内容**：便签是用户本子，每轮注入是噪音；AI 按需 `get_memo`。与 todo_write 的分工在 todo_write 描述、目录 blurb、调度原则、workspace_rules 四处双向写明（便签是用户的本子，执行进度是会话内的）。
6. **虚拟文档四处接线**照 browser/agentView 先例：`doc.memo`（bridge 建字面量）→ `createDocEditor` 分支（`deps.createMemoView(doc)`）→ `closeDocNow` 卸载（flush 未存修改）→ `viewOptionsFor` 返回 `[]`；守卫 `test/editor/virtual-doc-wiring.test.mjs` 自动对账。
7. **UI 与 AI 同一条变更通路**：视图全部经 `store.mutate(fn)`（缓存 + 防抖保存 + 广播），AI 五动作经 main.js runAppAction 调同一 memoApi——两边编辑互相可见，上限口径只有一份。
8. **自动保存的退出路径全覆盖**（作者要求「必须自动保存」）：① 每次改动 1s 防抖 CAS 落盘；② 便签 pending 计入应用关窗脏标记（`anyDirty` 经 `deps.memoHasPending` 并入，store 的 `emitPending` 钩子在 dirty 翻转的每个出口拉 `updateBackendDirty`）——Go `beforeClose` 在防抖窗口内也走 confirm-close；③ confirm-close 事件到达即 `flushAll`（弹确认框前已落盘，之后选哪个退出按钮都不丢）；④ 切工作区 / 关标签 / 切作用域先强制提交行内编辑再按**缓存捕获的旧工作区根**落盘；⑤ pagehide/visibilitychange 兜底。护栏 `test/bridge/memo-store.test.mjs`（防抖落盘 / flush / CAS 冲突重载 / 切工作区按旧根落盘 / flushAll / 失败保持 dirty / dirty 时跳过外部重载）。

## 改动清单

**Go**：`internal/memo/memo.go` + `memo_test.go`（load 默认/往返/CAS 冲突/图片 mime 与超限/坏 JSON 兜底）、`memo_app.go`（MemoLoad / MemoSave / MemoSaveImage）、`internal/storage/specs.go`（`ws-memo` / `memo` 两条目）、`frontend/wailsjs/` 三件。

**前端**：
- 新增 `src/bridge/memo-model.js`（纯函数，测试 `test/bridge/memo-model.test.mjs`）、`src/bridge/memo-store.js`、`src/bridge/bridge-memo-view.js`。
- 接线：`editor-groups.js`（createDocEditor / closeDocNow / memoTabIcon）、`writing-ui.js`（viewOptionsFor）、`core/icons.js`（memo 图标）、`core/keybindings.js`（`file.newMemo` = Ctrl+Alt+M）、`main.js`（菜单项 / keymap / 活动栏 / workspace-changed / focus / 切工作区 / APP_ACTIONS+runAppAction 五动作）、`index.html`（活动栏 `ab-memo`）、`style.css`（`.memo-*`）、`dev/mock-backend.js`（三绑定 mock）。
- 复用抽取：`dataUrlToFile` 从 ai-composer 抽到 `core/image-clipboard.js`（两处共用）。

## 手动冒烟清单（待做）

1. 活动栏 / 菜单 / `Ctrl+Alt+M` / 命令面板 / AI `open_memo_panel` 五个入口都能打开面板。
2. 加块 / 加条目 / 改状态 / 行内编辑 / 上下移 / 跨块移动 / 删块（二次确认）/ 折叠；`Ctrl+V` 贴图与右键贴图；缩略图灯箱与移除。
3. 切工作区 ↔ 全局作用域：数据各一份、切走前 flush；无工作区时工作区档置灰提示。
4. AI：让模型 `get_memo` → `add_memo` → `update_memo`（改状态）→ `remove_memo`，面板实时刷新；计划模式下写动作被拒、get_memo 可用。
5. 双窗口同工作区编辑：后保存方收到冲突提示并重载。
   5a. 自动保存退出路径：改完 1s 内直接关窗口 → 应弹关窗确认（便签 pending 计入）；确认框弹出后无论选哪项，重开面板内容都在；行内编辑打字到一半关标签 / 切作用域 / 切工作区，文字都应已提交落盘。
6. 重启：两作用域数据与贴图仍在；存储与清理页能看到「快捷便签」两个条目。
