# AI 使用统计面板（设置 → AI → 使用统计）——方案与实施记录

> 状态：**已实施（2026-11-19）**。设置里新增「使用统计」页：累计 / 峰值 Token、最长聊天时长、
> 当前与最长连续天数、Token 活动热力图（每日/每周/累计）、每日 Token 趋势（多模型）、
> 模型用量环形图与排行；底部请求日志（供应商账号名 / 缓存 / 命中率 / 速度 / 首字 / 状态码）。
>
> 关键取舍：**打开面板不扫会话文件**。统计数据先落派生 SQLite，面板只做库内聚合。

## 1. 背景：为什么不能「打开时现扫」

会话 JSONL 是真源，但文件数量会随使用线性增长。原计划的「打开面板 → 遍历
`ai-sessions/**/session.v1.jsonl` → 现算」在会话多时会让面板明显卡顿，而且每次打开都重复
解析同样的文件。两个参考实现都不是这么做的：

- **ZCode**（`D:\OraSkyC\Project\OpenSource\ZCode`）：CLI runtime 在每个模型请求/轮次/工具
  调用发生时把事实写入全局 SQLite 的 `model_usage` / `turn_usage` / `tool_usage`，
  设置页经 Agent 进程做 SQL 聚合；不扫会话文件、不做回填、事实永久保留。
- **cc-switch**（`D:\OraSkyC\Project\OpenSource\cc-switch`）：代理请求同步写
  `proxy_request_logs`；本地 CLI 会话文件由「mtime + 字节偏移 + 尾部指纹」游标增量导入同一张表，
  启动扫一次 + 每 10 分钟兜底 + 打开页面时增量扫；30 天前明细 rollup 后剪枝。

本项目取两者交集：**前端流结束静默上报（ZCode 的主路径）+ 打开面板时带游标增量兜底
（cc-switch 的补齐路径，但不做启动回填与定时轮询）+ 查询时聚合**。

## 2. 总体设计

```
[前端三个流入口]
  ai-panel.finishStream          主会话每轮 usage
  ai-subagents.handleSubEvent    子代理每轮 ai-done 的 usage
  ai-group-runtime.persistSpeech 群聊成员/主持人发言的 usage
     └─》AIUsageStatsRecord(payload)         （静默、幂等、失败忽略）
                ↓
[Go internal/usagestats]  <appdata>/ai-usage.db
     ├─ usage_events        一条 assistant 回复 = 一行事实
     ├─ usage_sync_state    每个会话/群聊 JSONL 的字节游标
     └─ 打开面板 / 刷新     按打开动作做一次增量扫描（首次即历史回填）
                ↑
[启动/刷新] SyncAll() 扫描 ai-sessions/**/session.v1.jsonl
                        + ai-groups/*/session.v1.jsonl，只读新增行
                ↓
[面板] AIUsageStatsSnapshot(range) 只读库 + Go 内存聚合
```

统计范围是「用户可见的对话消耗」：主会话、子代理、群聊。自动标题、压缩摘要、命令分类器
这类内部调用不计入（它们是应用开销，不是聊天用量）。

幂等键按来源区分，保证前端上报与 JSONL 扫描对齐：

- 主会话 / 子代理：`sessionId + ":" + 消息 ts`（毫秒）；
- 群聊：`group:<groupId> + ":" + 消息 gid`（gid 是持久化的稳定 id，不依赖 ts 精度）。

同一条回复无论被哪条路径写入都只占一行，不存在翻倍。

## 3. 存储（派生库，可随时删除重建）

`<应用数据>/ai-usage.db`（modernc pure Go SQLite，与 `ai-index.db` / `ai-schedule.db` 同级）。

