package main

// mcp_desktop_app.go：桌面控制（windows-mcp）的 Wails 绑定层。
// 引擎在 internal/desktopmcp（内嵌 wheel 的释放、配置行、安装流程与自愈），这里只做三件事：
//   ① MCPDesktopPlan 只读快照：配置行 + 上游 21 个工具（前端据此渲染工具开关，默认全选）；
//   ② MCPDesktopInstallStart 异步安装：立即返回，进度经 mcp-desktop-install 事件推送
//      （用户要的是「打开开关就装，下面显示进度条」，不是阻塞式等 15 分钟）；
//   ③ MCPDesktopDoctor uv 探测：纯读、无子进程。
// 同步版 MCPDesktopInstall 保留（无进度事件，内部走同一引擎），供测试与兼容调用。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"datalens/internal/desktopmcp"
)

// desktopInstallTimeout 首次下载 Python 3.14 解释器 + 21 个依赖的预算（实测量级数分钟）。
const desktopInstallTimeout = 20 * time.Minute

// desktopInstallEvent 安装进度事件名（前端 appEvents 订阅）。
const desktopInstallEvent = "mcp-desktop-install"

// MCPDesktopInstallResult 同步安装结果。
type MCPDesktopInstallResult struct {
	Ok    bool     `json:"ok"`
	Error string   `json:"error,omitempty"`
	Steps []string `json:"steps,omitempty"`
}

// MCPDesktopInstallStartResult 异步安装的启动回执：Busy=true 表示已有作业在跑。
type MCPDesktopInstallStartResult struct {
	Started bool   `json:"started"`
	Busy    bool   `json:"busy,omitempty"`
}

// desktopInstallEventPayload 推给前端的事件体。
type desktopInstallEventPayload struct {
	Phase   string   `json:"phase"` // running / done / error
	Stage   string   `json:"stage,omitempty"`
	Detail  string   `json:"detail,omitempty"`
	Percent int      `json:"percent"`
	Line    string   `json:"line,omitempty"`
	Error   string   `json:"error,omitempty"`
	Steps   []string `json:"steps,omitempty"`
}

// desktopInstallState 安装作业的跨调用状态：进程内单例，前端重开页面时可用
// MCPDesktopInstallStatus 把进度条恢复回来（事件只在推送时刻有效）。
type desktopInstallState struct {
	mu       sync.Mutex
	running  bool
	done     bool
	failed   bool
	errText  string
	progress desktopmcp.Progress
}

var desktopInstall desktopInstallState

// MCPDesktopPlan 只读快照：不释放 wheel、不起进程。
func (a *App) MCPDesktopPlan() desktopmcp.Plan {
	return desktopmcp.BuildPlan()
}

// MCPDesktopInstallStatus 查安装作业状态（含最后一次进度），供页面重建时恢复 UI。
func (a *App) MCPDesktopInstallStatus() map[string]any {
	desktopInstall.mu.Lock()
	defer desktopInstall.mu.Unlock()
	return map[string]any{
		"running":  desktopInstall.running,
		"done":     desktopInstall.done,
		"failed":   desktopInstall.failed,
		"error":    desktopInstall.errText,
		"progress": desktopInstall.progress,
	}
}

// MCPDesktopInstall 同步安装（阻塞到完成，无进度事件）。
func (a *App) MCPDesktopInstall() MCPDesktopInstallResult {
	ctx, cancel := context.WithTimeout(context.Background(), desktopInstallTimeout)
	defer cancel()
	steps, err := desktopmcp.Install(ctx, nil)
	result := MCPDesktopInstallResult{Steps: steps}
	if err != nil {
		result.Error = err.Error()
		return result
	}
	result.Ok = true
	return result
}

