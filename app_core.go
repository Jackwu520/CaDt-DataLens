package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"datalens/internal/aichat"
	"datalens/internal/aiconfig"
	"datalens/internal/aigroups"
	"datalens/internal/aischedule"
	"datalens/internal/aitimer"
	"datalens/internal/appconfig"
	"datalens/internal/appservices"
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
	"datalens/internal/tray"
	"datalens/internal/usagestats"
	"datalens/internal/watch"
)

const appVersion = "v1.2.0"

type App struct {
	*reading.Reader                              // 阅读模式引擎（internal/reading），提升方法即 Wails 绑定
	*run.Runner                                  // 运行代码引擎（internal/run）
	*browser.Host                                // 内嵌浏览器引擎（internal/browser）
	*search.Searcher                             // 工作区检索 / glob（internal/search）
	*aischedule.Scheduler                        // AI 定时任务调度器（internal/aischedule）
	*cmdbridge.Bridge                            // 进程桥：插件 / AI 终端命令（internal/cmdbridge）
	*terminal.Terminal                           // 内置终端后端（internal/terminal）
	*toolchain.Toolchain                         // 语言环境检测（internal/toolchain）
	*aiconfig.Store                              // AI 配置文件读写（internal/aiconfig）
	*plugins.Manager                             // 插件与市场（internal/plugins）
	AppServices            *appservices.Registry // 插件后台服务托管（internal/appservices）
	*skills.Skills                               // 内置技能与 agent 技能注册（internal/skills）
	*screenshot.Capturer                         // 应用窗口截图（internal/screenshot）
	*notify.Notifier                             // 系统通知（internal/notify）
	*watch.Watcher                               // 工作区文件监听（internal/watch）
	*fileio.Files                                // 文件读写与编码（internal/fileio）
	*fsops.FS                                    // 目录与条目操作（internal/fsops）
	*debugconsole.Console                        // 调试控制台日志（internal/debugconsole）
	*aichat.Chat                                 // AI 对话与流注册表（internal/aichat）
	*integration.Registrar                       // Windows 文件关联 / 右键菜单 / PATH（internal/integration）
	*mcpsamples.Samples                          // 内置 MCP 示例（internal/mcpsamples）
	*sessionstore.Service                        // AI 会话磁盘存储（internal/sessionstore）
	*aigroups.GroupStore                         // AI 群聊磁盘存储（internal/aigroups），提升方法即 AIGroup* 绑定
	*mcp.Client                                  // MCP 客户端与子进程管理（internal/mcp）
	ctx                    context.Context
	aiTimersMu             sync.Mutex
	aiTimers               *aitimer.Registry
	convert                *convertcli.Options
	convertExitCode        int
	convertDone            atomic.Bool

	// 关闭行为：点窗口 X 是直接退出（exit）还是隐藏到托盘（tray）。见 app_close_action.go。
	closeAction   string
	quitRequested atomic.Bool // 显式「退出」（菜单 / 托盘右键 / ForceClose）时置位，绕开「最小化到托盘」
	teardownDone  atomic.Bool // 应用级服务（托盘/MCP/插件/工作区监听）只收口一次
	tray          *tray.Tray
	trayHintShown bool
}

// FileData 兼容别名（实现已下沉 internal/fileio）。
type FileData = fileio.FileData

