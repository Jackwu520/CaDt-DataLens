# 代码只读探查报告（2026-11-18）

> 范围：仓库当前代码（基准 `0fe8259b29`），在隔离工作区 `.cadt/worktree/bug-hunt-bo6je690/` 中完成只读审查，报告回写主根 `docs/reports/`。
> 本次为只读探查，未修改任何项目代码；临时验证文件已清理。所有结论均经源码复核，panic 与前端逻辑用 Go / Node 实测复现。

## 摘要

共确认 **4 个高置信度 bug**（2 高 / 2 中），另有 4 个中低危并发/一致性观察。工具/动作接线、虚拟文档接线、模块作用域等守卫测试实跑通过。

| 严重度 | 问题 | 位置 |
|---|---|---|
| 🔴 高 | 会话搜索摘要用小写化后的字节偏移切原文，特定字符触发越界 panic | `internal/sessionindex/sessionindex.go:410-447` |
| 🔴 高 | 自由聊天群模式在草稿层被改写，UI 无法创建自由聊天群 | `frontend/src/ai/ai-group-sidebar.js:496` |
| 🟡 中 | 快捷便签「下移」off-by-one，跳两格且末条无效 | `frontend/src/bridge/bridge-memo-view.js:526`、`:560` |
| 🟡 中 | 快捷便签折叠箭头点击无效 | `frontend/src/bridge/bridge-memo-view.js:254` + `frontend/src/bridge/memo-model.js:181-185` |

---

## 1. 【高】会话搜索可触发越界 panic

**位置**：`internal/sessionindex/sessionindex.go:410-447`（核心在 411、413、421、435、447 行）

```go
lowerText := strings.ToLower(text)          // 411
pos := strings.Index(lowerText, lowerQuery) // 413 —— pos 是 lowerText 的字节偏移
...
return prefix + text[start:pos] + "\x01" + text[pos:matchEnd] + "\x02" + text[matchEnd:end] + suffix // 447 —— 却用来切 text
```

**触发条件**：`text`（会话消息正文）中含 `Ⱥ`（U+023A）或 `Ⱦ`（U+023E）。Go 的 `strings.ToLower` 会把这两个 2 字节 rune 变成 3 字节 rune（U+2C65 / U+2C66），使 `len(lowerText) > len(text)`。此时 `pos`（lowerText 偏移）可能大于 `len(text)`；`matchEnd`、`end` 虽被 clamp 到 `len(text)`，`pos` 却没有，`text[start:pos]` 直接越界。

**复现实测**（遍历全 Unicode 码点 + 等价函数）：

```
expanding runes count=2: U+023A->"ⱥ"(2->3) U+023E->"ⱦ"(2->3)
text_bytes=23 lower_bytes=33 pos=30 pos>len(text)=true
PANIC: slice bounds out of range [:30] with length 23
```

**影响**：`AISessionSearch` / `AISessionSearchScoped`（`sessionindex_app.go:11-21`）同步调用链崩溃。非 FTS 分支（`sessionindex.go:496`）、简要模式都会调用它，触发面较大。即使不越界，`pos` 与 rune 边界错位也会切出非法 UTF-8 / 错误高亮。

**确定理由**：`pos` 来自 `lowerText` 的字节索引，却被用于切片 `text`；二者字节长度可不等（已实测确认存在此类字符且已复现 panic）。`matchEnd`/`end` 有 `> len(text)` 的 clamp，`pos` 独缺，是明确的边界遗漏。

**修复方向**：用 rune 切片或在原文上按大小写不敏感匹配定位偏移，确保切片索引始终来自 `text`；至少对 `pos` 补 `len(text)` clamp 并保证落在 rune 边界。

---

## 2. 【高】自由聊天群在 UI 路径完全不可达

**位置**：`frontend/src/ai/ai-group-sidebar.js:496`

```js
mode: createControls.mode.control.value === 'task' ? 'task' : 'roundtable',
```

**触发条件**：新建群聊弹窗「模式」下拉选择「自由聊天」（选项 `'free'` 定义于 `ai-group-sidebar.js:189`），点「创建群聊」。

**影响**：`'free'` 被静默改写成 `'roundtable'`。`collectCreateDraft()` 是唯一把草稿交给 `runtime.createGroup` 的路径（`:333-335`），而运行时本可正确处理 `free`（`ai-group-runtime.js:190`：`source.mode === 'free' ? 'free' : 'roundtable'`），但永远收不到。结果：自由聊天（消息即唤醒 / @点名 / @接力 / 上限 / 系统通知灰条）在真实 UI 路径完全不可达；群仍显示圆桌徽标与讨论控制按钮，发消息走 `isFree=false` 分支不接力。

