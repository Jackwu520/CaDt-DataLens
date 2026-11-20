# 终端命令结束 / 手动停止时的会话唤醒机制调研（2026-11-21）

## 背景与问题

用户提问：「手动停止的时候不会触发唤醒会话吗，我看别的 harness 会」。

本应用当前行为：后台命令**正常结束**（退出码非 -1）经 `cmd-exit` 事件 → `buildBgJobExitNotice` → 会话信箱唤醒模型；**被停止**（退出码 -1）不唤醒。判定在 `frontend/src/ai/ai-panel.js:7360`：

```js
if (opts && opts.wake && exitedNow && codeNum !== -1 && entry) {
    deliverBgExitNotice(entry, buildBgJobExitNotice({...}));
}
```

本次调研 6 个主流 harness 的实际做法，回答两个问题：① 手动停止命令时别家是否唤醒模型？② 用 `code === -1` 判定"用户手动停止"是否会误判？

**本次为只读调研 + 源码核查，未修改任何代码。**

## 结论先行

1. **「手动停止正在运行的命令不唤醒模型」是绝对主流**：6 家全部如此。本应用当前行为与主流一致，不是 bug。
2. 用户印象中「会唤醒」的情况，来自两类被混在一起的场景：
   - **后台命令正常完成** → 唤醒（opencode / ZCode / 本应用）；
   - **停止后台任务算一种"终态"** → 唤醒（仅 ZCode 一家，6 家里唯一的例外）。
3. `code === -1` 严格说不等于"用户手动停止"（还有两种罕见异常来源），但**在"排除唤醒"这个方向上误判无害**——那些异常退出主流也都不唤醒。反过来若拿 `-1` 当"用户停止"去触发唤醒，才会把系统异常误报成用户操作。

## 六家对比矩阵

| harness | 后台命令正常完成→唤醒 | 手动停止前台命令→唤醒 | 手动停止后台任务→唤醒 |
|---|---|---|---|
| Pi | —（无后台命令概念） | ✗ 结束 run，排队消息退回编辑器 | — |
| opencode | ✓ synthetic 消息 + wake | ✗ ToolFailure（interrupted） | ✗ ToolFailure |
| dsh（dsh-purge 插件） | ✗ 拉取式，需主动 `job_output` | ✗ 用户 abort 被显式排除自动续跑 | ✗ 需主动查 |
| codex | ✗ 轮询式，需 `write_stdin` | ✗ TurnAborted | ✗ 不杀后台终端 |
| cline | ✗ 仅示例插件有；内置 detach 只写日志 | ✗ run 标 aborted，UI 给"恢复任务" | ✗ 写日志，不唤醒 |
| ZCode | ✓ task-notification + runtime wake | ✗ 取消 tool result + 中断标记 | ✓ 归一成终态 `was stopped` 并唤醒 |
| **本应用** | ✓ 会唤醒 | ✗ `code=-1` 排除 | ✗ `code=-1` 排除 |

## 两种结果回传范式

- **工具返回值派**（Pi / codex / cline / dsh）：命令结果作为 tool result 回到模型，同一 run 内继续；后台会话靠模型主动轮询（`write_stdin` / `job_output` / `read_files`）。
- **完成事件注入 + 唤醒派**（opencode / ZCode / 本应用）：后台命令完成时注入一条 synthetic 用户消息，唤醒空闲会话起新轮。本应用对应 `cmd-exit` → `buildBgJobExitNotice`（`frontend/src/ai/ai-agent-notices.js:78`）→ 会话信箱三态投递。

## 中断时的普遍做法

几乎所有家都会合成一段"被中止"的文本放进工具结果或下一轮 marker，**但都不主动起新轮**——run 直接结束，等用户下一次触发：

- codex：`Op::Interrupt` → `TurnAborted`；工具响应合成 `aborted by user`，下一轮注入"用户有意中断上一轮"标记（`codex-rs/core/src/context/turn_aborted.rs:11-12`）。
- cline：abort → run 标 `aborted`；UI 追加 `resume_task` 按钮让用户手动恢复（`sdk/packages/agents/src/agent-runtime.ts:1041-1046`、`apps/vscode/src/sdk/sdk-task-control-coordinator.ts:75-113`）。
- Pi：Escape → `session.abort()`，排队 steering/followUp 消息**退回编辑器**而非发给模型（`modes/interactive/interactive-mode.ts:3200-3205,4936-4954`）。
- opencode：用户中断 → `cancelled(info)` → `ToolFailure`，metadata 带 `interrupted:true`，不 wake（`packages/core/src/tool/plugin/shell.ts:351-369`）。
- ZCode（前台）：`ToolCancelled` → 取消 tool result + `[Request interrupted by user]` marker，当前轮结束（`apps/zcode-cli/packages/core/src/runtime/methods/interrupt-marker.ts:15,24,33,43`）。

