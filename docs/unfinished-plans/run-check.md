# `run_check` 实施文档（子代理可执行检查，闭合命令集）

> 状态：**待实施**（2026-11-17 方案成文，未开工）  
> 定位：`subagent-sandbox.md` §7 的方案 A——**不引入 OS 沙箱、不给通用 shell**，用「closed set of checks」解决「子代理跑不了测试 / 看不了 git」这一真实需求  
> 前置决议：2026-11-17 复核结论「通用 shell + ACL 沙箱性价比不成立」（理由见 `subagent-sandbox.md` §7.1），本方为其替代  
> 范围：新增一个 AI 工具 + 一个 Go 引擎包 + 一个 Wails 绑定；**不改** `run_command` / 审批链 / 分类器 / 子代理权限档语义

## 1. 为什么是这个形状

问题的本质不是「子代理缺 shell」，而是**子代理缺「验证自己读到的结论」的手段**——它现在只能读文件，说「测试大概能过」。真需求只有三类：跑测试、跑构建、看 git 状态与 diff。

因此本方案的核心约束是：**命令不由模型拼，参数只有枚举**。

| 维度    | `run_command`（主会话有）             | `run_check`（本方案）                |
| ----- | ------------------------------- | ------------------------------- |
| 命令来源  | 模型任意字符串                         | Go 侧按项目标记从固定表解析                 |
| 参数面   | `command` + `cwd` + `timeoutMs` | `kind` 枚举 + `cwd` + `timeoutMs` |
| 提示注入面 | 有（命令文本可被诱导）                     | **无**（模型无法表达任意命令）               |
| 审批    | 逐条 / 自动审批档 / 分类器                | 不需要（命令形态固定）                     |
| 适用    | 人可能在场的主会话                       | 无人可问的子代理                        |

**这不是沙箱的简化版，而是另一种边界**：沙箱约束「命令能改什么」，本方案约束「能跑什么」。

## 2. 工具契约

### 2.1 定义（`frontend/src/ai/ai-tool-defs.js` 的 `AI_TOOL_DEFS`）

```js
run_check: {
    name: 'run_check',
    description: '按项目类型跑一个固定形态的检查：kind=test 跑测试、build 跑构建、lint 跑静态检查、git-status / git-log / git-diff 看仓库状态。命令由应用按项目标记（package.json / go.mod / Cargo.toml / pyproject.toml / Makefile）解析，不能传自定义命令；需要执行任意命令请用 run_command（主会话）。返回退出码与输出；项目里没有对应脚本或工具时明确返回「不可用」并列出可用的 kind。用来验证「改完是否仍然通过」，不要用它代替运行程序本身。',
    parameters: {
        type: 'object',
        properties: {
            kind: {type: 'string', enum: ['test', 'build', 'lint', 'git-status', 'git-log', 'git-diff'],
                   description: '要跑的检查类型'},
            cwd: {type: 'string', description: '检查起点目录，默认范围根；应用会从此目录向上找项目标记'},
            timeoutMs: {type: 'integer', description: '超时毫秒，默认 120000，最大 300000；到点强杀并返回已捕获输出'},
        },
        required: ['kind'],
    },
},
```



> 描述里**不要**出现 `command` 这个词的裸标识符：`ai-tool-wiring.test.mjs` 的参数样 token 校验会把 `command` 当成「别家参数名」要求登记进 `PROSE_TOKENS`（`run_command` 的参数）。用中文「自定义命令」表述即可。

### 2.2 返回（`RunCheckResult`）

```go
type RunCheckResult struct {
    Available  bool     `json:"available"`      // false = 该 kind 在探测到的项目里不成立
    Reason     string   `json:"reason,omitempty"`
    Kind       string   `json:"kind"`           // test / build / lint / git-status / git-log / git-diff
    Label      string   `json:"label"`          // 人读命令名，如 "go test ./..."
    Exe        string   `json:"exe"`
    Args       []string `json:"args"`
    Project    string   `json:"project"`        // "Go" / "Node.js" / "Rust" / "Python" / "Make" / ""
    Marker     string   `json:"marker"`         // "go.mod" / "package.json" / …
    Root       string   `json:"root"`           // 项目根（绝对路径）
    Cwd        string   `json:"cwd"`
    Code       int      `json:"code"`
    Stdout     string   `json:"stdout"`
    Stderr     string   `json:"stderr"`
    DurationMs int64    `json:"durationMs"`
    TimedOut   bool     `json:"timedOut,omitempty"`
    AvailableKinds []string `json:"availableKinds"` // 不可用时用来说明「能跑的是哪些」
}
```

