package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"datalens/internal/aichat"
	"datalens/internal/aiconfig"
	"datalens/internal/aischedule"
	"datalens/internal/aitimer"
	"datalens/internal/browser"
	"datalens/internal/cmdbridge"
	"datalens/internal/debugconsole"
	"datalens/internal/fileio"
	"datalens/internal/fsops"
	"datalens/internal/integration"
	"datalens/internal/mcp"
	"datalens/internal/mcpsamples"
	"datalens/internal/notify"
	"datalens/internal/plugins"
	"datalens/internal/reading"
	"datalens/internal/run"
	"datalens/internal/screenshot"
	"datalens/internal/search"
	"datalens/internal/skills"
	"datalens/internal/sqlview"
	"datalens/internal/terminal"
	"datalens/internal/toolchain"
	"datalens/internal/watch"
)

const appVersion = "v1.1.0"

type App struct {
	*reading.Reader        // 阅读模式引擎（internal/reading），提升方法即 Wails 绑定
	*run.Runner            // 运行代码引擎（internal/run）
	*browser.Host          // 内嵌浏览器引擎（internal/browser）
	*search.Searcher       // 工作区检索 / glob（internal/search）
	*aischedule.Scheduler  // AI 定时任务调度器（internal/aischedule）
	*cmdbridge.Bridge      // 进程桥：插件 / AI 终端命令（internal/cmdbridge）
	*terminal.Terminal     // 内置终端后端（internal/terminal）
	*toolchain.Toolchain   // 语言环境检测（internal/toolchain）
	*aiconfig.Store        // AI 配置文件读写（internal/aiconfig）
	*plugins.Manager       // 插件与市场（internal/plugins）
	*skills.Skills         // 内置技能与 agent 技能注册（internal/skills）
	*screenshot.Capturer   // 应用窗口截图（internal/screenshot）
	*notify.Notifier       // 系统通知（internal/notify）
	*watch.Watcher         // 工作区文件监听（internal/watch）
	*fileio.Files          // 文件读写与编码（internal/fileio）
	*fsops.FS              // 目录与条目操作（internal/fsops）
	*debugconsole.Console  // 调试控制台日志（internal/debugconsole）
	*aichat.Chat           // AI 对话与流注册表（internal/aichat）
	*integration.Registrar // Windows 文件关联 / 右键菜单 / PATH（internal/integration）
	*mcpsamples.Samples    // 内置 MCP 示例（internal/mcpsamples）
	ctx                    context.Context
	startupTargets         []OpenTarget
	startupSettingsPane    string
	startupAISession       string
	dirty                  bool
	forceClose             bool
	aiRunning              bool
	aiTimersMu             sync.Mutex
	aiTimers               *aitimer.Registry
	muMCP                  sync.Mutex
	mcp                    *mcp.Manager
	convert                *convertOptions
	convertExitCode        int
	convertDone            atomic.Bool
}