func NewApp() *App {
	return &App{Reader: &reading.Reader{}, Runner: &run.Runner{}, Host: &browser.Host{}, Searcher: &search.Searcher{}, Scheduler: &aischedule.Scheduler{}, Bridge: &cmdbridge.Bridge{}, Terminal: &terminal.Terminal{}, Toolchain: &toolchain.Toolchain{}, Store: &aiconfig.Store{}, Manager: &plugins.Manager{}, AppServices: appservices.New(), Skills: &skills.Skills{}, Capturer: &screenshot.Capturer{}, Notifier: &notify.Notifier{}, Watcher: &watch.Watcher{}, Samples: &mcpsamples.Samples{}, Files: &fileio.Files{}, FS: &fsops.FS{}, Registrar: &integration.Registrar{}, Console: &debugconsole.Console{}, Chat: &aichat.Chat{}, Service: &sessionstore.Service{}, GroupStore: &aigroups.GroupStore{}, Client: &mcp.Client{}}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 关闭行为（点 X 退出还是最小化到托盘）：配置在 config.json，前端设置页只负责推过来。
	a.closeAction = appconfig.CloseAction()
	reading.Emit = func(event string, data any) {
		routeOwnedEvent("reading", event, data)
	}
	run.Emit = func(event string, data any) {
		routeOwnedEvent("run", event, data)
	}
	browser.Emit = func(event string, data any) {
		routeOwnedEvent("browser", event, data)
	}
	aischedule.Emit = func(event string, data any) {
		emitAppEvent(event, data)
	}
	cmdbridge.Emit = func(event string, data any) {
		routeOwnedEvent("cmd", event, data)
	}
	terminal.Emit = func(event string, data any) {
		routeOwnedEvent("term", event, data)
	}
	watch.Emit = func(event string, data any) {
		emitAppEvent(event, data)
	}
	aichat.Emit = func(event string, payload any) {
		emitAppEvent(event, payload)
	}
	watch.Logf = writeAppLog
	if a.convert != nil {
		a.waitConvertTimeout()
		return
	}
	// 系统通知的应用标识必须在发出第一条 Toast 之前登记好，
	// 否则 Windows 只返回成功、不显示（见 internal/notify 的 ensureToastAppID）。
	// 点击通知的激活回调也在这里接上：把窗口拉回前台 + 把激活参数转给前端。
	notify.OnToastActivation = a.onToastActivation
	notify.Prepare()
	sqlview.CleanupTempFiles()
	reading.CleanupCacheOnStartup()
	// 运行代码的临时副本 / 编译产物：启动时清一次过期的（7 天），失败不影响启动；
	// 多窗口可能各跑一次，RemoveAll 幂等所以无害。
	go func() { _, _ = a.CleanupRunTempStale() }()
	// 全局热键与显示器布局看护：与窗口模式无关，进程活着就工作。
	a.registerGlobalHotkeys()
	a.startScreenWatch()
	// 无主窗口的形态（--ai-float / --debug-console / 终端独立窗口作首窗）：
	// AI 定时任务、插件后台服务、MCP 客户端、使用统计都是主窗口域的服务，
	// 不在这里拉起（ctx 之外拿不到窗口形态，直接按主窗口数判定）。
	// AI 侧服务只在有主窗口的进程里拉起；浮窗/调试台/终端窗首启时先跳过，
	// 之后开出的第一个主窗口经 ensureAIServices 惰性补齐（审查 P2-1：v3 单进程
	// 多窗口后窗口形态可动态变化，一次性门控会漏掉后续主窗口）。
	if winReg.countMain() > 0 {
		a.ensureAIServices()
	}
	// 外部文件拖放由前端 runtime.OnFileDrop 注册窗口监听并直接打开；
	// 这里不再订阅 wails:file-drop，否则同一次拖放会被两侧各处理一遍。
}

// aiServicesOnce：AI 定时任务 / 插件后台服务 / MCP 客户端 / 使用统计只在
// 首个主窗口出现时初始化一次（startup 时有主窗口直接拉起；没有则由后续
// createWindow(main) 补齐）。
var aiServicesOnce sync.Once

func (a *App) ensureAIServices() {
	aiServicesOnce.Do(func() {
		// AI 定时任务调度器：主窗口与 AI 悬浮窗各自扫描，执行去重由前端裁决
		aischedule.Start()
		// 插件后台服务：启动已声明且 autoStart 的服务（声明由前端加载插件后 Sync 推送；
		// 此处对空注册表无害，保留以覆盖未来持久化声明的场景）。
		a.AppServices.StartAll()
		// MCP 客户端 + 使用统计回填（浮窗/调试控制台/终端窗口不拉子进程/不扫会话）
		usagestats.Start()
		if err := mcp.InitClient(a.Client, func(event string, payload any) {
			emitAppEvent(event, payload)
		}); err != nil {
			// 损坏的 mcp.json 不阻塞启动：设置页会读到同样的错误并展示路径
			writeAppLog("warn", "MCP 配置加载失败：%v", err)
		}
	})
}