前端把结果整形为文本（与 `run_command` 的卡片口径一致）：首行 `kind（label）· 退出码 N · 1.2s`，其后 stdout，再 stderr。

### 2.3 模型可见文案（`executeTool` 返回值，不是 throw）

| 情形   | 返回文本                                                           |
| ---- | -------------------------------------------------------------- |
| 成功   | `检查通过（可跑测试）\n<输出>` / `检查失败：退出码 1\n<输出>`                        |
| 不可用  | `本项目没有可用的 test 检查（Go 项目可用：build、lint）。不要重试 kind=test，直接说明未验证。` |
| 超时   | `检查超时（120000 ms），已强制结束并返回已捕获输出：\n<输出>`                         |
| 工具缺失 | `未找到 npm（未安装 Node.js 或不在 PATH）。这一项无法执行，不要重试。`                  |
| 用户停止 | `用户已停止生成，检查未完成。`                                               |

「不可用」必须带**可用清单**——这是让模型一次调用就知道该改用什么，而不是逐个枚举试错（`run_command` 时代的失败模式）。

## 3. 命令映射表（单一来源，`internal/runcheck` 包内常量表）

项目探测复用 `internal/runproject.Detect(path)`（`runproject.go:37`）：从 cwd 向上最多 8 层找标记，遇 `.git` 与用户主目录停止。**marker 表不复制**——新包只消费它返回的 `Kind` / `Marker` / `Root`。

| Marker / Kind             | `test`                                                                   | `build`                             | `lint`                            |
| ------------------------- | ------------------------------------------------------------------------ | ----------------------------------- | --------------------------------- |
| `package.json` / Node     | `npm test`（仅当 `scripts.test` 存在）                                         | `npm run build`（仅当 `scripts.build`） | `npm run lint`（仅当 `scripts.lint`） |
| `go.mod` / Go             | `go test ./...`                                                          | `go build ./...`                    | `go vet ./...`                    |
| `Cargo.toml` / Rust       | `cargo test`                                                             | `cargo build`                       | `cargo check`                     |
| `pyproject.toml` / Python | `python -m pytest -q`（仅当 `pyproject.toml` 提到 pytest **或**存在 `tests/` 目录） | —                                   | —                                 |
| `Makefile` / Make         | `make test`（仅当 Makefile 有 `test:` 目标）                                    | `make build`（有 `build:` 目标）         | —                                 |

`git-*` 与项目无关，固定三档，`cwd` 内不是 git 仓库时不可用：

| kind         | 命令                                                 |
| ------------ | -------------------------------------------------- |
| `git-status` | `git status --porcelain=v1 -z`                     |
| `git-log`    | `git log --oneline -n 20`                          |
| `git-diff`   | `git diff --no-renames`（`--stat` 变体留给前端展示；v1 只出正文） |

**三条 fail-closed 规则**：

1. 探测不到任何项目标记 → 所有 `test`/`build`/`lint` 不可用，`Reason` 明确写「在 <cwd> 及上级 8 层内没有找到项目文件」。
2. 该 kind 在映射表里是 `—` 或前置条件不成立（无脚本 / 无 target / 无 pytest 迹象）→ 不可用 + `AvailableKinds` 给出该项目的全部可用项。
3. **exe 前置检查**：`exec.LookPath` 失败时直接不可用（`未找到 go（未安装 Go 或不在 PATH）`），不要落到 `exec` 的错误文本上——`resolveRunProjectExe`（`runproject.go:151`）在解析失败时回退裸名，会让错误信息变成看不懂的 `exec: "go": executable file not found`。

`kind` 非法值 → 返回 error（枚举校验在 Go 侧再做一遍，不信任前端）。

## 4. Go 实现

### 4.1 新包 `internal/runcheck/runcheck.go`（纯逻辑，全平台）

```go
// Plan 解析一次检查计划；不执行任何命令。
func Plan(cwd, kind string) (*Plan, error)   // Plan 含 Exe/Args/Cwd/Label/Project/Marker/Root/Available/Reason/AvailableKinds
```

