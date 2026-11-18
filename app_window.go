package main

// 应用状态与窗口：脏标记、应用配置（open mode）、多窗口与资源管理器定位。

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"datalens/internal/appconfig"
	"datalens/internal/clipboard"
	"datalens/internal/cmdbridge"
	"datalens/internal/launchargs"
	"datalens/internal/newwindow"
	"datalens/internal/shellexec"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) SetDirty(dirty bool) {
	a.dirty = dirty
}

// SetAIRunning：前端在 AI 回合开始/结束时同步（关窗二次确认依据，见 beforeClose）。
func (a *App) SetAIRunning(running bool) {
	a.aiRunning = running
}

func uniqueIDForLaunch() string {
	return launchargs.UniqueIDForArgs(os.Args[1:], appconfig.OpenMode())
}

func (a *App) GetOpenMode() string {
	return appconfig.OpenMode()
}

func (a *App) GetAppVersion() string {
	return appVersion
}

func (a *App) SetOpenMode(mode string) error {
	if mode != "window" {
		mode = "tab"
	}
	cfg := appconfig.Read()
	cfg.OpenMode = mode
	return appconfig.Save(cfg)
}

func (a *App) OpenNewWindow() error {
	return newwindow.Open()
}

// OpenDirInNewWindow 在独立新窗口打开目录（一目录一窗口）。
func (a *App) OpenDirInNewWindow(dir string) error {
	return newwindow.OpenDir(dir)
}

// OpenWorkspaceForConversation 软切换：当前窗口已有工作区时，另开窗口打开目标工作区，
// 并把目标 AI 会话 id 传给新窗口（新窗口启动后恢复工作区环境并选中该会话）。
func (a *App) OpenWorkspaceForConversation(dir string, sessionID string) error {
	return newwindow.OpenWorkspaceConversation(dir, sessionID)
}

func (a *App) ShowInFolder(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("路径不存在：%s", path)
	}
	cmd := exec.Command("explorer.exe", explorerArgs(path, info.IsDir())...)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// OpenWithDefaultApp 用系统默认关联程序打开文件或目录（右键「用默认应用打开」）。
// 路径先校验存在性：ShellExecute 对不存在的路径只会给出含糊的错误码。
func (a *App) OpenWithDefaultApp(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("没有文件路径")
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("路径不存在：%s", path)
	}
	return shellexec.Open(filepath.Clean(path))
}

// explorerArgs 构造 ShowInFolder 传给 explorer.exe 的参数。
// 路径必须先经 filepath.Clean 归一成 Windows 原生分隔符：前端（AI 日志目录等）传来的
// 路径是正斜杠形式，explorer.exe 的命令行解析把 / 开头的段当开关处理，
// 解析失败时不会报错，而是回退打开「文档」文件夹。
func explorerArgs(path string, isDir bool) []string {
	cleaned := filepath.Clean(path)
	if isDir {
		return []string{cleaned}
	}
	return []string{"/select,", cleaned}
}

func (a *App) CopyText(text string) error {
	return runtime.ClipboardSetText(a.ctx, text)
}

func (a *App) GetClipboardText() (string, error) {
	return runtime.ClipboardGetText(a.ctx)
}

// GetClipboardImage 把剪贴板里的图片读成 PNG data URL（空串表示没有图片）。
// 编辑器/AI 输入框的右键菜单「粘贴」拿不到 paste 事件，只能由后端回读系统剪贴板。
func (a *App) GetClipboardImage() (string, error) {
	return clipboard.ImageDataURL()
}

func (a *App) OpenInNewWindows(paths []string) error {
	_ = a.SetOpenMode("window")
	_, err := newwindow.OpenFiles(paths)
	return err
}

func (a *App) SetWindowBg(r, g, b int) {
	clamp := func(v int) uint8 {
		if v < 0 {
			return 0
		}
		if v > 255 {
			return 255
		}
		return uint8(v)
	}
	runtime.WindowSetBackgroundColour(a.ctx, clamp(r), clamp(g), clamp(b), 255)
}

func (a *App) beforeClose(ctx context.Context) bool {
	// 关窗二次确认的依据不止「AI 回合进行中」：终端会话（含用户自己开的，仅在 shell 里
	// 真有命令进程在跑时才计数，空闲提示符放行）与 AI 后台命令作业（background_command，
	// 回合结束后仍长驻）都会随窗口关闭被静默终止，一并计入。
	terms := a.Terminal.RunningSessionCount()
	bgJobs := cmdbridge.RunningAIJobCount()
	if a.forceClose || (!a.dirty && !a.aiRunning && terms == 0 && bgJobs == 0) {
		a.mcpCloseAll() // MCP 子进程全量关闭（总预算 8s，超时靠 taskkill 兜底）
		a.UnwatchWorkspace()
		return false
	}
	runtime.EventsEmit(ctx, "confirm-close", map[string]interface{}{
		"dirty": a.dirty, "aiRunning": a.aiRunning, "terms": terms, "bgJobs": bgJobs,
	})
	return true
}

func (a *App) ForceClose() {
	a.forceClose = true
	a.dirty = false
	a.aiRunning = false
	a.mcpCloseAll()
	a.UnwatchWorkspace()
	runtime.Quit(a.ctx)
}