```sql
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,              -- "<sessionId>:<ts>"
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,              -- unix ms（assistant 消息创建时间）
  model TEXT NOT NULL DEFAULT '',
  model_account TEXT NOT NULL DEFAULT '',
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  turn_ms INTEGER NOT NULL DEFAULT 0,    -- 单轮耗时
  model_ms INTEGER NOT NULL DEFAULT 0,   -- 单次模型请求耗时（含首字等待）
  ttft_ms INTEGER NOT NULL DEFAULT 0,    -- 首字延迟
  status_code INTEGER NOT NULL DEFAULT 0 -- 成功流的 HTTP 状态码（0 = 未记录）
);
CREATE INDEX idx_usage_events_ts ON usage_events(ts);
CREATE INDEX idx_usage_events_session ON usage_events(session_id);

CREATE TABLE usage_sync_state (
  session_id TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_mtime INTEGER NOT NULL DEFAULT 0,
  prefix_hash TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
```

- `total_tokens` 缺失时回退 `prompt + completion`（写入时归一）。
- 负值/异常大值裁剪；模型名/账号名限长 200 字节。
- 事实**永久保留**：查询范围只是过滤条件，删除会话或截断历史不回收已计入的消耗
  （与 ZCode 一致：普通删会话不影响统计，彻底 purge 才级联删除）。
- 无 rollup 表：个人使用量级（万级行）一次读入并在 Go 内存聚合，毫秒级；将来变慢再加日汇总。
- `model_ms` / `ttft_ms` / `status_code` 是请求日志追加的列。老库启动时 `ensureDB` 逐个
  `ALTER TABLE`；只要成功补过 `usage_events` 的列，就清空一次 `usage_sync_state`，让下次
  打开面板按浏览器游标全量重读历史 JSONL（upsert 幂等，代价只在升级后的第一次打开）。
  状态码是本次新增的持久化字段，历史消息里没有，因此老记录显示「—」。

## 4. 增量扫描（兜底回填）

`collectSessionLogs()` 枚举两类真源：

- 主会话：分桶 `<ai-sessions>/<ws8>/<id>/session.v1.jsonl` 与旧平铺 `<ai-sessions>/<id>/session.v1.jsonl`；
- 群聊共享对话：`<ai-groups>/<groupId>/session.v1.jsonl`（平铺，行格式是 `kind:"msg"` 的扁平结构）；
- 子代理**没有**可扫描的 JSONL（消息只在内存，转录在 `ai-artifacts` 且不含 usage 明细），
  所以子代理依赖前端实时上报，见「已知边界」。

单文件语义（对齐 cc-switch 的 Claude 路径，游标额外带前 64 字节指纹）：

1. `size` 与 `mtime` 都没变 → 跳过（绝大多数文件走这条）。
2. 游标 `byte_offset` 越界（文件被截断）→ 从 0 重读；游标前 64 字节的短哈希与当前文件
   不一致（文件被 reset / 整份重写后又增长到超过旧 offset）→ 同样从头重读，绝不从新文件
   中间续读。
3. 从游标往后按行读，**只消费以 `\n` 结尾的完整行**；最后一行没写完就停，游标不推进，
   下一轮补全后重读。
4. 只解析两类行：主会话 `{"t":"msg","m":{"role":"assistant","usage":{...}}}`、
   群聊 `{"kind":"msg","role":"assistant","usage":{...}}`；正文/工具参数不解析。
5. 事实 upsert 与游标推进放在**同一事务**里提交。
6. 会话目录消失时清掉它的游标（误删只会多一次全量重读，幂等无害）。

触发时机：

- **只在用户打开「使用统计」面板时**跑一次增量同步（先渲染库里已有数据，同步完成后再刷新）；
- 首次打开会顺带完成历史回填；
- 面板「刷新」按钮再调一次 `AIUsageStatsSync()`；
- 没有启动回填、没有定时轮询——用户不打开面板就完全不扫文件。

多窗口并发写同一个库由 SQLite WAL + `busy_timeout=5000` 处理；upsert 幂等，重复扫描不重复计数。

## 5. 聚合口径

