# 存储与清理：定期 / 按大小自动清理缓存

> 状态：**已实施**（2026-11-18，前端驱动方案照原文落地，Go 侧零改动）。前端测试全绿、vite build 通过，已移入 `finished-plans/`（文末冒烟清单可作验收参考）。
> 实施记录：活动留痕走前端 `activityLog`（actor=system，action=`storage.auto_clean`），`ACTIVITY_DOMAINS` 与设置页「操作记录」筛选下拉补了「存储」域；其余按方案原文。
> 范围：设置 → 存储与清理 pane 增加自动清理开关与两个触发条件；清理执行复用现有 `internal/storage` 引擎与两个绑定，**Go 侧零改动**（规划结论，实施前复核）。

## 需求

缓存（运行临时副本、浏览器缓存、日志、索引等）会持续增长，目前只能手动进设置页点「一键清缓存」。增加自动化：**定期触发**或**大小触发**，任一满足即自动清理。

## 现状（代码事实）

- 条目表单一事实来源：`internal/storage/specs.go` 的 `specs()` 表，`kind`（cache/data/danger）+ `inCache` 决定「一键清缓存」范围 = `CacheIDs()`（13 项，`specs.go:298-306`）；`TestMustNotBeCached`（`storage_test.go:197-206`）钉死 12 个绝不进缓存清理的 id。
- 清理引擎：`Clear(ids, workspaceRoot)`（`clear.go:42`，互斥锁串行、表外 id 拒绝、缓存直删、数据条目强制回收站）；`webview-cache` 因 WebView2 运行中锁定只写 `.pending-clean` 标记、下次启动前执行（`main.go:74` → `ApplyPending`）。
- 前端绑定只有两个：`StorageScan(workspaceRoot)` / `StorageClear(ids, workspaceRoot)`（`storage_app.go:121-129`）；扫描有 30 万条目预算（`ScanMaxEntries`），`Report.Items[].Bytes` 可直接求和出缓存总量。
- 设置页 pane 无任何用户设置项；存储相关设置的既有先例是 `activityRetentionMonths`（默认值 `main.js:1405`、控件回填 `settings-ui.js:584`、**前端每次调用把值带给 Go**，`core/activity-log.js:112`）——设置存 localStorage、Go 不读配置。
- 手动「一键清缓存」会带 `browser-profiles`（确认文案明说「网页登录态会一并清除」）与 `webview-cache`；两者对自动清理都要区别对待（见下）。

## 行为定义

一个开关 + 两个触发条件（**任一满足即清**，都以「通过检查的时间点」为准）：

| 设置项 | 存储 | 默认 | 取值 |
|---|---|---|---|
| `storageAutoClean` | localStorage settings | `false` | 开关 |
| `storageAutoCleanDays` | 同上 | `7` | 每天(1) / 3 天 / 每周(7) / 每月(30) / 仅按大小(0) |
| `storageAutoCleanMB` | 同上 | `500` | 100 / 200 / 500 MB / 1 GB / 2 GB / 仅按时间(0) |

检查时机：**应用启动后 2 分钟** + **运行中每 6 小时**（前端 setInterval；最小化被 WebView2 节流只意味着检查延后，无害）。每次检查走 `StorageScan` → 求和缓存条目 → 判定 → 命中则 `StorageClear(安全子集, "")` → 记 `storageAutoCleanLastAt` → 消息中心提示。

**清理范围 = `CacheIDs()` 的安全子集**（自动清理的口径比手动更保守）：
- **排除 `browser-profiles`**：内嵌浏览器实例数据含网页登录态，自动静默清除等于不定时把用户登出网站——手动清理有确认文案兜底，自动清理没有。只留手动。
- `webview-cache` 保留：白名单只含纯缓存目录（登录态在 Local Storage/Network，不在表内），清除走 pending 标记下次启动生效，报告里体现为「已排下次启动」。
- 其余缓存项（run-temp / session-index / app-logs / debug-console / ai-logs / model-catalog / builtin-skills / builtin-mcp-samples / temp-scratch / ws-worklog / ws-tmp）照常：全部可再生，与「一键清缓存」同源同语义。
- **data/danger 条目永不进自动清理**——由「显式传安全子集 id 列表」保证，不依赖 Go 侧兜底。

## 关键决策

