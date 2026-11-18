# AI 会话存储按工作区短哈希分桶（方案）

> 状态：**待开工**（2026-11-19 初稿）
> 动机：`<appdata>/ai-sessions` 现为全平铺，资源管理器里分不清哪个会话属于哪个项目，也无法按项目整体备份/删除/迁移。
> 决策：
> 1. **桶名 = 工作区解析根的短哈希**（sha256 前 8 hex），与 `workspace-wipe-guard.md` §4.1 的 `ws` 字段（`"ws":"d3b0738f"`）**同一约定同一算法**——两处按工作区分命名空间的数据共享一条规则。
> 2. **桶化 opt-in**：`internal/aigroups` 复用 `sessionstore.New` 且目录按 groupId 平铺（`internal/aigroups/aigroups.go:6`），桶化逻辑不能无条件烘焙进引擎。
> 3. **meta.workspace 仍是归属真源**：桶只是磁盘布局，UI 分组 / 串台护栏 / 跨工作区搜索全走 meta，哈希碰撞不产生逻辑错误。
> 范围：`internal/sessionstore`（桶化布局 + 迁移 + 双读）· `resource_watch_app.go`（监听路径）· `internal/storage`（统计遍历）
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

## 4. Go 侧改动

- **引擎 opt-in**：`sessionstore.New(root)` 保持平铺语义不动（aigroups 继续用）；新增 `NewBucketed(root)`（或等价 option）供 `sessionstore_app.go` 挂载 ai-sessions 时启用。桶化只改三个点：
  1. `dir(id)`：id → 目录的解析。List 时顺带建 `id → 桶目录` 内存索引；miss（如冷启动直接 `AISessionWatch(id)`）时扫桶层兜底。桶数为工作区数，个位/十位，扫描代价可忽略。
  2. `List`：两层遍历——桶层全扫 + 根层散落 `session-*`（兼容双读，见 §6）。
  3. 新建会话：按 meta.workspace 算桶落位；桶不存在则建目录 + 写 `ws.json`。
- 不动：锁与租约（`sessionstore.go:159` 全在根层）、`atomfile` 原子替换、回收站删除、`synthesizeMetaFromHeader`（迁移时复用）。
- 调用方跟进：`resource_watch_app.go` 的 `AISessionWatch/Unwatch` 路径解析（`AISessionStat` 等按 id 走引擎方法，自动跟随）；`internal/storage` 的占用统计改为遍历桶层；`sessionindex` 走 `List` 最小接口，透明。
- 归属 Go 的哈希函数：`WorkspaceBucketKey(ws string) string` 放 `internal/sessionstore`，与前端共享测试向量。

## 5. 迁移（存量收编）

- 时机：首个实例 startup，桶化引擎初始化时执行一次。
- 步骤：根门闩（`<root>.gate` 写权）下扫根层 `session-*` → 读 `meta.json` 取 workspace（缺 meta 则 `synthesizeMetaFromHeader` 从 header 补）→ 算桶 → `os.Rename` 进桶 → 空桶补写 `ws.json`。
- 占用跳过：Windows 下目录有打开句柄时 rename 报 sharing violation——跳过该目录留待下次启动再收编（另一实例正开着这个会话，跳过是唯一正确动作）。
- 幂等与标记：`layout-buckets-v1` 标记文件免每次重扫；标记写入前崩溃 = 下次重扫，rename 幂等故无害；迁移中途失败不阻断启动（日志 + 下次重试）。
- 收尾：迁移完成后 `sessionindex` 无需重建（行内是 workspace 路径，值未变）；核对一次即可。

## 6. 新旧版本兼容

- **新 exe 读旧布局**：List 永远附带扫根层散落 `session-*`（成本：根层通常为空，一次 readdir）。旧 exe 混用期间新写的会话落在根层，下次新 exe 启动被收编进桶。
- **旧 exe 读新布局**：旧版只扫根层，桶内会话不可见（列表为空）。便携单 exe 新旧混用属少见场景，**接受**并在 CHANGELOG 注明；不做「写双份」。
- 写方向恒定：新 exe 一律写桶层，不写根层。

## 7. 测试

- Go 表驱动 `sessionstore`：哈希向量（含大写/反斜杠/尾斜杠/空串→`_unbound`）、两层 List、新建落位、`ws.json` 写入、迁移幂等（跑两遍结果一致）、rename 失败（模拟占用）跳过待下次、双读（根层 + 桶层混存）。
- 前端 `test/ai/`：同一条共享测试向量断言 `aiWorkspaceKey` 语义与 Go 端一致（锁两端不漂移）。
- `crossplatform_guard_test.go` + `tools\check-crossbuild.cmd` 照例守平台无关性（哈希与 rename 均为平台无关代码）。

## 8. 实施步骤

1. **P1 引擎**：`WorkspaceBucketKey` + `NewBucketed`（dir 解析 / 两层 List / 新建落位 / `ws.json`）+ Go 测试。
2. **P2 迁移与兼容**：startup 收编流程 + 标记文件 + 双读 + 前端共享向量测试。
3. **P3 收口**：`resource_watch_app.go` 路径、`internal/storage` 统计遍历、`sessionindex` 核对、CHANGELOG；随手验证存储清理对桶层的删除。

## 9. 明确否决的方案

- **Claude Code 式转义路径作桶名**（`projects/D--OraSkyC-...`）：非法字符转义规则繁琐、`a/b` 与 `a-b` 转义后碰撞、深路径名超长；可读性由 `ws.json` 补足，且 wipe-guard 已定短哈希约定，没有理由两套。
- **根级 `buckets.json` 中央映射**（hash → 路径）：与桶目录状态易漂移；`ws.json` 放桶内自带即自洽。
- **更长短哈希做碰撞处理**（8 → 12/16 hex 动态延长）：有状态规则、两端实现易漂移，换来的保护对桌面工作区量级无意义；碰撞已论证为无害。
- **桶化无条件烘焙进 `sessionstore.New`**：破坏 aigroups 按 groupId 平铺的既有布局（`aigroups.go:6`）。