**唯一例外 ZCode（后台）**：用户停止后台任务（`TaskStop` / UI Stop）归一成后台终态 `killed`，summary 为 `Background command "..." was stopped`，发 `task-notification` 并唤醒模型（`apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts:843-854,864-882`；`background-notifications.ts:19,55-69`）。这很可能就是"别的 harness 会唤醒"这一印象的来源。

## `code === -1` 语义核查（本应用）

### 三个来源

`internal/cmdbridge/app_commands.go:249-258`：

```go
code := 0
if waitErr := cmd.Wait(); waitErr != nil {
    if ctx.Err() != nil {
        code = -1 // 被 taskkill/取消终止：wrapper 的退出码无意义，统一记 -1
    } else if exitErr, ok := waitErr.(*exec.ExitError); ok {
        code = exitErr.ExitCode()
    } else {
        code = -1
    }
}
```

| 来源 | 触发条件 | 是不是用户手动停止 |
|---|---|---|
| `ctx.Err() != nil`（`:252`） | `AICommandStop` / `StopCommand` → `procctl.Stop` → cancel → 杀进程树 | ✅ 是（用户点停止 / 模型调 stop_command） |
| 非 `ExitError` 的 `Wait` 错误（`:256`） | 进程启动后 Wait 本身出错（管道/系统级异常），极少见 | ❌ 不是 |
| `exitErr.ExitCode()` 恰好 -1（`:254`） | 进程被信号杀死（Unix 语义）；Windows 上极罕见 | ❌ 不一定是用户 |

`AICommandStop` 确实走 `procctl.Stop(jobId)`（`app_commands.go:480-505`），`procctl.Stop` 调注册的 cancel（`internal/procctl/procctl.go:49-55`），`ApplyCancel` 在取消时 `KillProcessTree`（`:60-63`）。测试 `internal/cmdbridge/ai_command_windows_test.go:219-220` 断言被终止作业退出码为 -1。

### 判定：误判无害

- `-1` 严格说是"非正常退出"标记，不 100% 等于"用户手动停止"。
- 但主流 harness 排除的是**整个"被中止"类别**，不止"用户点的那一下"。本应用用 `codeNum !== -1` 把所有非正常退出一起排除，正好与主流口径一致。
- 因此不会造成"该唤醒却被漏掉"的有害误判：那些被 -1 囊括的异常退出，主流也都不唤醒。
- 反之，若把 `-1` 当"用户停止"去**触发**唤醒（对齐 ZCode 式），才会把系统异常误报成用户操作——那才是真误判。

### 模型如何得知命令被中止

主流做法是合成"被中止"文本进工具结果 / 下一轮 marker，本应用已具备：`stop_command` 返回文本含「状态：已终止 · 退出码 -1 · …」（`frontend/src/ai/ai-panel.js:11209`），模型主动查时能看到。这符合主流"不主动唤醒、但可查询得知"的口径。

## 建议

保持现状（`ai-panel.js:7360` 的 `codeNum !== -1`），行为已对齐主流，无需改动。若将来要对齐 ZCode 的"停止后台任务也唤醒"，应新增显式的"用户停止"标记（而非复用 `-1`），避免把系统异常误报成用户操作。

## 调研方式

6 个只读子代理并行调研，各自基于仓库源码与文档阅读，未运行构建/测试验证。仓库路径：

- `D:/OraSkyC/Project/OpenSource/cline`
- `D:/OraSkyC/Project/OpenSource/codex`
- `D:/OraSkyC/Project/OpenSource/opencode`
- `D:/OraSkyC/Project/OpenSource/pi`
- `D:/OraSkyC/Project/OpenSource/ZCode`
- `D:/OraSkyC/Project/OpenSource/dsh-purge`（用户口头称 deepseek-harness；实为 dsh-purge 插件，非官方 harness 本体，结论范围有限）
