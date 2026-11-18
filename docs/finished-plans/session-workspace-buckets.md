# AI 会话存储按工作区短哈希分桶（方案）

> 状态：**已实施**（2026-11-19 初稿并当日落地；迁移不进程序——由作者用 `tools/migrate-session-buckets` 在应用关闭后手动执行一次，不向前兼容旧布局）
> 动机：`<appdata>/ai-sessions` 现为全平铺，资源管理器里分不清哪个会话属于哪个项目，也无法按项目整体备份/删除/迁移。
> 决策：
> 1. **桶名 = 工作区解析根的短哈希**（sha256 前 8 hex），与 `workspace-wipe-guard.md` §4.1 的 `ws` 字段（`"ws":"d3b0738f"`）**同一约定同一算法**——两处按工作区分命名空间的数据共享一条规则。
> 2. **桶化 opt-in**：`internal/aigroups` 复用 `sessionstore.New` 且目录按 groupId 平铺（`internal/aigroups/aigroups.go:47`），桶化逻辑不能无条件烘焙进引擎。
> 3. **meta.workspace 仍是归属真源**：桶只是磁盘布局，UI 分组 / 串台护栏 / 跨工作区搜索全走 meta，哈希碰撞不产生逻辑错误。
> 4. **无迁移代码、无双读兼容**（作者裁定）：写恒入桶；查找按 id 扫桶，「现存目录永远赢」——载荷/参数里的 workspace 只在目录尚不存在时参与落位。
> 范围：`internal/sessionstore`（桶化布局）· `AISessionSaveImage/SaveVideo` 加 workspace 参数 · `ai-session-disk.js` 传参 · 前端 `aiNormalizePath/aiWorkspaceKey` 移出 ai-panel 到 `ai-session-scope.js`（可测）· 哈希向量两端测试互锁
> 非范围：把会话存进工作区目录（隔离在工作区破坏半径之外，平铺方案已论证）· 修改 UI 分组逻辑（`ai-session-list.js` 已按工作区分组，不动）· 群聊存储布局（`ai-groups` 按 groupId 平铺维持现状）· 桶名转义路径（见 §9）

## 1. 背景与代码事实