- 内部只用 `runproject.Detect` + 自己的映射表 + `os.ReadFile` 读 package.json scripts（**不要在 runproject 里加检查知识**；若不想重复解析逻辑，可让 runproject 导出 `Scripts(path)` 一行包装，二者只留一份 JSON 解析）。
- Makefile target 探测：按行匹配 `^([A-Za-z0-9_.-]+)\s*:`（忽略 `.PHONY` 与变量行）。
- 无 `internal/*` 之外依赖，不 import main，符合「引擎下沉」约定。

### 4.2 绑定（`internal/cmdbridge/runcheck.go`，**不带 build tag**）

放在 cmdbridge 而不是 root，是因为执行侧一切都已现成（`app_commands.go:59` 的 `runCommandSyncRegistered`）：

```go
func (b *Bridge) AIRunCheck(kind, cwd string, timeoutMs int, runId string) (*runcheck.Result, error) {
    plan, err := runcheck.Plan(cwd, kind)     // cwd 由前端 aiResolveScopePath 传入
    if err != nil { return nil, err }
    if !plan.Available { return runcheck.Unavailable(plan), nil }   // 不当作错误
    raw, runErr := b.runCommandSyncRegistered(strings.TrimSpace(runId), plan.Exe, plan.Args, plan.Cwd, timeoutMs, runCheckMaxTimeout)
    ...
}
```

由此**免费继承**（不要再写一份）：

| 能力                                      | 来源                           |
| --------------------------------------- | ---------------------------- |
| 不经 shell（`exe` + `args` 直传）             | `exec.CommandContext`        |
| 超时强杀 + `TimedOut` 语义                    | `runCommandSyncRegistered`   |
| 用户停止（`AIStopShellRun` → `procctl.Stop`） | 同上，注册 `runId`                |
| 输出上限 `commandOutputCap`                 | `limitedWriter`              |
| 环境变量合并（设置页的私密变量）                        | `envvars.MergeEnv`           |
| 防黑窗                                     | `executil.HideCommandWindow` |

`runCheckMaxTimeout = 300000`（5 分钟；比 `run_command` 的 600 s 保守——检查类不该跑那么久）。

> **必须无 build tag**：非 Windows 上 `run_check` 不能像 `internal/terminal` 那样静默消失（`crossplatform_guard_test.go` 与 `tools\check-crossbuild.cmd` 会盯着；语义上这也只是「跑一条子进程」，POSIX 上完全成立）。

### 4.3 前端 `executeTool` 分支（`ai-panel.js`，按现有 `run_command` 分支位置放）

```js
case 'run_check': {
    const kind = aiTextOf(input.kind).trim().toLowerCase();
    if (!RUN_CHECK_KINDS.includes(kind)) throw new Error('kind 必须是 ' + RUN_CHECK_KINDS.join(' / '));
    const cwd = aiResolveScopePath(aiTextOf(input.cwd).trim() || '.', ctx.session);
    const timeoutMs = aiClampInt(input.timeoutMs, 5000, 300000, 120000);
    if (!backend.AIRunCheck) throw new Error('当前版本不支持项目检查');
    ctx.toolMessage.status = 'running';
    ctx.toolMessage.runId = (ctx.session.id || 'session') + '#check-' + (ctx.toolMessage.toolCallId || (++aiCheckRunSeq));
    ...
}
```

要点：

- **子代理不弹审批**：`ctx.agentDepth` 存在时跳过 `approveCommandForRun`（子代理永远「不问」，与 `subagent-sandbox.md` 的 pin-never 口径一致）。主会话（P2）才走近审批链。
- 结果整形走一个小函数 `formatRunCheckResult(res)`（放 `ai/ai-tool-args.js` 或新建 `ai-run-check.js`，纯函数可单测）。
- `toolMessage.runId` 与服务停止链一致：用户点停止时 `AIStopShellRun(runId)` 能杀掉检查进程。

## 5. 接线清单（漏一处就坏）

按 `AGENTS.md`「AI 工具增删改」，逐条：