**确定理由**：下拉含 `'free'`（`:189`）；`refreshModeVisibility()`（`:393`）、`refreshPreflight()`（`:468`）都专门按 `=== 'free'` 分支，证明设计要产出该值；全仓 `createGroup(` 的 UI 调用点仅此一处；现有测试直接传 `mode:'free'` 绕过草稿层故漏检。git blame：`:496` 早于自由聊天提交，后续提交只改了选项与显示逻辑，遗漏取值层。

**修复方向**：取值层保留 `'free'`，例如 `['task','free'].includes(v) ? v : 'roundtable'`。

---

## 3. 【中】快捷便签「下移」off-by-one

**位置**：`frontend/src/bridge/bridge-memo-view.js:526`（块下移）、`:560`（条目下移）

```js
run(view, (doc2) => updateById(doc2, blockId, {index: idx + 2}));   // :526
run(view, (doc2) => updateById(doc2, itemId, {index: idx + 2}));    // :560
```

**触发条件**：便签面板中对某块 / 某条目点「下移」。

**影响**：`memo-model.js:280` 的 `moveInArray` 是先 `splice(from,1)` 再 `splice(to,0)`，目标索引应传 `idx+1`；传 `idx+2` 导致下移跳过相邻一项。实测 4 项 `[A,B,C,D]` 下移 B（idx=1）得到 `[A,C,D,B]` 而非期望 `[A,C,B,D]`；末条下移时 `idx+2` 越界被钳到末尾，表现为「点下移没反应」。

**确定理由**：已用 Node 直接调 `updateById` 复现（`idx+2 → A,C,D,B`；`idx+1 → A,C,B,D`）；同文件上移用 `idx-1`（`:523`/`:557`）正确，下移应对称用 `idx+1`。AI 工具 `update_memo` 的 index 语义是「移到该位置（0 起）」（`ai-constants.js:312`），与 `moveInArray` 一致，证明是 UI 传参错误。

**修复方向**：两处 `idx + 2` 改为 `idx + 1`。

---

## 4. 【中】快捷便签折叠箭头点击无效

**位置**：`frontend/src/bridge/bridge-memo-view.js:254` + `frontend/src/bridge/memo-model.js:181-185`

```js
// bridge-memo-view.js:254
run(view, (doc) => updateById(doc, block.id, {collapsed: !block.collapsed}));
```

```js
// memo-model.js:181（块分支）
if (typeof patch.text === 'string') {
  block.title = ...;
  if (Object.prototype.hasOwnProperty.call(patch, 'collapsed')) block.collapsed = !!patch.collapsed;
}
```

**触发条件**：点击便签块的折叠箭头（chevron）。

**影响**：`updateById` 对块的 `collapsed` 只在 patch 同时带 `text` 时才写入；UI 只传 `collapsed`，调用返回 `ok:true` 但数据不变，广播重渲后箭头状态回弹——用户永远无法折叠 / 展开块。

**确定理由**：已用 Node 复现：`updateById(d, blk.id, {collapsed:true})` 后 `collapsed` 仍为 `false`；补上 `{text: blk.title, collapsed:true}` 才变 `true`。测试 `memo-model.test.mjs` 只覆盖了带 text 的块更新，未覆盖纯 collapsed patch。

**修复方向**：`memo-model.js` 块分支把 `collapsed` 的写入提到 `text` 判断之外（独立处理），或 UI 侧补传 `text`。

---

## 5. 中低危观察（未列为高置信度）

### 5.1 【中】外部工具配置跨进程读-改-写无锁

`internal/webtools/config_store.go:38-54` 的 `MergeAndSaveConfig` 无跨进程锁。`apiKey` 留空表示「保持原值」（`:51-52`），多窗口并发保存时，若 B 的 `LoadConfig` 早于 A 的 `SaveConfig`，B 会把旧 key 写回，回滚 A 刚设置的新 key。对比 sessionstore / activity 都用 `sessionlock.LockFile`。真实并发缺陷，但需特定同时操作时序。

### 5.2 【低】`activityPruneAt` 无锁竞态

`internal/activity/activity.go:42`（声明）、`:297`（读）、`:300`（写）。`pruneActivityFiles` 在 `appendActivityEntries` 释放 `activityMu` 之后才调用（`:383-384`），不在锁保护内；`go test -race` 可检出。后果限于节流记账失准，不损坏数据。