- **日界**：本机时区（`time.Local`），与用户看到的日历一致。
- **活跃日**：当天 token > 0（只有工具调用、没有模型 token 的天不算）。
- **当前连续天数**：从今天往前数连续活跃天数；**今天没有用量则为 0**（ZCode 口径）。
- **最长连续天数**：全历史最大连续活跃段。
- **峰值 Token**：单日 token 总量最大值，附峰值日期。
- **最长聊天时长**：取消息 `turnMs`（单轮耗时）的最大值；老数据没有 `turnMs` 时回退
  「会话内首末消息 ts 跨度」。不用跨度优先是因为跨天挂起的会话会被算成 24h，不是聊天时长。
- **累计 / 热力图**：全历史；**每日趋势 / 模型分布**：按 `range`（7d / 30d）过滤。
- 热力图最多回看 371 天（53 周）；更早的数据仍计入汇总指标，只是不画格子。
- 模型按 `model` 聚合（不区分账号，与 ZCode 一致）；趋势图只画前 6 个模型，其余不画。
- 子代理的事实 `sessionId` 是子代理自己的 id，群聊是 `group:<groupId>`；「会话数」包含它们。

## 6. 前端面板

`frontend/src/settings/settings-pane-usage-stats.js`

- 5 张指标卡：累计 Token / 峰值 Token / 最长聊天时长 / 当前连续天数 / 最长连续天数。
- **Token 活动**：CSS Grid 手写 53 周 × 7 天热力图（周日起），支持「每日 / 每周 / 累计」：
  每日每格独立着色；每周/累计每列一个值，按比例从底部往上填格。色阶 0–4 与 ZCode 同阈值
  （25% / 50% / 75%）。月份轴在前端按周首日计算并抽稀。悬浮用全局 tooltip（`data-tip-delay=0`）。
- **每日 Token 趋势**：ECharts 折线（懒加载，`ensureEcharts` 从 `core/chart-render.js` 导出），
  近 7 日 / 近 30 日切换；y 轴用 K/M 缩写，tooltip 显示完整千分位。
- **模型用量**：ECharts 环形图（前 5 + 其他）+ 排行列表（色点 / 模型 / Token / 占比），
  行悬浮显示输入/输出与请求数。
- 首次打开面板会自动导入历史会话：先显示库内已有数据，同步期间副标题显示
  「正在同步用量数据…」，完成后原地刷新。
- 纯函数在 `frontend/src/settings/usage-stats-model.js`（格式化 / 热力图网格 / 每周累计填充 /
  趋势序列 / 环形图切片），测试 `frontend/test/settings/usage-stats-model.test.mjs`。

### 请求日志（2026-11-19 追加）

面板最底部新增「请求日志」卡片，按 `ts` 倒序分页展示全部历史的每一次请求：

- 列：时间、供应商（`model_account`，即账号名）、模型、新增输入、输出、缓存命中、缓存写入、
  命中率、速度、首字、总耗时、状态码。每页 10 / 20 / 50 条，显示总记录数与页码。
- 口径：
  - 新增输入 = `prompt_tokens - cached_tokens - cache_write_tokens`（不小于 0）；
  - 命中率 = `cached_tokens / (新增输入 + cache_write_tokens + cached_tokens)`；
  - 速度 = `completion_tokens / ((model_ms - ttft_ms) / 1000)`，只算输出 ≥100 token 且
    生成窗口 ≥200ms 的请求，否则显示「—」；
  - 首字 = `ttft_ms`；总耗时 = `model_ms`；状态码 = 成功流的 HTTP 状态码。