1. **前端驱动，Go 侧零改动**。检查、判定、执行全部复用两个既有绑定；不扩 `appconfig.Config`、不新增绑定。理由：应用存活 ⇔ 主窗口存活（关窗即退出），前端定时器覆盖全部运行期；清理精度不需要秒级，节流无害；设置留 localStorage 与 `activityRetentionMonths` 先例一致，设置页读写零成本。**代价**：多窗口同工作区可能并发触发——`Clear` 有互斥锁且缓存直删幂等，最坏重复清一次，无害（`storageAutoCleanLastAt` 先写后清的顺序把窗口缩到毫秒级）。
2. **「定期」语义 = 距上次清理的天数**，不是固定钟点：`now - lastAt >= intervalDays` 即触发（`lastAt` 存 localStorage，跨窗口共享）。没有「每次启动都清」档——启动检查已有 `.pending-clean` 执行与各模块的启动清理（`CleanupRunTempStale` 等）兜底，这里只做增长控制。
3. **判定逻辑抽纯函数**：`shouldAutoClean({now, lastAt, intervalDays, cacheBytes, thresholdMB})` 与 `autoCleanScope(reportItems)`（过滤 exists + 排除 browser-profiles）放 `settings-pane-storage.js`（或其伴生纯函数文件），进现有测试文件。触发时不弹确认框——安全性由范围保证（全部为可再生缓存且排除登录态）。
4. **用户反馈走消息中心**（`src/shell/message-center.js`），不走 flash（5 秒自动清空，后台动作会被错过）：文案含释放量、排下次启动的项、跳过项；同时 `logFrontend` 记诊断日志。**activity 留痕**：经 `activity-log.js` 记一条 `storage.auto_clean`（actor=system），只记摘要（释放量/项数），与「只存操作摘要」的留痕约束一致。
5. **UI 放「存储与清理」pane 顶部**一个三控件区块（开关 + 频率下拉 + 阈值下拉），全部用 `createSwitch` / `createSelect`（表单控件硬规范），行元素用 `.set-row` 让设置搜索自动收录；`storageAutoCleanDays=0` 或 `storageAutoCleanMB=0` 时对应下拉显示「仅按大小」/「仅按时间」，两条件互为开关，不另加开关项。
6. **清理期间打开设置页**：自动清理与手动清理共用 `Clear` 互斥锁，天然串行；无需额外互斥 UI。扫描结果刷新后 pane 显示会自然对齐。

## 改动清单

**前端**（规划目标：无 Go 改动、无 wailsjs 重新生成）：
- `src/settings/settings-pane-storage.js`：自动清理区块 UI（三控件 + 渲染）；导出纯函数 `shouldAutoClean` / `autoCleanScope` / 提示文案拼装。
- 新增 `src/settings/storage-autoclean.js`：驱动器（启动延时检查 + 6h ticker + 执行 + lastAt 维护 + 消息中心/留痕接线），main.js 组合根接线（factory + getter deps，不依赖 pane 是否打开过）。
- `frontend/index.html`：storage pane 顶部区块骨架。
- `main.js`：`defaultSettings` 三项默认值 + 存量归一；创建驱动器并传入 getter。
- 纯函数测试进 `frontend/test/settings/settings-pane-storage.test.mjs`（`shouldAutoClean` 判定表：间隔/大小/双关/未到间隔但超大小/从未清理过；`autoCleanScope` 排除与过滤）——已在 npm test 清单内，无需登记新文件。
- CHANGELOG.md、README 存储小节。

## 实施注意 / 风险

- **R1 `StorageScan` 代价**：全条目走盘统计（30 万条目预算封顶）。6h 一次可接受；启动检查延后 2 分钟避开启动 IO 高峰。
- **R2 `session-index` 被清后**：下次搜索触发索引重建（派生库，JSONL 真源不受影响），首次搜索变慢属预期，消息文案不承诺「无感知」。
- **R3 `webview-cache` 的 pending 标记**：自动清理写标记后、下次启动执行——若用户长期不重启，标记持续累积到下次启动一并执行，行为正确。
- **R4 多窗口时钟**：`lastAt` 取各窗口本机时间（同一台机器同一时钟），无跨设备问题。
- **R5 前端定时器节流**：最小化时间隔触发可能漂移到下一个可见窗口时机——只影响触发时刻精度，不影响正确性；不为此上 Go 侧 ticker（复杂度不值）。

## 手动冒烟清单（实施后）

1. 开启自动清理、频率设「每天」、阈值设「仅按时间」→ 手动把 `storageAutoCleanLastAt` 改到 8 天前 → 约 2 分钟后（或重启后）缓存被清、消息中心出提示、activity 留痕出现 `storage.auto_clean`。
2. 阈值触发：塞大文件进运行临时副本使缓存超阈值 → 检查后自动清理。
3. 内嵌浏览器开着网页登录某站 → 自动清理触发后该站登录态仍在（browser-profiles 未被动过）。
4. 自动清理运行中打开设置页 → 手动「一键清缓存」仍可用（串行不报错），统计数字对齐。
5. 关闭开关 → 不再有任何后台检查动作。
6. WebView2 项：自动清理后重启应用 → 启动前日志显示 pending 执行结果。
