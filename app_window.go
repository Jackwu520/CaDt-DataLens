package main

// 应用状态与窗口：脏标记、应用配置（open mode）、多窗口与资源管理器定位。

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/appconfig"
	"datalens/internal/clipboard"
	"datalens/internal/cmdbridge"
	"datalens/internal/launchargs"
	"datalens/internal/shellexec"
)

func (a *App) SetDirty(ctx context.Context, dirty bool) {
	if st := stateForCaller(ctx); st != nil {
		st.SetDirty(dirty)
	}
}

// SetAIRunning：前端在 AI 回合开始/结束时同步（关窗二次确认依据，见 beforeCloseWindow）。
func (a *App) SetAIRunning(ctx context.Context, running bool) {
	if st := stateForCaller(ctx); st != nil {
		st.SetAIRunning(running)
	}
}

// uniqueIDForLaunch：P2 起所有模式共用同一单实例锁——第二个进程一律转发给
// 已运行实例，由 secondInstance 决定开主窗口 / 浮窗 / 调试控制台。
// CADT_UNIQUE_ID 可覆盖（并行测试/便携多配置隔离用），默认值与原单实例 ID 一致。
func uniqueIDForLaunch() string {
	if v := strings.TrimSpace(os.Getenv("CADT_UNIQUE_ID")); v != "" {
		return v
	}
	return "cadt-datalens-7f3a9c21"
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
	a.openMainWindow(windowSpec{})
	return nil
}

// OpenDirInNewWindow 在独立新窗口打开目录（一目录一窗口）。
func (a *App) OpenDirInNewWindow(dir string) error {
	dir, err := validateWindowDir(dir)
	if err != nil {
		return err
	}
	a.openMainWindow(windowSpec{
		Workspace: dir,
		Targets:   []launchargs.OpenTarget{{Path: dir}},
	})
	return nil
}

// OpenWorkspaceForConversation 软切换：另开窗口打开目标工作区，并把目标 AI 会话 id
// 传给新窗口（新窗口启动后恢复工作区环境并选中该会话）。
func (a *App) OpenWorkspaceForConversation(dir string, sessionID string) error {
	dir, err := validateWindowDir(dir)
	if err != nil {
		return err
	}
	a.openMainWindow(windowSpec{
		Workspace: dir,
		Targets:   []launchargs.OpenTarget{{Path: dir}},
		SessionID: sessionID,
	})
	return nil
}

// validateWindowDir 校验「打开窗口」的目录参数（空/不存在/不是目录都报错）。
func validateWindowDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("目录为空")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("目录不存在：%s", dir)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", dir)
	}
	return dir, nil
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
	return clipboardSetText(text)
}

func (a *App) GetClipboardText() (string, error) {
	return clipboardGetText()
}

// GetClipboardImage 把剪贴板里的图片读成 PNG data URL（空串表示没有图片）。
// 编辑器/AI 输入框的右键菜单「粘贴」拿不到 paste 事件，只能由后端回读系统剪贴板。
func (a *App) GetClipboardImage() (string, error) {
	return clipboard.ImageDataURL()
}

func (a *App) OpenInNewWindows(paths []string) error {
	_ = a.SetOpenMode("window")
	for _, p := range paths {
		if strings.TrimSpace(p) == "" {
			continue
		}
		a.openMainWindow(windowSpec{Targets: []launchargs.OpenTarget{{Path: p}}})
	}
	return nil
}

func (a *App) SetWindowBg(ctx context.Context, r, g, b int) {
	clamp := func(v int) uint8 {
		if v < 0 {
			return 0
		}
		if v > 255 {
			return 255
		}
		return uint8(v)
	}
	w := callerWindow(ctx)
	if w == nil {
		w = currentWindow()
	}
	if w != nil {
		w.SetBackgroundColour(application.NewRGBA(clamp(r), clamp(g), clamp(b), 255))
	}
}

// beforeCloseWindow 是单个窗口的关窗确认（v2 OnBeforeClose 的等价物）。
func (a *App) beforeCloseWindow(st *windowState) bool {
	if st == nil {
		return false
	}
	isMain := st.startup().Mode == windowModeMain
	// 设置里选了「最小化到托盘」：点 X 只是把窗口藏起来，进程与后台任务全部照旧跑。
	// 只有主窗口参与；且只在该窗口是最后一个主窗口时才藏（否则直接关掉本窗口）。
	if a.convert == nil && isMain && traySupported() &&
		shouldHideOnClose(a.closeAction, true, st.forceClosed(), a.quitRequested.Load(), systemShuttingDown(), winReg.countMain()-1) {
		setMainWindow(st.window())
		a.hideToTray(st.window())
		return true
	}
	// 关窗二次确认的依据不止「AI 回合进行中」：终端会话与 AI 后台命令作业都会随窗口
	// 关闭被静默终止，一并计入。终端/后台命令当前是进程级计数，只对主窗口生效
	//（浮窗/调试控制台不承载它们，避免误报）。
	terms, bgJobs := 0, 0
	if isMain {
		terms = a.Terminal.RunningSessionCount()
		bgJobs = cmdbridge.RunningAIJobCount()
	}
	if st.forceClosed() || (!st.IsDirty() && !st.IsAIRunning() && terms == 0 && bgJobs == 0) {
		if winReg.countMain() <= 1 {
			a.stopTray()
			a.mcpCloseAll()         // MCP 子进程全量关闭（总预算 8s，超时靠 taskkill 兜底）
			a.AppServices.StopAll() // 插件后台服务全量停止（取消即杀整棵进程树）
			a.UnwatchWorkspace()
		}
		return false
	}
	if w := st.window(); w != nil {
		w.EmitEvent("confirm-close", map[string]interface{}{
			"dirty": st.IsDirty(), "aiRunning": st.IsAIRunning(), "terms": terms, "bgJobs": bgJobs,
		})
	}
	return true
}

func (a *App) ForceClose(ctx context.Context) {
	st := stateForCaller(ctx)
	if st == nil {
		return
	}
	st.markForceClose()
	st.SetDirty(false)
	st.SetAIRunning(false)
	lastMain := winReg.countMain() <= 1
	if lastMain {
		a.stopTray()
		a.mcpCloseAll()
		a.AppServices.StopAll()
		a.UnwatchWorkspace()
	}
	closeWindow(st.window())
}