1. **定义** `frontend/src/ai/ai-tool-defs.js`：`AI_TOOL_DEFS.run_check`（§2.1）。
2. **目录** 同文件 `AI_TOOL_CATALOG`：`run_check: {group: 'shell', blurb: '按项目跑测试 / 构建 / 静态检查 / git 查看（命令由应用解析，不能自定义）'}`。**别新建 group**——`AI_TOOL_GROUPS` 的 `shell` 组标题已是「终端与进程」。
3. **档位** 同文件 `toolsForScope`：P1 暂不进（子代理专用），P2 加在 `AI_WRITE_SCOPES.includes(scope) && !planMode` 块内（与 `run_command` 同段）。计划模式**不注入**：`go build` 会写产物，违反零副作用契约。
4. **子代理白名单** `frontend/src/ai/ai-subagents.js` 的 `subToolsForScope`：P1 只在 `hasWorktree` 分支 push（写效应天然圈在隔离 worktree 里，风险最低）；P2 视实测决定是否进入无条件列表。
5. **执行分支** `frontend/src/ai/ai-panel.js` `executeTool`（§4.3）。若拆到别的文件，必须登记 `ai-tool-wiring.test.mjs` 的 `EXECUTED_ELSEWHERE`。
6. **工具卡元数据** `frontend/src/ai/ai-tool-cards.js` 的 `toolMeta`：`case 'run_check': return {verb: '检查', icon: 'terminal'}`（`terminal` 图标已在 `core/icons.js:54` 注册，无需新增）。
7. **mock** `frontend/src/dev/mock-backend.js`：`async AIRunCheck(kind, cwd, timeoutMs)` 返回一个成功结果 + 一个不可用结果的固定样例（dev 模式要能看到两种卡片）。
8. **提示词**：
   - `ai-subagents.js` 子代理系统提示：加一句「需要验证改动是否还通过时用 `run_check`（test/build/lint/git-*），它不能执行自定义命令」。
   - `ai-system-context.js` 的 `<workspace_rules>`（`canWrite` 段）：加一条「验证改动优先 `run_check`，不要用 `run_command` 拼同样的测试命令」。
9. **测试清单** `frontend/package.json` 的硬编码列表（新增 `.test.mjs` 必须登记，`test-manifest.test.mjs` 会双向核对）。
10. **CHANGELOG** / `docs/skills`（若 cadt-ui 技能里列了工具能力，需同步）。

## 6. 权限与留痕矩阵

| 调用方                 | 是否审批                                                  | 留痕                                                                    |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| 隔离 worktree 子代理（P1） | 不弹卡（子代理永不问）；写效应在 `.cadt/worktree/<slug>` 内            | `logActivity('ai.tool', 'run_check', {kind, label, code, ms, depth})` |
| 普通子代理（P2 评估后）       | 不弹卡                                                   | 同上                                                                    |
| 主会话（P2）             | 走 `approveCommandForRun`（只读命令族自动放行，`go`/`npm` 已在低风险族） | 同上 + 既有审批记录                                                           |

**不记输出正文**（与 `run_command` 同口径），只记 kind / label / 退出码 / 耗时。

## 7. 测试清单

### 7.1 Go 表驱动（`internal/runcheck/runcheck_test.go`）

| #  | 场景                                  | 断言                                                                  |
| -- | ----------------------------------- | ------------------------------------------------------------------- |
| 1  | `package.json` 有 `scripts.test`     | `Plan("", "test")` → `npm test`、`Available=true`                    |
| 2  | `package.json` 只有 `build`，请求 `test` | `Available=false`；`AvailableKinds=["build"]`；`Reason` 含「没有 test 脚本」 |
| 3  | `go.mod` 三种 kind                    | `go test ./...` / `go build ./...` / `go vet ./...`                 |
| 4  | `Cargo.toml` 三种 kind                | `cargo test` / `cargo build` / `cargo check`                        |
| 5  | `pyproject.toml` + `tests/` 目录      | `python -m pytest -q`                                               |
| 6  | `pyproject.toml` 无 pytest 迹象        | `test` 不可用                                                          |
| 7  | `Makefile` 有 `test:` 目标 / 只有 `all:` | 前者可用、后者不可用                                                          |
| 8  | 空目录（无标记）                            | 全部不可用，`Reason` 含「没有找到项目文件」                                          |
| 9  | `kind` 非法                           | error                                                               |
| 10 | `git-status` 在非仓库目录                 | 不可用 + 说明                                                            |
| 11 | exe 不在 PATH（把 `go` 换成不存在的名字做可注入测试）  | `Available=false`，`Reason` 含「未安装 / 不在 PATH」，**不是** exec 错误文本        |
| 12 | 探测起点在子目录、祖先有 `go.mod`               | `Root` = 祖先目录（复用 `Detect` 的向上查找）                                    |


