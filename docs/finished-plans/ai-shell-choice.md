# AI 命令的可选 shell 与脚本档审批（2026-11-18 实施）

## 1. 背景

`run_command` / `background_command` 由后端 `aiShellInvocation`（`internal/cmdbridge/ai_command_windows.go`）按
**Git Bash → PowerShell 7 → Windows PowerShell → cmd** 的优先级选 shell。装了 Git for Windows 的机器上，
命令实际是 `bash --login -c <command>`——**模型写的整段字符串是 bash 代码**，先被 bash 解析一遍。

现场（用户截图）：模型想查端口占用，写了

```
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 11437; if($c){$c | Format-Table}"
```

bash 先把双引号内的 `$c` / `$_` 展开（本机 `c` 恰好是 bash_completion 的变量），PowerShell 收到的是
`=Get-NetTCPConnection … .OwningProcess` 这种残缺脚本，退出码 1，stderr 里能看到被吃掉的残句。完全权限档
下没有审批兜底，这类命令会直接跑、直接错。

## 2. 决策

**做：显式 shell 参数（A）+ 文案（C）；后续补：脚本档审批三层。**

- **不给「自动嗅探」**（看首 token 是 `powershell` 就替你换 shell）：`CreateProcess` 不做 shell 解析，
  `powershell -Command "…"` 里的引号归属极易判错，出错时用户更懵。宁可让模型显式声明。
- **不重训端侧分类器**：三层里它不承担放行职责（见 §4.2）。PowerShell 别名是开放集合
  （`ri`/`gci`/`sc`/`%`/`?`），字符 3/5-gram 特征永远追不上；而 AI 分类器读得懂别名。
  训练语料 `scripts/classifier-corpus.mjs` 已含少量 PS 危险样本（`Remove-Item -Recurse -Force`、`iwr | iex`），
  安全侧覆盖极薄——这决定它只能拦、不能放。
- **不做窄白名单**：PowerShell 写盘路径无穷（`Add-Content` / `Export-Csv` / `[IO.File]::WriteAllText`），
  白名单要穷举 cmdlet + 别名 + 参数语义，收益低于「分类器 + 特征表」。

## 3. 实现

### 3.1 Go：shell 由调用方指定

`aiShellInvocation(command, shell, sandboxed)` 改四返回值：

- `shell == ""` → 旧优先级，行为零变化；
- `normalizeAIShell` 只认 `gitbash` / `pwsh` / `powershell` / `cmd`（与内置终端 `TerminalShells` 的 id 一致）
  及少量显然别名（`bash` / `cmd.exe` / `powershell.exe`），其余报错；
- **显式指定优先，缺了就报错**——静默回退会让人以为命令跑在别的语言环境里，这正是本次踩坑的机制；
- 沙箱档（子代理）显式请求 `gitbash` 直接报错（Cygwin 在 `WRITE_RESTRICTED` 令牌下起不来，见 `subagent-sandbox.md` §8.2）；
- PowerShell 脚本作为**单个 argv** 交给 `-Command`：多行、双引号、`$` 都不会被二次转义
  （Go 的 Windows 参数转义 + PowerShell 的标准解析）；沙箱版在**建沙箱/建 temp 之前**解析 shell，失败不留半成品。

四个绑定各加尾参 `shell`：`AICommandStart` / `AICommandStartConfined` / `AIRunShellCommand` /
`AIRunShellCommandConfined`（`frontend/wailsjs/` 由 `wails dev` 自动重生成）。

### 3.2 前端：参数与文案

- `ai-tool-defs.js`：两个工具加 `shell`，enum 取 `SHELL_VALUES`（与审批口径同源）；描述写清
  「需要 PowerShell 就传 pwsh、直接写语句，不要再包一层 `powershell -Command`」以及为什么。
- `ai-panel.js`：两处 `executeTool` 分支读 `input.shell` 并透传；`approveCommandForRun` 增加 `shell` 形参，
  审批记录带 `shell`，接管卡与工具卡显示 `pwsh · <cwd>`。
- 系统提示词（`ai-system-context.js` 的 `<workspace_rules>`）补一条守则，避免模型靠旧习惯继续拼
  `powershell -Command`；`<env_vars>` 说明补 PowerShell 的 `$env:名称`。
- `dev/mock-backend.js` 同步（显式 shell 时回显对应 shell 名）。

### 3.3 审批三层