type OpenTarget struct {
	Path   string `json:"path"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

// FileData 兼容别名（实现已下沉 internal/fileio）。
type FileData = fileio.FileData

func NewApp() *App {
	return &App{Reader: &reading.Reader{}, Runner: &run.Runner{}, Host: &browser.Host{}, Searcher: &search.Searcher{}, Scheduler: &aischedule.Scheduler{}, Bridge: &cmdbridge.Bridge{}, Terminal: &terminal.Terminal{}, Toolchain: &toolchain.Toolchain{}, Store: &aiconfig.Store{}, Manager: &plugins.Manager{}, Skills: &skills.Skills{}, Capturer: &screenshot.Capturer{}, Notifier: &notify.Notifier{}, Watcher: &watch.Watcher{}, Samples: &mcpsamples.Samples{}, Files: &fileio.Files{}, FS: &fsops.FS{}, Registrar: &integration.Registrar{}, Console: &debugconsole.Console{}, Chat: &aichat.Chat{}}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	reading.Emit = func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
	}
	run.Emit = func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
	}
	browser.Emit = func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
	}
	aischedule.Emit = func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
	}
	cmdbridge.Emit = func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
	}
	terminal.Emit = func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
	}
	watch.Emit = func(event string, data any) {
		runtime.EventsEmit(ctx, event, data)
	}
	watch.Logf = writeAppLog
	if a.convert != nil {
		a.waitConvertTimeout()
		return
	}
	applyTaskbarIcon()
	// 系统通知的应用标识必须在发出第一条 Toast 之前登记好，
	// 否则 Windows 只返回成功、不显示（见 internal/notify 的 ensureToastAppID）。
	notify.Prepare()
	ensureWindowShown(ctx)
	sqlview.CleanupTempFiles()
	reading.CleanupCacheOnStartup()
	// 运行代码的临时副本 / 编译产物：启动时清一次过期的（7 天），失败不影响启动；
	// 多窗口进程可能各跑一次，RemoveAll 幂等所以无害。
	go func() { _, _ = a.CleanupRunTempStale() }()
	if a.IsDebugConsoleWindow() {
		// 独立调试控制台窗口：小尺寸独立窗，不处理启动文件/目录
		runtime.WindowSetTitle(ctx, "调试控制台 · CaDt-DataLens")
		runtime.WindowSetSize(ctx, 780, 460)
		return
	}
	// AI 定时任务调度器：主窗口与 AI 悬浮窗进程各自扫描，执行去重由前端裁决
	a.Scheduler.Start()
	// MCP 客户端：仅主窗口进程初始化（浮窗/调试控制台不拉 MCP 子进程，避免同机双实例）
	if !a.IsAIFloatWindow() && !a.IsDebugConsoleWindow() {
		a.initMCPManager()
	}
	if a.IsAIFloatWindow() {
		runtime.WindowSetTitle(ctx, "AI 助手 · CaDt-DataLens")
	}
	a.startupSettingsPane = parseOpenSettingsArg(os.Args[1:])
	a.startupAISession = parseAISessionArg(os.Args[1:])
	a.startupTargets = parseOpenTargets(os.Args[1:])
	// 外部文件拖放由前端 runtime.OnFileDrop 注册窗口监听并直接打开；
	// 这里不再订阅 wails:file-drop，否则同一次拖放会被两侧各处理一遍。
}

// domReady 页面就绪后再显示窗口，避开 WebView2 初始化占住 UI 线程的那段时间。
func (a *App) domReady(ctx context.Context) {
	if a.convert != nil {
		return
	}
	showWindowWhenReady(ctx)
}

func (a *App) secondInstance(data options.SecondInstanceData) {
	if pane := parseOpenSettingsArg(data.Args); pane != "" {
		runtime.EventsEmit(a.ctx, "app-open-settings", pane)
		runtime.WindowShow(a.ctx)
		return
	}
	targets := parseOpenTargets(data.Args)
	if len(targets) == 0 {
		targets = startupCwdTarget()
	}
	if len(targets) > 0 {
		runtime.EventsEmit(a.ctx, "open-targets", targets)
	}
	// 只用 WindowShow：Windows 上 WindowUnminimise 走 WM_SYSCOMMAND/SC_RESTORE，
	// 会把最大化的窗口还原成普通窗口；WindowShow 内部只在最小化时才恢复。
	runtime.WindowShow(a.ctx)
}

func parseOpenSettingsArg(args []string) string {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if strings.HasPrefix(arg, "--open-settings=") {
			return strings.TrimPrefix(arg, "--open-settings=")
		}
	}
	return ""
}

func parseAISessionArg(args []string) string {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if strings.HasPrefix(arg, "--ai-session=") {
			return strings.TrimSpace(strings.TrimPrefix(arg, "--ai-session="))
		}
	}
	return ""
}

// ConsumeStartupSettings 返回本次启动携带的设置页并清空（供前端启动后打开）。
func (a *App) ConsumeStartupSettings() string {
	pane := a.startupSettingsPane
	a.startupSettingsPane = ""
	return pane
}

// GetStartupAISession 返回本次启动要打开的 AI 会话 id（软切换新窗口使用）。
func (a *App) GetStartupAISession() string {
	return a.startupAISession
}

func pathArgs(args []string) []string {
	exe, _ := os.Executable()
	var paths []string
	for _, arg := range args {
		if arg == "" || strings.HasPrefix(arg, "-") || strings.EqualFold(arg, exe) {
			continue
		}
		if _, err := os.Stat(arg); err == nil {
			paths = append(paths, arg)
		}
	}
	return paths
}

func firstPathArg(args []string) string {
	if paths := pathArgs(args); len(paths) > 0 {
		return paths[0]
	}
	return ""
}

func positiveInt(value string) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func splitPathLine(arg string) (string, int, int, bool) {
	lastColon := strings.LastIndex(arg, ":")
	if lastColon <= 0 {
		return "", 0, 0, false
	}
	line, err := strconv.Atoi(arg[lastColon+1:])
	if err != nil || line <= 0 {
		return "", 0, 0, false
	}
	prefix := arg[:lastColon]
	if _, err := os.Stat(prefix); err == nil {
		return prefix, line, 0, true
	}
	prevColon := strings.LastIndex(prefix, ":")
	if prevColon <= 0 {
		return "", 0, 0, false
	}
	middle, err := strconv.Atoi(prefix[prevColon+1:])
	if err != nil || middle <= 0 {
		return "", 0, 0, false
	}
	path := prefix[:prevColon]
	if _, err := os.Stat(path); err == nil {
		return path, middle, line, true
	}
	return "", 0, 0, false
}

func parseOpenTargets(args []string) []OpenTarget {
	exe, _ := os.Executable()
	targets := []OpenTarget{}
	pendingLine, pendingColumn := 0, 0
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		if arg == "" || strings.EqualFold(arg, exe) || arg == "--new-window" {
			continue
		}
		if arg == "--goto" || arg == "-g" {
			continue
		}
		if strings.HasPrefix(arg, "--line=") {
			pendingLine = positiveInt(strings.TrimPrefix(arg, "--line="))
			continue
		}
		if arg == "--line" || arg == "-l" {
			if i+1 < len(args) {
				i++
				pendingLine = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "--column=") {
			pendingColumn = positiveInt(strings.TrimPrefix(arg, "--column="))
			continue
		}
		if arg == "--column" || arg == "-c" {
			if i+1 < len(args) {
				i++
				pendingColumn = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		path := arg
		line, column := pendingLine, pendingColumn
		if _, err := os.Stat(path); err != nil {
			if p, l, c, ok := splitPathLine(arg); ok {
				path = p
				line = l
				if c > 0 {
					column = c
				}
			}
		}
		if _, err := os.Stat(path); err != nil {
			continue
		}
		targets = append(targets, OpenTarget{Path: path, Line: line, Column: column})
		pendingLine, pendingColumn = 0, 0
	}
	if len(targets) > 0 {
		last := &targets[len(targets)-1]
		if pendingLine > 0 && last.Line == 0 {
			last.Line = pendingLine
		}
		if pendingColumn > 0 && last.Column == 0 {
			last.Column = pendingColumn
		}
	}
	return targets
}

// startupCwdTarget 裸启动（无参数）时把当前目录作为工作区打开；
// 双击 exe 启动时 CWD 等于 exe 目录，此时返回空（走欢迎页）。
func startupCwdTarget() []OpenTarget {
	wd, err := os.Getwd()
	if err != nil || strings.TrimSpace(wd) == "" {
		return nil
	}
	if exe, exeErr := os.Executable(); exeErr == nil && exe != "" {
		if strings.EqualFold(filepath.Dir(exe), wd) {
			return nil
		}
	}
	info, err := os.Stat(wd)
	if err != nil || !info.IsDir() {
		return nil
	}
	return []OpenTarget{{Path: wd}}
}

func (a *App) GetStartupTargets() []OpenTarget {
	if a.startupTargets == nil {
		return []OpenTarget{}
	}
	if len(a.startupTargets) == 0 {
		return startupCwdTarget()
	}
	return a.startupTargets
}

func (a *App) GetStartupFiles() []string {
	files := make([]string, 0, len(a.startupTargets))
	for _, target := range a.startupTargets {
		files = append(files, target.Path)
	}
	return files
}

// hasArg 判断启动参数里是否带有某个开关（独立窗口/调试控制台等）。
func hasArg(flag string) bool {
	for _, arg := range os.Args[1:] {
		if arg == flag {
			return true
		}
	}
	return false
}