> 执行侧（超时、输出截断、用户停止）已被 `cmdbridge` 的既有测试覆盖，本包只测 Plan；`AIRunCheck` 补一条端到端（`go test ./internal/runcheck` 自身作为被检命令会自指，改用 `git-status` 或 `go vet`）。

### 7.2 前端

| 文件 | 断言 |
| --- | --- |
| `frontend/test/ai/ai-tool-wiring.test.mjs` | 自动生效（新工具若不接线直接红）；**先跑一遍确认它抓到了新工具** |
| 新增 `ai-run-check.test.mjs` | `formatRunCheckResult` 四种形态（成功 / 失败 / 不可用 / 超时）的文案；不可用时必须列出可用 kind |
| `subagent` 相关测试 | `subToolsForScope(depth, mode, true)` 含 `run_check`；`hasWorktree=false` 时 P1 不含 |

**故障注入验证（项目硬规矩）**：把 `run_check` 从 `subToolsForScope` 删掉 → 相应测试必须变红；把 `AIRunCheck` 的注册改坏 → Go 侧测试必须变红。守卫不做「改坏必红」验证等于没做。

## 8. 分期与验收

| 期 | 内容 | 验收 |
| --- | --- | --- |
| **P1** | `internal/runcheck` + `Bridge.AIRunCheck` + 工具声明/目录/执行分支/卡片/mock + 只对隔离 worktree 子代理开放 | 隔离 worktree 子代理能跑 `go test` 并拿到真实输出；`npm test` 在 Node 项目上可用；无项目时给「不可用 + 可用清单」；`npm test` 全绿；三平台 `go build` / `go vet` 绿 |
| **P2** | 主会话接入（写权限档，走审批）+ 普通子代理开放 + 两处提示词 | 主会话 read 档看不到该工具；写档调用弹出与 `run_command` 一致的审批卡；停止按钮能杀掉检查进程 |
| **P3** | 补 Python target / monorepo 多项目选择 / 结果进 HUD 摘要 | 视 P1/P2 实测再定 |

## 9. 已知边界（必须如实写进文档与提示词）

1. **`npm test` = 执行项目代码**。本方案保证「命令形态固定、模型传不进任意字符串」，**不保证被检查的项目本身可信**。打开一个下载来的仓库并跑它的测试，等于运行它的代码——这与用户自己点「运行」同级风险，但与「沙箱」无关，别宣传成隔离。
2. **检查会产生写效应**（构建产物、测试快照、npm 缓存）。这是 `run_check` 与 `read` 契约的唯一冲突点；P1 只在隔离 worktree 里开放正是为此。
3. **不是 `run_command` 的替代品**。任何「装依赖、改环境、跑脚本、起服务」都不在这个工具的能力范围内，也不该加进去。
4. **无网络隔离**。`go test` 可能拉模块、`npm test` 可能装依赖。
5. **monorepo**：`Detect` 从 cwd 向上找最近的标记，多包仓库只会命中最近的那个；P1 不提供 `project` 选择参数（避免又多一个可注入面），需要时靠 `cwd` 指到子包。

## 10. 未决问题

1. **`git-diff` 的输出可能很大**（大改动几万行）。v1 直接走 `commandOutputCap` 截断够不够，还是要单独出一个 `--stat` 模式？倾向前端在卡片里折叠 + 保留截断提示。
2. P2 让普通子代理也拿到 `run_check` 时，是否需要一个「最多 3 次」的节流（防模型反复跑同一个失败测试）？可用现有 `toolHalted` / 轮次计数实现，或在描述里写死「失败一次后先读代码再重跑」。
3. `lint` 对 Rust 用 `cargo check` 还是 `cargo clippy`？clippy 常未安装，`check` 更稳但不报 lint。倾向 `check`，并在 `Label` 里如实写 `cargo check`。
4. 是否给 `run_check` 也加一条「结果摘要进 HUD chips」（子代理卡片头部显示 `检查 · test · 通过`）？纯展示，P3。
