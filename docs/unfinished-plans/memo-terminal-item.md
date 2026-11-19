# 便签终端条目（kind=term）方案

> 2026-11-19 立项并实施。目标：便签面板新增【终端】条目——条目正文是命令，行首运行按钮
> 运行，输出实时渲染在条目下方；**不支持挂起任务**（npm run dev 这类到点杀树）。

## 1. 需求与决策

| 决策点 | 结论 | 来源 |
| --- | --- | --- |
| 超时 | 120s 硬超时（`context.WithTimeout` 杀进程树），运行中可手动停止 | 用户选定 |
| 输出持久化 | 会话内存态：不写 memo.json；重渲染从内存 Map 恢复，关面板清空 | 用户选定 |
| 默认 shell | 跟随内置终端默认：pwsh → Windows PowerShell 兜底（`normalizeTermShell('')` 同语义） | 用户选定 |
| 命令载体 | 条目正文即命令；多行 = 多语句脚本整段交给 shell | 设计定 |

AI 通路刻意收窄：AI 能建/改/读终端条目（kind 透传），**不能运行**（无 run 动作）——
运行属用户主动操作，后续如需 AI 触发另行立项审批链。

## 2. 复用通道（Go 侧零改动）

执行复用 `run.Runner.RunExec(id, exe, args, cwd, pathPrepend, timeoutMs)`
（`internal/run/run.go:506`，App 结构嵌入即绑定，`wailsjs` 三件早已存在）：

- 事件 `run-out` `{id, stream, data}`：16ms 批量 + 8KB 阈值、`decodeRunOutput`
  GBK/UTF-8 兜底、总量 8MB 上限——中文 Windows 工具链输出不用额外编码前缀。
- 事件 `run-exit` `{id, code, durationMs, reason}`：超时 reason='timeout'，杀树
  `procctl.ApplyCancel`（KillProcessTree + WaitDelay 3s）。
- 停止 `RunStop(id)`；stdin `RunInput/RunEndInput`（v1 暂不用，通道现成）。
- 运行 id = `memo-<itemId>`：`run.js` 的 `onRunOut/onRunExit`（run.js:965-985）对
  未知 id 静默忽略，F5 通道互不干扰；procctl 16 并发上限由 Go 报错 → flash。
- 命令字符串 → shell argv 在前端拼（`memo-term.js` `buildShellArgv`，按
  `ResolveRunShell` 返回的 Name 分派：PowerShell 系 `-NoLogo -NoProfile
  -NonInteractive -Command`、Git Bash `--login -c`、其余 `/d /s /c`）。

## 3. 数据层（memo-model.js）

- `MEMO_KINDS = ['text', 'md', 'term']`；`normalizeMemoKind` 收敛非法输入为 text。
- `normalizeMemoData` / `addItem` / `updateById` 三处 kind 口径统一（报错文案
  「kind 只支持 text / md / term」）；旧数据（手改坏/旧版本）自动纠正。
- `formatMemoForAI`：term 条目带 `[终端]` 标记，命令原文可读、id 可回溯。
- 导出：term 条目按普通清单条目走（只导出命令原文，不导出输出——输出不落盘）。

## 4. 运行时（memo-term.js，新建）

- `createMemoTerm(deps)` 工厂（deps 注入 backend/flash/rt/normalizeTermText/findRow）。
- 状态 `Map<itemId, {state, lines, code, durationMs, startedAt, truncated, shell}>`：
  state ∈ running / done（code 0）/ exit / timeout / stopped；500 行尾部保留。
- 纯函数（node:test 直测）：`buildShellArgv` / `trimTermLines` / `formatTermDuration`
  / `formatTermStatus` / `termRunId`。
- 事件订阅一次（`rt.EventsOn('run-out'/'run-exit')`，按 `memo-` 前缀过滤）；
  活更新直接改条目行 DOM（`.memo-run-btn` 换运行/停止图标、`.memo-term-out` append 行、
  `.memo-term-status` 换文案），**不走整面板重渲染**——流式期间可能正在编辑命令文本。
- 防重入（running 再点 = 停止）；RunExec 抛错清态 + flash，不留 running 僵尸。
- `stopAll()`：关面板（`doc.memoUnmount`）停掉仍在跑的运行并清空内存态。

## 5. 视图（bridge-memo-view.js）

- `buildItem`：kind=term → 行首 `buildRunButton`（运行/停止图标，点击读实时状态分流运行/停止/
  空命令先编辑）、命令等宽渲染（`.memo-term-cmd`）、有运行记录时 append
  `buildTermResult`（状态行在上 + 输出块在下，flex-basis:100% 独占整行）。
- 块尾【终端】按钮启用（原 disabled 占位）→ `quickAddToBlock(kind='term')`。
- 条目菜单：「转为…」子菜单三向转换（文本/Markdown/终端）+「清除运行输出」。
- 只读窗口：`.memo-readonly .memo-run-btn` 禁用（pointer-events: none）。
- cwd：工作区根（`deps.workspaceFolder`），无工作区（全局作用域）→ 空串继承进程 cwd。

## 6. AI 技能表

`update_memo` 的 kind 说明补 term（ai-constants.js cadt-ui 技能表一行一个动作的
格式不变，`ai-app-actions.test.mjs` 三方对账不受影响）。

## 7. 测试

- `test/bridge/memo-model.test.mjs`：kind=term 全链路（addItem/normalize/updateById/
  formatMemoForAI/exportMemoMarkdown）。
- `test/bridge/memo-term.test.mjs`（新）：纯函数 + 假 backend/rt 驱动的编排层
  （防重入、事件路由、超时/停止状态机、失败清态、stopAll、shell 解析失败）。
- 浏览器 mock 复测：新建/编辑/转换、运行、停止、重渲染输出保留、关面板清空。
- 真机 exe：GBK 中文输出、120s 超时杀树、手动停止。

## 8. 后续可选

- per-item shell 覆盖（cmd/gitbash 显式选择，item 字段持久化）。
- AI 动作 `run_memo_item`（带审批链，参照 run_command 语义）。
- 输出块「复制」「发给 AI 分析」（复用 run.js 的 buildRunAnalysisPrompt 思路）。
- stdin 通路（RunInput/RunEndInput 已具备）。