### 5.3 【低】`config.json` 非原子写

`internal/appconfig/appconfig.go:79` 直接 `os.WriteFile`，`Read()`（`:48-51`）对损坏 JSON 静默返回默认值。崩溃可致配置静默重置。代码注释表明是有意取舍。

### 5.4 【低】待清理标记读-改-写无跨进程锁

`internal/storage/clear.go:236-250`，`markPending` 无跨进程互斥，临时文件名固定为 `path + ".tmp"`。两窗口同时排入不同清理项时可能覆盖丢失一项。

---

## 6. 探查覆盖与验证

- 三路子代理并行排查 Go 后端、前端、存储会话层；前端另展开工具/动作接线、子代理信箱、群聊运行时三支细查。
- 守卫测试实跑通过：`test/ai/ai-tool-wiring.test.mjs`、`ai-app-actions.test.mjs`、`test/editor/virtual-doc-wiring.test.mjs`、`test/core/module-scope.test.mjs`。
- 存储相关 Go 包测试全绿：`atomfile / sessionlock / sessionstore / sessionindex / activity / aiworklog / aigroups / webtools / aiconfig / appconfig / storage`。
- 主代理独立核查了原子写、跨进程锁、JSONL 追加残行修复、补丁引擎两阶段提交、生图落盘、进程执行、回收站、编码转换、AI 重试限流等基础设施，未发现高置信度问题。
- 复现手段：高危 panic 用 Go 程序遍历 Unicode + 等价函数实测；前端 3 个 bug 用 Node 直接调纯函数复现。

---

## 7. 修复记录（同日 14:30 起）

| 编号 | 处理 | 落点 |
|---|---|---|
| 1 会话搜索越界 panic | 已修 | `sessionindex.go` 新增 `foldIndex()`：按 rune 逐位比较归约值定位，偏移由原文 `range` 的 rune 起点算出，`pos`/`matchEnd` 都来自 `text`；原先「ToLower 偏移切原文」整段删除 |
| 2 自由聊天群不可达 | 已修 | `ai-group-model.js` 新增 `normalizeGroupMode()` 单一来源（`GROUP_MODES` 白名单，其余回落圆桌）；草稿层、运行时 `createGroup`、`normalizeGroupMeta` 三处共用 |
| 3 便签下移 off-by-one | 已修 | `bridge-memo-view.js` 块/条目两处 `idx + 2` → `idx + 1` |
| 4 便签折叠箭头无效 | 已在工作树修复 | `memo-model.js` 的块分支把 `collapsed` 写入提到 `text` 判断之外（随 memo 面板改版一并落地），已有用例覆盖 |
| 5.1 外部工具配置无锁 | 已修 | `webtools/config_store.go` 给 `MergeAndSaveConfig` / `ClearDefaultAPIKey` 的读-改-写套 `sessionlock.LockFile`（`path+".lock"`，3s） |
| 5.2 / 5.3 / 5.4 | 未动 | 5.3 是注释里写明的有意取舍；5.2 / 5.4 只记账失准 / 极端并发丢一条待清理项，留待需要时再收 |

新增护栏：

- `internal/sessionindex/sessionindex_test.go`：`TestMakeSearchSnippetExpandingLowerRune`（20 个 `Ⱥ` 构造 `pos > len(text)`，旧实现在此 panic，已用旧函数实测确认）、`TestMakeSearchSnippetFoldsCase`。
- `frontend/test/ai/ai-group-model.test.mjs`：`normalizeGroupMode` 三值/回落 + 接线守卫（草稿层与运行时都必须经 `normalizeGroupMode`，且不得再出现 `=== 'task' ? 'task' : 'roundtable'`）。
- `frontend/test/bridge/memo-model.test.mjs`：`index` 目标下标语义（`idx+1` 换一位、`idx+2` 跳一格）+ `bridge-memo-view.js` 源码守卫（不得出现 `index: idx + 2`）。

验证：`go build ./...`、`go test ./internal/sessionindex/ ./internal/webtools/`、`gofmt`、`go vet` 通过；前端分 8 批跑完 1376 个用例，仅 `ai-app-message.test.mjs`（1）与 `ai-agent-notices.test.mjs`（2）失败——与本报告无关：并行会话正把投递文案由「来自用户」改成「来自你」，用例断言尚未跟上。

