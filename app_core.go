package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"datalens/internal/aichat"
	"datalens/internal/aiconfig"
	"datalens/internal/aigroups"
	"datalens/internal/aischedule"
	"datalens/internal/aitimer"
	"datalens/internal/browser"
	"datalens/internal/cmdbridge"
	"datalens/internal/convertcli"
	"datalens/internal/debugconsole"
	"datalens/internal/fileio"
	"datalens/internal/fsops"
	"datalens/internal/integration"
	"datalens/internal/launchargs"
	"datalens/internal/mcp"
	"datalens/internal/mcpsamples"
	"datalens/internal/notify"
	"datalens/internal/plugins"
	"datalens/internal/reading"
	"datalens/internal/run"
	"datalens/internal/screenshot"
	"datalens/internal/search"
	"datalens/internal/sessionstore"
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
	*sessionstore.Service  // AI 会话磁盘存储（internal/sessionstore）
	*aigroups.GroupStore   // AI 群聊磁盘存储（internal/aigroups），提升方法即 AIGroup* 绑定
	*mcp.Client            // MCP 客户端与子进程管理（internal/mcp）
	ctx                    context.Context
	startupTargets         []launchargs.OpenTarget
	startupSettingsPane    string
	startupAISession       string
	startupMemoLocator     string
	dirty                  bool
	forceClose             bool
	aiRunning              bool
	aiTimersMu             sync.Mutex
	aiTimers               *aitimer.Registry
	convert                *convertcli.Options
	convertExitCode        int
	convertDone            atomic.Bool
}

// FileData 兼容别名（实现已下沉 internal/fileio）。
type FileData = fileio.FileData

func NewApp() *App {
	return &App{Reader: &reading.Reader{}, Runner: &run.Runner{}, Host: &browser.Host{}, Searcher: &search.Searcher{}, Scheduler: &aischedule.Scheduler{}, Bridge: &cmdbridge.Bridge{}, Terminal: &terminal.Terminal{}, Toolchain: &toolchain.Toolchain{}, Store: &aiconfig.Store{}, Manager: &plugins.Manager{}, Skills: &skills.Skills{}, Capturer: &screenshot.Capturer{}, Notifier: &notify.Notifier{}, Watcher: &watch.Watcher{}, Samples: &mcpsamples.Samples{}, Files: &fileio.Files{}, FS: &fsops.FS{}, Registrar: &integration.Registrar{}, Console: &debugconsole.Console{}, Chat: &aichat.Chat{}, Service: &sessionstore.Service{}, GroupStore: &aigroups.GroupStore{}, Client: &mcp.Client{}}
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
	aichat.Emit = func(event string, payload any) {
		runtime.EventsEmit(ctx, event, payload)
	}
	watch.Logf = writeAppLog
	if a.convert != nil {
		a.waitConvertTimeout()
		return
	}
	applyTaskbarIcon()
	// 系统通知的应用标识必须在发出第一条 Toast 之前登记好，
	// 否则 Windows 只返回成功、不显示（见 internal/notify 的 ensureToastAppID）。
	// 点击通知的激活回调也在这里接上：把窗口拉回前台 + 把激活参数转给前端。
	notify.OnToastActivation = a.onToastActivation
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
	aischedule.Start()
	// MCP 客户端：仅主窗口进程初始化（浮窗/调试控制台不拉 MCP 子进程，避免同机双实例）
	if !a.IsAIFloatWindow() && !a.IsDebugConsoleWindow() {
		if err := mcp.InitClient(a.Client, func(event string, payload any) {
			runtime.EventsEmit(ctx, event, payload)
		}); err != nil {
			// 损坏的 mcp.json 不阻塞启动：设置页会读到同样的错误并展示路径
			writeAppLog("warn", "MCP 配置加载失败：%v", err)
		}
	}
	if a.IsAIFloatWindow() {
		runtime.WindowSetTitle(ctx, "AI 助手 · CaDt-DataLens")
	}
	a.startupSettingsPane = launchargs.ParseOpenSettingsArg(os.Args[1:])
	a.startupAISession = launchargs.ParseAISessionArg(os.Args[1:])
	a.startupMemoLocator = launchargs.ParseMemoLocatorArg(os.Args[1:])
	a.startupTargets = launchargs.ParseOpenTargets(os.Args[1:])
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
	if pane := launchargs.ParseOpenSettingsArg(data.Args); pane != "" {
		runtime.EventsEmit(a.ctx, "app-open-settings", pane)
		runtime.WindowShow(a.ctx)
		return
	}
	if loc := launchargs.ParseMemoLocatorArg(data.Args); loc != "" {
		runtime.EventsEmit(a.ctx, "app-open-memo", loc)
		runtime.WindowShow(a.ctx)
		return
	}
	targets := launchargs.ParseOpenTargets(data.Args)
	if len(targets) == 0 {
		targets = launchargs.StartupCwdTarget()
	}
	if len(targets) > 0 {
		runtime.EventsEmit(a.ctx, "open-targets", targets)
	}
	// 只用 WindowShow：Windows 上 WindowUnminimise 走 WM_SYSCOMMAND/SC_RESTORE，
	// 会把最大化的窗口还原成普通窗口；WindowShow 内部只在最小化时才恢复。
	runtime.WindowShow(a.ctx)
}

// onToastActivation 系统通知被点击（internal/notify 的 COM 激活回调，可能在任意 COM 线程触发）：
// 先把窗口拉回前台（语义与 secondInstance 一致，只用 WindowShow 避免还原最大化），
// 再把激活参数原文发给前端自行解析跳转（形如 "ai-session=<id>"；空参数只拉窗口）。
func (a *App) onToastActivation(payload string) {
	if a.ctx == nil {
		return
	}
	runtime.WindowShow(a.ctx)
	if strings.TrimSpace(payload) != "" {
		runtime.EventsEmit(a.ctx, "ai-notify-activate", payload)
	}
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

// GetStartupMemoLocator 返回本次启动要跳转的便签定位点（cadt-memo://scope/kind/id）。
func (a *App) GetStartupMemoLocator() string {
	return a.startupMemoLocator
}

func (a *App) GetStartupTargets() []launchargs.OpenTarget {
	if a.startupTargets == nil {
		return []launchargs.OpenTarget{}
	}
	if len(a.startupTargets) == 0 {
		return launchargs.StartupCwdTarget()
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
	return launchargs.HasFlag(os.Args[1:], flag)
}