- 命中率 / 速度 / 首字表头带 ⓘ 说明（全局 tooltip）；累计 Token 指标卡补「真实消耗」说明。
- 数据来源：主会话 `ai-done` 回传 `statusCode`，前端在 `reportUsageFact` 里连同
  `assistant.modelMs` / `assistant.firstTokenMs` 一起上报；子代理在每轮 `ai-done` 记录
  首字与请求耗时；群聊在 `persistSpeech` 用 `timing.totalMs` / `timing.ttftMs` 上报，
  供应商改用 `resolved.account.name`（旧消息缺账号时回退成员名）。会话/群聊 JSONL 扫描器
  也解析这些字段，用于历史回填。
- 查询：新增绑定 `AIUsageStatsRequests(offset, limit)`（只读库，`LIMIT/OFFSET` 分页 +
  `COUNT(*)`）；不把全部事实搬到前端。
- 注意：群聊一次发言跨工具轮时只落一条事实，`model_ms` 是整段发言耗时、`ttft_ms` 是
  第一次出字时间，速度按「首字到发言结束」计，包含工具轮间歇，属于偏低的端到端口径。

## 7. 清理

设置 → 存储与清理新增 `ai-usage` 数据条目（`LocUsageStats`，不进「一键清缓存」）：
子代理的用量只存在这个库里、没有 JSONL 可回填，一次误清会永久丢失；主会话与群聊的事实
下次打开统计面板时会按游标重新导入。删除前经 `BeforeClear` 调 `usagestats.Close()` 释放句柄。

## 8. 落地清单

- Go：`usage_stats_app.go`（四个绑定：Record / Snapshot / Sync / Requests）；`internal/usagestats/`
  （`usagestats.go` 类型与生命周期 · `store.go` 建表与读写 · `sync.go` 增量扫描 ·
  `aggregate.go` 纯聚合 · 单测）；`app_core.go` 主窗口启动 `Start()`；
  `internal/storage` 条目与位置常量；wailsjs 三件手写同步。
- 前端：`settings-pane-usage-stats.js` + `usage-stats-model.js`；`index.html` 导航与 pane；
  `settings-ui.js` 分发；`main.js` 接线；`ai-panel.js` 的 `finishStream`、
  `ai-subagents.js` 的 `handleSubEvent`、`ai-group-runtime.js` 的 `persistSpeech` 三处静默上报；
  `dev/mock-backend.js` 演示数据；`style.css` 面板样式；`chart-render.js` 导出 `ensureEcharts`。
- 测试：Go 单测覆盖上报归一 / 主会话与群聊 JSONL 解析 / 连续天数 / 范围过滤 / 热力图截断 /
  请求日志分页 / 增量游标（含追尾行、无变化、截断重写、群聊目录导入）；前端纯函数测试
  （含新增输入、命中率、速度、首字、时间、状态码格式化）；`npm test` 已登记。

## 9. 已知边界

- **子代理没有磁盘兜底**：子代理消息只活在内存，`ai-artifacts/<根会话>/sub-<id>.txt`
  只是纯文本转录、不含 usage；主会话 JSONL 里的 `agent.tokens` 只有最后一轮的总数。
  因此子代理依赖前端在每轮 `ai-done` 实时上报——正常使用不会漏，但应用崩溃/强杀时
  正在运行的子代理那一轮无法回填。群聊有共享 JSONL，兜底扫描可补。
- `turnMs` 是单轮耗时；「最长聊天时长」不是 ZCode 的「同会话所有轮次耗时求和」。
- 请求日志的历史「状态码」只在升级后新产生的请求里有值（旧 JSONL 没持久化状态码）；
  首字/请求耗时可以从旧消息的 `firstTokenMs` / `modelMs` 回填，没有的显示「—」。
- 群聊的 usage 跨工具轮只累计 `totalTokens`，prompt/completion 是最后一轮的；
  统计以 total 为准。请求日志的群聊速度按整段发言（含工具轮间歇）计算，偏低。
- 极端情况下同一会话同一毫秒产生两条 assistant 回复会共用幂等键（概率可忽略）。
- 无 rollup 与保留期：数据量到百万级时可再加日汇总表，事实表仍可重建。