func (a *App) secondInstance(args []string) {
	if launchargs.HasFlag(args, "--ai-float") {
		a.ensureFloatWindow(launchargs.ParseOpenTargets(args)...)
		return
	}
	if launchargs.HasFlag(args, "--debug-console") {
		a.ensureDebugWindow()
		return
	}
	// 下面这些分支都会把某个窗口拉到前台：顺手清托盘态（v2 每分支都走
	// secondInstanceShow，审查 P2-2）。
	a.clearTrayState()
	if pane := launchargs.ParseOpenSettingsArg(args); pane != "" {
		// 无主窗口形态回退浮窗（与 OpenSettingsInMainWindow 同构，审查 P2-1）。
		st := winReg.primary()
		if st == nil {
			st = winReg.get("float")
		}
		if st != nil {
			emitWindowEventTo(st.window(), "app-open-settings", pane)
			activateWindow(st.window())
		}
		return
	}
	if loc := launchargs.ParseMemoLocatorArg(args); loc != "" {
		st := winReg.primary()
		if st == nil {
			st = winReg.get("float")
		}
		if st != nil {
			emitWindowEventTo(st.window(), "app-open-memo", loc)
			activateWindow(st.window())
		}
		return
	}
	targets := launchargs.ParseOpenTargets(args)
	if len(targets) == 0 {
		targets = launchargs.StartupCwdTarget()
	}
	if len(targets) == 0 {
		a.secondInstanceShow()
		return
	}
	// 窗口打开模式（或显式 --new-window）：总是开新窗口；否则投给主窗口。
	if launchargs.HasFlag(args, "--new-window") || appconfig.OpenMode() == "window" {
		// --new-window <dir> --ai-session=<id> 组合：会话 id 随窗口启动上下文带入
		//（v2 的独立进程冷启动解析同一参数，审查 P2-6）。
		a.openMainWindow(windowSpec{
			Targets:   targets,
			SessionID: launchargs.ParseAISessionArg(args),
		})
		return
	}
	if st := winReg.primary(); st != nil {
		deliverOpenTargets(st, openTargetsAny(targets))
		return
	}
	a.openMainWindow(windowSpec{Targets: targets})
}

// openTargetsAny 把 []launchargs.OpenTarget 转成事件投递的 []any（JSON 形状不变）。
func openTargetsAny(targets []launchargs.OpenTarget) []any {
	out := make([]any, 0, len(targets))
	for _, t := range targets {
		out = append(out, t)
	}
	return out
}

// onToastActivation 系统通知被点击（internal/notify 的 COM 激活回调，可能在任意 COM 线程触发）：
// 先把主窗口拉回前台，再把激活参数原文发给前端自行解析跳转（空参数只拉窗口）。
func (a *App) onToastActivation(payload string) {
	if a.ctx == nil {
		return
	}
	st := winReg.primary()
	if st == nil {
		// 无主窗口形态（浮窗单独运行）：通知点击回退唤起浮窗（审查 P2-9）。
		st = winReg.get("float")
	}
	if st != nil {
		activateWindow(st.window())
		if strings.TrimSpace(payload) != "" {
			emitWindowEventTo(st.window(), "ai-notify-activate", payload)
		}
	}
}

// ConsumeStartupSettings 返回该窗口启动时携带的设置页并清空（供前端启动后打开）。
func (a *App) ConsumeStartupSettings(ctx context.Context) string {
	st := stateForCaller(ctx)
	if st == nil {
		return ""
	}
	st.mu.Lock()
	pane := st.spec.SettingsPane
	st.spec.SettingsPane = ""
	st.mu.Unlock()
	return pane
}

// GetStartupAISession 返回该窗口启动时要打开的 AI 会话 id（软切换新窗口使用）。
func (a *App) GetStartupAISession(ctx context.Context) string {
	if st := stateForCaller(ctx); st != nil {
		return st.startup().SessionID
	}
	return ""
}

// GetStartupMemoLocator 返回该窗口启动时要跳转的便签定位点（cadt-memo://scope/kind/id）。
func (a *App) GetStartupMemoLocator(ctx context.Context) string {
	if st := stateForCaller(ctx); st != nil {
		return st.startup().MemoLocator
	}
	return ""
}

func (a *App) GetStartupTargets(ctx context.Context) []launchargs.OpenTarget {
	st := stateForCaller(ctx)
	if st == nil {
		return []launchargs.OpenTarget{}
	}
	targets := st.startup().Targets
	if len(targets) == 0 {
		return launchargs.StartupCwdTarget()
	}
	return targets
}

func (a *App) GetStartupFiles(ctx context.Context) []string {
	st := stateForCaller(ctx)
	if st == nil {
		return []string{}
	}
	targets := st.startup().Targets
	files := make([]string, 0, len(targets))
	for _, target := range targets {
		files = append(files, target.Path)
	}
	return files
}

// hasArg 判断启动参数里是否带有某个开关（独立窗口/调试控制台等）。
func hasArg(flag string) bool {
	return launchargs.HasFlag(os.Args[1:], flag)
}