| 层 | 位置 | 职责 |
|---|---|---|
| ① 破坏特征表 | `ai-command-rules.js` 的 `psScriptDanger` | 全文扫已知破坏特征（含别名），命中即 `dangerous` → 单次确认，不问分类器 |
| ② 端侧分类器 | `ai-panel.js` 的 `scriptShell` 分支 | **只拦不放**：判安全也不放行，且不把它的结论注入 AI 提示词（避免把 AI 往「安全」带） |
| ③ AI 分类器 | `classifyCommandForAuto` | `allow` 才自动执行；未开启 / 超时 / 解析失败 → 转人工（fail-closed） |

`shellScriptPolicy(shell, command)` 返回 `{script, danger}`：`script=true` 时**只读判定、会话授权、
命令族、Git 快捷豁免全部作废**（否则等于用新参数开一条降级审批的后门）；`danger=null` 表示「没有已知破坏
特征」，交给分类器。`cmd` 档复用既有 `analyzeDangerousCommand`（argv 风格与 bash 接近）。

特征表覆盖：删除 / 移动 / 改名 / 清空、写文件与重定向（`>`、`Out-File`、`-OutFile`、`Start-Transcript`）、
动态执行（`iex` / `Invoke-Command` / 起停进程 / `&` 调用操作符 / `.` 点源）、服务·计划任务·注册表·账户·ACL、
磁盘、安全基线（`Set-MpPreference` / `Set-ExecutionPolicy`）、关机、凭据、日志清理、反射（`[IO.*]` / `[System.*]` / `Add-Type`）。

正则要点：名字后必须 `(?![\w.-])` —— `format` 不能匹配 `Format-Table`、`sc` 不能匹配 `sc.exe`（后者是服务控制器，
单列进持久化）；`.` 点源规则要求点后**必须有空白**再接路径，否则 `Get-ChildItem .\src` 误判。

## 4. 行为矩阵

| 场景 | auto 档 + 分类器 | auto 档 + 无分类器 | full 档 |
|---|---|---|---|
| 只读脚本（`Get-NetTCPConnection …`） | AI 判定后自动执行 | 逐次询问 | 自动执行 |
| 破坏脚本（`Remove-Item -Recurse -Force`） | 单次确认（`dangerous` 先于分类器） | 单次确认 | 自动执行 |
| 默认档（不传 `shell`） | 与改造前完全一致 | 同左 | 同左 |

`decidePermission` 的顺序决定的：`dangerous` 在 `ai-permissions.js:254` 先于分类器返回 ask；classify 通道
只在 `scope === 'auto' && classifierEnabled` 时可达。

## 5. 残余风险

1. **`$($x)` 动态拼命令**：字符串拼出的 cmdlet 名静态不可判定。兜底靠「全文扫描仍会看到 `$(` 里的字面内容」
   以及 `&` / `.` / `iex` 命中；纯变量间接调用只能靠 AI 分类器。
2. **特征表是开放集合**：PowerShell 的写盘接口远多于表内条目。未命中 ≠ 安全，只表示「没有已知破坏特征」。
3. **没开 AI 分类器时只读脚本仍逐条问**：有意的 fail-closed，端侧对脚本不可信。想少点几次就开
   设置 → AI → 权限 → 自动审批分类器。

## 6. 验证

- Go：`TestAIShellExplicitSelection`（显式压过优先级 / 未安装报错 / 未知值拒绝 / 沙箱禁 Git Bash）、
  `TestAIRunShellCommandExplicitShellKeepsDollar`（多行 + 双引号 + `$c` 原样送达，即 §1 现场的护栏）。
- 前端：`ai-command-rules.test.mjs` 钉住 24 条破坏样本（含 `gci -r | ri -fo`、`Where-Object { Remove-Item $_ }`、
  `[IO.File]::WriteAllText`）与只读样本的误报基线（16 条常见只读命令零误报）；`npm test` 1391 例全绿。
- 手测：`run_command(shell="pwsh", command="$c=Get-NetTCPConnection -LocalPort 11437 …")` 正常返回，卡片显示
  `PowerShell 7`。

## 7. 遗留可做

- 端侧补 PowerShell 语料重训（`scripts/classifier-corpus.mjs` 加族 → `node scripts/train-local-classifier.mjs`，
  三道硬指标自动卡）——只有想让「没开 AI 分类器时 PS 只读也免点」才值得。
- 特征表可继续补 `Remove-*` / `Clear-*` 全族与 `Set-*` 白名单差分。
- 旧文档 `docs/finished-plans/ai-panel.md` / `ai-panel-v2.md` 里的 `run_command(command, cwd?, timeoutMs?)` 是
  当时的签名，未含 `shell`，按历史记录保留不改。