// MCPDesktopInstallStart 异步安装：立即返回，进度与结果经 mcp-desktop-install 事件推送。
// 同一时刻只允许一个作业（重复点击返回 Busy，不排队、不打断正在跑的下载）。
func (a *App) MCPDesktopInstallStart() MCPDesktopInstallStartResult {
	desktopInstall.mu.Lock()
	if desktopInstall.running {
		desktopInstall.mu.Unlock()
		return MCPDesktopInstallStartResult{Busy: true}
	}
	desktopInstall.running = true
	desktopInstall.done = false
	desktopInstall.failed = false
	desktopInstall.errText = ""
	desktopInstall.progress = desktopmcp.Progress{Stage: desktopmcp.StageWheel, Detail: "准备安装", Percent: 1}
	desktopInstall.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), desktopInstallTimeout)
		defer cancel()
		defer func() {
			desktopInstall.mu.Lock()
			desktopInstall.running = false
			desktopInstall.mu.Unlock()
		}()
		emitAppEvent(desktopInstallEvent, desktopInstallEventPayload{
			Phase: "running", Stage: desktopmcp.StageWheel, Detail: "准备安装", Percent: 1,
		})
		steps, err := desktopmcp.Install(ctx, func(p desktopmcp.Progress) {
			desktopInstall.mu.Lock()
			desktopInstall.progress = p
			desktopInstall.mu.Unlock()
			emitAppEvent(desktopInstallEvent, desktopInstallEventPayload{
				Phase: "running", Stage: p.Stage, Detail: p.Detail, Percent: p.Percent, Line: p.Line,
			})
		})
		if err != nil {
			desktopInstall.mu.Lock()
			desktopInstall.failed = true
			desktopInstall.errText = err.Error()
			desktopInstall.mu.Unlock()
			emitAppEvent(desktopInstallEvent, desktopInstallEventPayload{
				Phase: "error", Stage: desktopmcp.StageDone, Percent: 100,
				Error: err.Error(), Steps: steps,
			})
			return
		}
		desktopInstall.mu.Lock()
		desktopInstall.done = true
		desktopInstall.progress = desktopmcp.Progress{Stage: desktopmcp.StageDone, Detail: "安装完成", Percent: 100}
		desktopInstall.mu.Unlock()
		emitAppEvent(desktopInstallEvent, desktopInstallEventPayload{
			Phase: "done", Stage: desktopmcp.StageDone, Detail: "安装完成", Percent: 100, Steps: steps,
		})
	}()
	return MCPDesktopInstallStartResult{Started: true}
}

// MCPDesktopDoctorResult 桌面 doctor 的探测结果（前端拼进诊断面板）。
type MCPDesktopDoctorResult struct {
	UVFound     bool     `json:"uvFound"`     // uv 在 PATH 上（uvx 可直接用）
	UVPath      string   `json:"uvPath"`      // PATH 命中的 uv 可执行文件路径
	UVHomeFound bool     `json:"uvHomeFound"` // uv 在 %USERPROFILE%\.local\bin（官方安装器默认位，可能不在 PATH）
	UVHome      string   `json:"uvHome"`      // 该候选路径（无论是否存在，供前端给安装提示）
	Hints       []string `json:"hints,omitempty"`
}

// resolveUvCandidates 纯函数：PATH 之外的 uv 探测位置——官方安装脚本默认装到
// 用户主目录 .local\bin。home 为空返回 nil。Windows 上安装的是 uv.exe 而 os.Stat
// 不做 PATHEXT 解析——候选必须显式带扩展名，同时保留无扩展名形态覆盖非 Windows。
func resolveUvCandidates(home string) []string {
	if home == "" {
		return nil
	}
	bin := filepath.Join(home, ".local", "bin")
	return []string{
		filepath.Join(bin, "uv.exe"),
		filepath.Join(bin, "uv"),
	}
}

// MCPDesktopDoctor 解析 uv 的位置。纯读、无子进程（LookPath 只查目录，不执行）、
// 无副作用；首次安装说明由前端按结果拼。
func (a *App) MCPDesktopDoctor() MCPDesktopDoctorResult {
	result := MCPDesktopDoctorResult{}
	if path, err := exec.LookPath("uv"); err == nil {
		result.UVFound = true
		result.UVPath = path
	}
	home, err := os.UserHomeDir()
	for _, candidate := range resolveUvCandidates(home) {
		result.UVHome = candidate
		if _, statErr := os.Stat(candidate); statErr == nil {
			result.UVHomeFound = true
		}
	}
	if err != nil {
		result.Hints = append(result.Hints, "无法定位用户主目录："+err.Error())
	}
	if !result.UVFound && !result.UVHomeFound {
		result.Hints = append(result.Hints,
			"未找到 uv：桌面 server 依赖它启动 windows-mcp（首次运行会下载 Python 3.14 解释器与依赖，约 100–190 MB）。",
			"安装命令：powershell -ExecutionPolicy Bypass -Command \"irm https://astral.sh/uv/install.ps1 | iex\"（装到用户目录，免管理员；装完重开应用生效）。")
	} else if !result.UVFound && result.UVHomeFound {
		result.Hints = append(result.Hints,
			"uv 在用户目录但不在 PATH："+result.UVHome+"。桌面控制安装流程会直接用它，无需改 PATH。")
	}
	return result
}
