//go:build windows

package cmdbridge

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"datalens/internal/sandbox"
	"datalens/internal/shellpath"
)

// AI 终端工具：按 Git Bash → PowerShell 7 → Windows PowerShell → cmd 的优先级执行命令。
// 复用进程桥的 RunCommandSync（无窗口、超时、输出上限），但 shell 由后端统一选择。
//
// 沙箱档是例外：**永不解析 Git Bash**。实测（docs/finished-plans/subagent-sandbox.md
// §8.2）Cygwin 在 WRITE_RESTRICTED 令牌下无法启动——它要在 \BaseNamedObjects 建目录
// 对象、按用户 SID 建共享内存，而 restricting 列表里没有用户 SID。沙箱档固定
// PowerShell（回退 cmd），语言与 bash 不同，界面上如实显示 shell 名。

// AI 前台指令（run_command）的超时边界：比插件同步命令（120 s）宽松——
// AI 跑测试 / 构建属正常需求，但默认仍要有界，长任务应交给 background_command。
const (
	aiShellDefaultTimeout = 60000  // 默认 60 s
	aiShellMaxTimeout     = 600000 // 上限 600 s
)

type AIShellCommandResult struct {
	Shell      string `json:"shell"`
	Exe        string `json:"exe"`
	Code       int    `json:"code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	TimedOut   bool   `json:"timedOut"`
	DurationMs int64  `json:"durationMs"`

	// 沙箱档位与完整度（未启用沙箱时三个字段都为空）。如实上报是硬要求：
	// 卡片据此显示「沙箱: workspace-write (partial)」，不允许看起来沙箱了其实没沙箱。
	SandboxMode string `json:"sandboxMode,omitempty"`
	Enforcement string `json:"enforcement,omitempty"`
	TempDir     string `json:"tempDir,omitempty"`
	// SandboxDenied 表示这条命令的失败疑似来自 ACL 拒绝（沙箱真的拦住了写效应）。
	// 只做留痕分类，不改判定语义：命令确实失败了，只是原因被标出来。
	SandboxDenied bool `json:"sandboxDenied,omitempty"`
}

// 沙箱拒绝的判定与特征串在 sandbox_denial.go（跨平台：后台作业退出时也要用）。

func findExe(name string) string {
	path, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	return path
}

// aiShellInvocation 选择执行命令的 shell。sandboxed 为真时跳过 Git Bash（见文件头）。
func aiShellInvocation(command string, sandboxed bool) (shellName, exe string, args []string) {
	if !sandboxed {
		if bash := shellpath.FindGitBash(); bash != "" {
			return "Git Bash", bash, []string{"--login", "-c", command}
		}
	}
	if pwsh := shellpath.FindPwsh(); pwsh != "" {
		// 避免中文输出按控制台代码页编码；-NonInteractive 防止命令等待输入。
		prefix := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Console]::OutputEncoding;"
		return "PowerShell 7", pwsh, []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", prefix + command}
	}
	if ps := findExe("powershell.exe"); ps != "" {
		prefix := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Console]::OutputEncoding;"
		return "Windows PowerShell", ps, []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", prefix + command}
	}
	return "Command Prompt", "cmd.exe", []string{"/d", "/s", "/c", command}
}

// validateShellRequest 校验命令与工作目录（两个入口共用）。
func validateShellRequest(command, cwd string) error {
	if strings.TrimSpace(command) == "" {
		return fmt.Errorf("命令不能为空")
	}
	if strings.TrimSpace(cwd) != "" {
		info, err := os.Stat(cwd)
		if err != nil || !info.IsDir() {
			return fmt.Errorf("工作目录不存在：%s", cwd)
		}
	}
	return nil
}

// clampShellTimeout 归一超时：非正数取默认，超上限截断。
func clampShellTimeout(timeoutMs int) int {
	if timeoutMs <= 0 {
		return aiShellDefaultTimeout
	}
	if timeoutMs > aiShellMaxTimeout {
		return aiShellMaxTimeout
	}
	return timeoutMs
}

type AICommandJobStart struct {
	JobId string `json:"jobId"`
	Shell string `json:"shell"`

	// 沙箱档位与完整度（未启用沙箱时为空），如实上报给卡片与模型。
	SandboxMode string `json:"sandboxMode,omitempty"`
	Enforcement string `json:"enforcement,omitempty"`
	TempDir     string `json:"tempDir,omitempty"`
}

// AICommandStart 把一条 AI 发起的 shell 命令放到后台执行：立即返回 jobId，不闪窗口、
// 不阻塞对话。输出按行缓冲（每作业 256 KB，超限丢弃最早内容），用 AICommandStatus
// 增量查询，AICommandStop 终止；同时照常广播 cmd-out / cmd-exit 供前端卡片实时显示。
func (b *Bridge) AICommandStart(command, cwd string) (*AICommandJobStart, error) {
	command = strings.TrimSpace(command)
	if err := validateShellRequest(command, cwd); err != nil {
		return nil, err
	}
	shellName, exe, args := aiShellInvocation(command, false)
	commandJobsMu.Lock()
	commandJobSeq++
	jobId := fmt.Sprintf("bg-%d", commandJobSeq)
	commandJobsMu.Unlock()
	registerCommandJob(jobId, shellName, command, false)
	if err := b.StartCommand(jobId, exe, args, cwd); err != nil {
		unregisterCommandJob(jobId)
		return nil, err
	}
	return &AICommandJobStart{JobId: jobId, Shell: shellName}, nil
}

// AICommandStartConfined 是 AICommandStart 的沙箱版：写效应圈定在 workspaceRoot 与本次
// 作业的私有 temp 内，作业退出后自动撤掉 temp 授权并删除目录。
//
// 语义与 AIRunShellCommandConfined 一致：read-only 不给写根，workspace-write 给
// workspaceRoot + 私有 temp，danger-full-access 退化为普通后台命令（含 Git Bash）。
// 沙箱建不起来一律报错（fail-closed），绝不降级裸跑。
func (b *Bridge) AICommandStartConfined(command, cwd, mode, workspaceRoot string) (*AICommandJobStart, error) {
	parsed, err := sandbox.ParseMode(mode)
	if err != nil {
		return nil, err
	}
	command = strings.TrimSpace(command)
	if err := validateShellRequest(command, cwd); err != nil {
		return nil, err
	}
	if parsed == sandbox.DangerFullAccess {
		return b.AICommandStart(command, cwd)
	}

	root := strings.TrimSpace(workspaceRoot)
	if root == "" {
		root = strings.TrimSpace(cwd)
	}
	tempDir := ""
	if parsed == sandbox.WorkspaceWrite {
		if root == "" {
			return nil, fmt.Errorf("sandbox: workspace-write 需要工作区根")
		}
		dir, mkErr := os.MkdirTemp("", "cadt-sandbox-")
		if mkErr != nil {
			return nil, fmt.Errorf("sandbox: 建私有临时目录失败：%w", mkErr)
		}
		tempDir = dir
	}
	sb, err := sandbox.New(sandbox.Policy{
		Mode:          parsed,
		WorkspaceRoot: root,
		TempDir:       tempDir,
		ShareConsole:  true,
	})
	if err != nil {
		if tempDir != "" {
			_ = os.RemoveAll(tempDir)
		}
		return nil, fmt.Errorf("沙箱不可用，命令未执行：%w", err)
	}

	shellName, exe, args := aiShellInvocation(command, true)
	commandJobsMu.Lock()
	commandJobSeq++
	jobId := fmt.Sprintf("bg-%d", commandJobSeq)
	commandJobsMu.Unlock()
	registerCommandJob(jobId, shellName, command, true)
	cleanup := func() {
		if tempDir != "" {
			_ = os.RemoveAll(tempDir)
		}
	}
	if err := b.startCommandConfined(jobId, exe, args, cwd, sb, cleanup); err != nil {
		unregisterCommandJob(jobId)
		_ = sb.Close()
		cleanup()
		return nil, err
	}
	return &AICommandJobStart{
		JobId:       jobId,
		Shell:       shellName,
		SandboxMode: string(parsed),
		Enforcement: sb.Enforcement(),
		TempDir:     sb.TempDir(),
	}, nil
}

// AIRunShellCommand 执行一条 AI 发起的 shell 命令；超时不算错误（TimedOut=true + 已捕获输出）。
// runId 非空时注册进取消注册表：用户停止会话可经 AIStopShellRun 杀掉进程，
// 不再只能等命令跑完/超时（此前停止后工具卡会一直转圈到自然结束）。
func (b *Bridge) AIRunShellCommand(command, cwd string, timeoutMs int, runId string) (*AIShellCommandResult, error) {
	command = strings.TrimSpace(command)
	if err := validateShellRequest(command, cwd); err != nil {
		return nil, err
	}
	timeout := clampShellTimeout(timeoutMs)
	shellName, exe, args := aiShellInvocation(command, false)
	started := time.Now()
	raw, err := b.runCommandSyncRegistered(strings.TrimSpace(runId), exe, args, cwd, timeout, aiShellMaxTimeout)
	out := &AIShellCommandResult{
		Shell:      shellName,
		Exe:        exe,
		DurationMs: time.Since(started).Milliseconds(),
	}
	if raw != nil {
		out.Code = raw.Code
		out.Stdout = raw.Stdout
		out.Stderr = raw.Stderr
	}
	if err != nil {
		// 用户停止：明确返回错误（前端据此把工具卡标「已停止」），不能当成超时成功
		if strings.Contains(err.Error(), "已被用户停止") {
			return nil, err
		}
		if raw != nil {
			out.TimedOut = true
			return out, nil
		}
		return nil, err
	}
	return out, nil
}

// AIRunShellCommandConfined 在 OS 沙箱里执行一条 AI 命令：写效应被圈定在
// workspaceRoot 与本次执行的私有 temp 内。
//
//   - mode=read-only：不给任何写根（私有 temp 也不授权，与 dsh 一致）；
//   - mode=workspace-write：授权 workspaceRoot + 每次调用新建的私有 temp；
//   - mode=danger-full-access：不圈定，直接走 AIRunShellCommand（含 Git Bash）。
//
// 沙箱建不起来一律返回错误（fail-closed），绝不降级裸跑。私有 temp 由本函数创建并在
// 返回前删除，前端无须（也不应该）传路径进来，少一个可注入面。
func (b *Bridge) AIRunShellCommandConfined(command, cwd string, timeoutMs int, runId, mode, workspaceRoot string) (*AIShellCommandResult, error) {
	parsed, err := sandbox.ParseMode(mode)
	if err != nil {
		return nil, err
	}
	if parsed == sandbox.DangerFullAccess {
		return b.AIRunShellCommand(command, cwd, timeoutMs, runId)
	}

	command = strings.TrimSpace(command)
	if err := validateShellRequest(command, cwd); err != nil {
		return nil, err
	}

	root := strings.TrimSpace(workspaceRoot)
	if root == "" {
		root = strings.TrimSpace(cwd)
	}
	tempDir := ""
	if parsed == sandbox.WorkspaceWrite {
		if root == "" {
			return nil, fmt.Errorf("sandbox: workspace-write 需要工作区根")
		}
		dir, mkErr := os.MkdirTemp("", "cadt-sandbox-")
		if mkErr != nil {
			return nil, fmt.Errorf("sandbox: 建私有临时目录失败：%w", mkErr)
		}
		tempDir = dir
		// 私有 temp 只服务本次执行：构建缓存、临时产物执行完即弃。
		defer os.RemoveAll(dir)
	}

	// ShareConsole：沙箱档的 shell 是 PowerShell，而 PowerShell（5.1 与 7 都一样）
	// 在无控制台时静默退出——exit 0 但什么都不执行（实测）。宿主没有控制台时由
	// sandbox 包 AllocConsole 后立刻隐藏，子进程继承它；受限令牌下这是唯一能跑
	// PowerShell 的形态（DETACHED_PROCESS 只对 cmd.exe 有效）。
	sb, err := sandbox.New(sandbox.Policy{
		Mode:          parsed,
		WorkspaceRoot: root,
		TempDir:       tempDir,
		ShareConsole:  true,
	})
	if err != nil {
		return nil, fmt.Errorf("沙箱不可用，命令未执行：%w", err)
	}
	defer sb.Close()

	timeout := clampShellTimeout(timeoutMs)
	shellName, exe, args := aiShellInvocation(command, true)
	started := time.Now()
	raw, runErr := b.runCommandSyncConfined(strings.TrimSpace(runId), exe, args, cwd, timeout, aiShellMaxTimeout, sb)
	out := &AIShellCommandResult{
		Shell:       shellName,
		Exe:         exe,
		DurationMs:  time.Since(started).Milliseconds(),
		SandboxMode: string(parsed),
		Enforcement: sb.Enforcement(),
		TempDir:     sb.TempDir(),
	}
	if raw != nil {
		out.Code = raw.Code
		out.Stdout = raw.Stdout
		out.Stderr = raw.Stderr
	}
	if runErr != nil {
		if strings.Contains(runErr.Error(), "已被用户停止") {
			return nil, runErr
		}
		if raw != nil {
			out.TimedOut = true
			return out, nil
		}
		return nil, runErr
	}
	out.SandboxDenied = detectSandboxDenial(out.Code, out.Stderr)
	return out, nil
}