- 现状布局：`<appdata>/ai-sessions/session-<id>/{meta.json, session.v1.jsonl, images/, videos/, ...}`，全平铺（实测 126 个会话目录同层）。
- 每个会话两处记录工作区：`meta.json` 与 JSONL header（`internal/sessionstore/sessionstore.go:358`），值为建会话时的解析根，正斜杠形如 `D:/OraSkyC/...`。
- **工作区创建后不再变**：仅 `ai-panel.js:1755` 新建会话时写一次 `workspace: currentWorkspacePath()`；`ai-session-disk.js:322` 的 `patch.workspace` 只是「变了才写」的去重。不存在「换归属要跨桶搬目录」的需求。
- 前端归一化语义现成：`aiWorkspaceKey`（`ai-panel.js:5807`）= `\`→`/`、去尾斜杠、lowercase——Windows 盘符大小写不敏感靠它解决。
- 锁与租约都在会话目录之外：回合租约 `<root>/.locks/<id>.turn.lease` + 根门闩 `<root>.gate`；写路径短租约锁文件在会话目录**内**（`sessionstore.go:217`），随目录走。桶化不影响锁。
- `AISessionWatch` 盯的是**单个会话目录**（`resource_watch_app.go:53`），不是根目录，桶化只改路径拼接。
- `sessionindex` 行存的是 `workspace` 路径字符串（来自 meta），不存目录路径；`List` 语义不变则索引无需迁移。
- `internal/storage` 的占用统计需遍历 `ai-sessions`，要跟上两层布局。

## 2. 目标与非目标

**目标**
- 资源管理器里按工作区一眼分桶；删除/备份/迁移一个项目的会话 = 删/拷一个桶目录。
- 与 wipe-guard 的 `ws` 短哈希约定对齐，避免两套「工作区→目录」规则。
- 存量会话一次性迁移；新旧版本混用期间不丢数据。

**非目标**
- 不改前端：侧边栏分组（`ai-session-list.js:333`）、串台护栏（`ai-session-scope.js`）、跨会话检索全部走 meta.workspace，零改动。
- 不做桶内按时间/月份再分桶（会话数远没到需要的时候）。
- 不提供「把会话挪到另一个工作区」的功能（现状没有，桶化也不引入）。

## 3. 数据布局与哈希规则

```text
<应用数据>/ai-sessions/
├── d3b0738f/                      # 桶 = sha256(归一化工作区 key) 前 8 hex
│   ├── ws.json                    # {"workspace":"D:/OraSkyC/..."} 桶内说明文件（资源管理器可读、迁移/校验用）
│   └── session-<id>/...           # 会话目录原样（meta.json / session.v1.jsonl / images / videos）
├── _unbound/                      # workspace 为空的会话（无工作区窗口所建）
│   └── session-<id>/...
├── .locks/<id>.turn.lease         # 原地不动（按 id，不在会话目录内）
├── <root>.gate                    # 原地不动
└── session-<id>/                  # 过渡期兼容层：旧布局散落目录，见 §6（迁移后被收编，正常情况为空）
```

- **哈希输入**：归一化 key，语义与前端 `aiWorkspaceKey` 对齐——`aiNormalizePath`（`\`→`/`，忽略 URL scheme 分支）→ 去尾 `/` → lowercase。
- **哈希算法**：sha256 前 8 hex，与 `workspace-wipe-guard.md` §4.1 示例 `"ws":"d3b0738f"` 一致。**测试向量两端共享**：同一条 key → 同一个桶名，Go 测试与前端测试各断言一遍，防止两边漂移。
- **碰撞取舍**：8 hex = 32 bit，n 个工作区碰撞概率约 n²/2³³（50 个 ≈ 2.9e-7）。桌面应用工作区量级为个位/十位数，接受不做处理；碰撞后果仅是磁盘混桶，meta.workspace 仍为归属真源，UI/搜索/护栏零影响。
- **空工作区**：key 为空的会话落 `_unbound`（`_` 开头与 8 hex 桶名天然区分）。
- **`ws.json` 说明文件**：桶内放工作区原路径，解决「哈希目录名在资源管理器里不可读」；创建桶时写入，若内容与计算不一致视为校验信号（日志告警，不阻断）。

## 4. Go 侧改动（已落地）

- **引擎 opt-in**：`sessionstore.New(root)` 保持平铺语义不动（aigroups 继续用）；`NewBucketed(root)` 供 `Default()`（ai-sessions）启用。桶化只改四个点：
  1. `dir(id)`：平铺直拼；桶化按 id 扫桶（`resolveBucketedDir`，每桶一次 Stat，桶数 = 工作区数）。
  2. `withSessionLock(id, workspace, allowCreate, fn)`：**现存目录永远赢**（先扫桶，命中即用，workspace 不参与）；`allowCreate` 且扫桶未命中才按 workspace 派生桶落位（`ensureBucketDir` 建桶 + 写 `ws.json`）；非创建路径未命中一律 `ErrSessionGone`，绝不复活目录。平铺分支行为不变。
  3. `AppendWithCreate`：桶化 + allowCreate 时从载荷**首行 header 解析 workspace**（`workspaceFromHeader`；前端保证新会话首次落盘必以 header 开头），解析不出落 `_unbound`。
  4. `List`：桶化下两层遍历（桶 → 会话），meta 缺失仍走 `synthesizeMetaFromHeader` 兜底。
- **附件落盘的时序坑（实测发现）**：新会话带附件时 `prepareImages` 让 `AISessionSaveImage/SaveVideo` **先于**正文 header 落盘——归属只能由调用方传入。两个绑定加第 4 参 `workspace`，且**路径解析挪进锁内**（锁外扫桶对新会话必然失败）；随后的 header 追加靠「现存目录赢」收敛到同一目录（`TestServiceBucketedImageFirstPersist` 钉住）。
- 不动：锁与租约（全在根层 `<root>/.locks/`）、`atomfile` 原子替换、回收站删除、`RemoveAll` 整根改名回收、`resource_watch` 的 `AISessionWatch`（走 `SessionDir(id)` 自动跟随）、`internal/storage`（`filepath.WalkDir` 递归统计天然兼容）、`sessionindex`（只依赖 `List/Read`，行内存 workspace 字符串）。
- `WorkspaceBucketKey` 导出在包内，迁移工具与测试共用。

## 5. 迁移（手动一次性，不进程序）

- 时机：新 exe 构建通过后、首次启动前，**应用关闭**状态下由作者手动执行。
- 工具：`tools/migrate-session-buckets`（`go run ./tools/migrate-session-buckets` 演练，`-apply` 实际搬移）——导入包内 `WorkspaceBucketKey` 保证与引擎同一哈希；读 meta.json 的 workspace（缺失回退正文首行 header），建桶 + 写 `ws.json` + rename；占用目录（另一实例开着）报失败跳过，等下次执行补收。
- 迁移后核对：桶数、每桶 `ws.json`、`_unbound` 里无意外会话。

## 6. 兼容性（不向前兼容）

- 无迁移代码、无双读：List 只认桶层（`_unbound` + 8 hex）；根层散落的旧布局会话对新 exe **不可见**。因此顺序铁律：**先迁移、后启动新 exe**。
- 旧 exe 读新布局同样不可见（只扫根层）——便携单 exe 混用旧版本会「丢」会话，已在 CHANGELOG 注明。
- 「现存目录永远赢」的扫桶解析天然容忍目录被外部挪动：迁移后旧 id 继续可解析。

## 7. 测试

- `internal/sessionstore/bucket_test.go`：哈希向量（反斜杠/尾斜杠/大小写/叠斜杠/点段/URL scheme/空白→`_unbound`/裸根斜杠→`_unbound`）、`isBucketDirName`、两层 List、现存目录赢、附件先落盘收敛同桶、非创建路径 `ErrSessionGone` 不建目录、Remove 幂等 + 墓碑、平铺回归。
- `service_test.go`：Service 层附件先落盘端到端（`TestServiceBucketedImageFirstPersist`）+ SaveImage/SaveVideo 新签名。
- 前端 `test/ai/ai-session-scope.test.mjs`：同一向量表用 `node:crypto` 复算 sha256 前 8 hex，与 Go 侧互为镜像（改任一侧必须同步另一侧）；`aiNormalizePath/aiWorkspaceKey` 移出到 `ai-session-scope.js` 后可测。
- 平台无关代码照例受 `crossplatform_guard_test.go` + `tools\check-crossbuild.cmd` 守护。

## 8. 实施记录（2026-11-19 当日完成）

1. 引擎：`WorkspaceBucketKey` + `NewBucketed` + 扫桶解析 + 现存目录赢 + 两层 List。
2. 绑定：`AISessionSaveImage/SaveVideo` 加 workspace、路径解析进锁内；前端 `ai-session-disk.js` 传 `session.workspace`。
3. 前端纯函数：`aiNormalizePath/aiWorkspaceKey` 移出 ai-panel 到 `ai-session-scope.js`（ai-panel 经 import 别名沿用原名）。
4. mock-backend 两个签名补第 4 参。
5. 测试全绿（Go 全量 54 包 / 前端 1451 项）→ 构建 → 手动迁移存量会话。
6. 迁移执行记录（2026-11-19 00:48，应用已关闭）：130 个会话全数入桶（`35dc7bd8` ×127 本项目、`00ecb8f9` ×3 日记星辰）、0 跳过；`-verify` 走真实引擎核对 List 130 / 按 workspace 反算桶名零错位。

## 9. 明确否决的方案

- **Claude Code 式转义路径作桶名**（`projects/D--OraSkyC-...`）：非法字符转义规则繁琐、`a/b` 与 `a-b` 转义后碰撞、深路径名超长；可读性由 `ws.json` 补足，且 wipe-guard 已定短哈希约定，没有理由两套。
- **根级 `buckets.json` 中央映射**（hash → 路径）：与桶目录状态易漂移；`ws.json` 放桶内自带即自洽。
- **更长短哈希做碰撞处理**（8 → 12/16 hex 动态延长）：有状态规则、两端实现易漂移，换来的保护对桌面工作区量级无意义；碰撞已论证为无害。
- **桶化无条件烘焙进 `sessionstore.New`**：破坏 aigroups 按 groupId 平铺的既有布局（`aigroups.go:6`）。
