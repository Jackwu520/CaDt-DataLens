package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
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
	// --quit 优雅退出（外部重建脚本 / 工具）：各窗口结算 AI 回合后 ack，收齐或超时才退出。
	// 状态见 app_close_action.go 的 beginGracefulQuit。
	gracefulQuitStarted atomic.Bool
	gracefulAcksMu      sync.Mutex
	gracefulAcks        map[string]bool
	tray                *tray.Tray
	trayHintShown       bool
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

// forwardPlan 是 secondInstancePlan 的转发决策结果；窗口操作语义由 secondInstance 执行。
// 决策与执行分离：secondInstancePlan 是纯函数（表驱动测试见 secondinstance_plan_test.go），
// secondInstance 只碰窗口 API。
type forwardPlan struct {
	kind      string                  // quit | float | debug | settings | memo | sessionOpen | newWindow | deliver | show
	targets   []launchargs.OpenTarget // float：浮窗打开目标；settings/memo：随事件投递的打开目标
	groups    []targetGroup           // deliver：按路由窗口分组的打开目标（缺陷 E）
	sessionID string                  // sessionOpen/deliver/newWindow：目标 AI 会话
	workspace string                  // sessionOpen：会话归属工作区；deliver：与目标窗口一致时补投
	pane      string                  // settings：目标设置 pane
	locator   string                  // memo：便签定位点
}

// targetGroup 是 deliver 的一组同窗口打开目标（缺陷 E：按文件所属工作区路由）。
type targetGroup struct {
	windowName string                  // 路由命中的主窗口名；"" = 主窗口（primary）
	targets    []launchargs.OpenTarget // 归属同一窗口的目标
}

// forwardDeps 是 secondInstancePlan 的环境依赖（测试注入桩）。
type forwardDeps struct {
	resolveSessionWorkspace func(string) (string, error) // 会话 id → 归属工作区
	routeWindowForPath      func(string) string          // 文件路径 → 归属工作区窗口名（"" = 主窗口）
}

// routeWindowForPath 按文件路径的祖先链找归属工作区的主窗口（缺陷 E，方案 §3.4）：
// 从文件所在目录逐级向上，每一级与已登记工作区键（pathKeyForCompare 归一，windowmeta.go）
// 精确相等匹配，第一个命中的级别即「最深包含工作区」；盘根无命中返回空串（投主窗口）。
// 存在的目录目标不路由（前端 openFolderSmart 自有工作区逻辑）；不存在的目标按文件处理
// 从所在目录起爬——纯字符串祖先链，报错也报在归属窗口里。窗口工作区由前端
// WindowRegister 实时登记（切换即更新、关闭登记空串退出匹配），这里只读。
func routeWindowForPath(path string) string {
	if info, err := os.Stat(path); err == nil && info.IsDir() {
		return ""
	}
	dir := pathKeyForCompare(filepath.Dir(path))
	for dir != "" {
		if st := winReg.findByWorkspace(dir, ""); st != nil {
			return st.name()
		}
		parent := pathKeyForCompare(filepath.Dir(dir))
		if parent == dir {
			return ""
		}
		dir = parent
	}
	return ""
}

// secondInstancePlan 把第二实例的转发参数解析成动作计划。相对旧内联逻辑的行为修正：
//   - B（--ai-session 单独传参）：解析会话归属工作区后走 sessionOpen（openMainWindow 的
//     「同工作区复用 + 前置 + 投会话」语义）；解析失败只前置窗口——绝不再把调用方 CWD
//     兜底成打开目标误投给主窗口（旧 StartupCwdTarget 分支会误切工作区）。
//   - C（--ai-session + 文件转发投递）：会话归属与目标窗口工作区一致时补投
//     app-open-ai-session（前端 handleReuseSessionRequest 要求 workspace 匹配、无 reqId
//     不回执）；不一致丢弃 + warn（旧版无条件静默丢 id）。
//   - D（--open-settings/--memo + 文件组合）：文件目标随定点事件一起投给主窗口，不再被
//     定点分支吞掉；回退浮窗时仍不投文件（浮窗不是文件容器，方案 §6 已知边界）。
//
// appconfig.OpenMode()=="window" 死分支移除：Read() 自 2026-11-21 起把 window 归一回
// tab（同工作区双开会破坏单打开语义），比较恒假。
func secondInstancePlan(args []string, deps forwardDeps) forwardPlan {
	resolve := deps.resolveSessionWorkspace
	if resolve == nil {
		resolve = func(string) (string, error) { return "", errors.New("resolveSessionWorkspace 未注入") }
	}
	switch {
	case launchargs.HasFlag(args, "--quit"):
		return forwardPlan{kind: "quit"}
	case launchargs.HasFlag(args, "--ai-float"):
		return forwardPlan{kind: "float", targets: launchargs.ParseOpenTargets(args)}
	case launchargs.HasFlag(args, "--debug-console"):
		return forwardPlan{kind: "debug"}
	}
	targets := launchargs.ParseOpenTargets(args)
	sessionID := launchargs.ParseAISessionArg(args)
	sessionNoRoute := false
	if sessionID != "" && len(targets) == 0 {
		if ws, err := resolve(sessionID); err == nil && ws != "" {
			return forwardPlan{kind: "sessionOpen", sessionID: sessionID, workspace: ws}
		}
		// 会话不存在或无归属：绝不把 CWD 兜底成打开目标（缺陷 B）；但后续定点
		// 分支（settings/memo）继续生效——组合参数不该因会话解析失败被整体吞掉。
		writeAppLog("warn", "--ai-session 转发：会话不存在或无归属工作区（%q），仅前置窗口", sessionID)
		sessionNoRoute = true
	}
	if pane := launchargs.ParseOpenSettingsArg(args); pane != "" {
		return forwardPlan{kind: "settings", targets: targets, pane: pane}
	}
	if loc := launchargs.ParseMemoLocatorArg(args); loc != "" {
		return forwardPlan{kind: "memo", targets: targets, locator: loc}
	}
	if len(targets) == 0 {
		if sessionNoRoute {
			return forwardPlan{kind: "show"}
		}
		targets = launchargs.StartupCwdTarget()
		if len(targets) == 0 {
			return forwardPlan{kind: "show"}
		}
	}
	if launchargs.HasFlag(args, "--new-window") {
		return forwardPlan{kind: "newWindow", targets: targets, sessionID: sessionID}
	}
	plan := forwardPlan{kind: "deliver"}
	if sessionID != "" {
		if ws, err := resolve(sessionID); err == nil && ws != "" {
			plan.sessionID = sessionID
			plan.workspace = ws
		} else {
			writeAppLog("warn", "--ai-session 转发：会话归属解析失败（%q），仅投递文件", sessionID)
		}
	}
	// 缺陷 E：文件目标按所属工作区路由到对应窗口（祖先链最深命中），按窗口分组
	// 投递；无归属（含目录目标、不存在路径）进主窗口组。
	seen := map[string]int{}
	for _, t := range targets {
		name := ""
		if deps.routeWindowForPath != nil {
			name = deps.routeWindowForPath(t.Path)
		}
		if i, ok := seen[name]; ok {
			plan.groups[i].targets = append(plan.groups[i].targets, t)
			continue
		}
		seen[name] = len(plan.groups)
		plan.groups = append(plan.groups, targetGroup{windowName: name, targets: []launchargs.OpenTarget{t}})
	}
	return plan
}

func (a *App) secondInstance(args []string) {
	plan := secondInstancePlan(args, forwardDeps{
		resolveSessionWorkspace: a.ResolveSessionWorkspace,
		routeWindowForPath:      routeWindowForPath,
	})
	switch plan.kind {
	case "quit":
		// --quit：外部（重建脚本等）请求优雅退出。绕开一切确认框：先让各窗口结算 AI
		// 回合并落盘，收齐 ack（或超时）再 ForceQuitAll。见 app_close_action.go。
		a.beginGracefulQuit()
		return
	case "float":
		a.ensureFloatWindow(plan.targets...)
		return
	case "debug":
		a.ensureDebugWindow()
		return
	}
	// 下面这些分支都会把某个窗口拉到前台：顺手清托盘态（v2 每分支都走
	// secondInstanceShow，审查 P2-2）。
	a.clearTrayState()
	switch plan.kind {
	case "settings":
		// 无主窗口形态回退浮窗（与 OpenSettingsInMainWindow 同构，审查 P2-1）。
		st := winReg.primary()
		if st == nil {
			st = winReg.get("float")
		}
		if st != nil {
			emitWindowEventTo(st.window(), "app-open-settings", plan.pane)
			if st.spec.Mode == windowModeMain && len(plan.targets) > 0 {
				deliverOpenTargets(st, openTargetsAny(plan.targets))
			}
			activateWindow(st.window())
		}
	case "memo":
		st := winReg.primary()
		if st == nil {
			st = winReg.get("float")
		}
		if st != nil {
			emitWindowEventTo(st.window(), "app-open-memo", plan.locator)
			if st.spec.Mode == windowModeMain && len(plan.targets) > 0 {
				deliverOpenTargets(st, openTargetsAny(plan.targets))
			}
			activateWindow(st.window())
		}
	case "sessionOpen":
		a.openMainWindow(windowSpec{Workspace: plan.workspace, SessionID: plan.sessionID})
	case "newWindow":
		a.openMainWindow(windowSpec{Targets: plan.targets, SessionID: plan.sessionID})
	case "deliver":
		if len(plan.groups) == 0 {
			a.secondInstanceShow()
			return
		}
		var sessionTarget *windowState
		for _, g := range plan.groups {
			st := a.deliverGroup(g)
			// 缺陷 C：第一个工作区与会话归属一致的接收窗口补投会话
			//（前端 handleReuseSessionRequest 要求 workspace 匹配）。
			if st != nil && plan.sessionID != "" && sessionTarget == nil &&
				pathKeyForCompare(st.workspace()) == pathKeyForCompare(plan.workspace) {
				sessionTarget = st
			}
		}
		if sessionTarget != nil {
			emitWindowEventTo(sessionTarget.window(), "app-open-ai-session", map[string]string{
				"workspace": plan.workspace,
				"sessionId": plan.sessionID,
			})
		} else if plan.sessionID != "" {
			// 会话归属解析成功但没有任何接收窗口的工作区匹配：丢弃会话（保持打开
			// 文件），warn 对齐 forwardPlan 注释与提交信息的行为描述。
			writeAppLog("warn", "--ai-session 转发：无工作区匹配的接收窗口（会话 %q 归属 %q），仅投递文件", plan.sessionID, plan.workspace)
		}
	default:
		a.secondInstanceShow()
	}
}

// deliverGroup 把一组打开目标投给路由指定的窗口。无名组无主窗口存活时开新主窗口
// （旧语义）；路由窗口在转发间隙被关时回落主窗口。返回实际接收的窗口状态
// （可能 nil），供会话补投比对工作区。
func (a *App) deliverGroup(g targetGroup) *windowState {
	var st *windowState
	if g.windowName == "" {
		st = winReg.primary()
		if st == nil {
			a.openMainWindow(windowSpec{Targets: g.targets})
			return nil
		}
	} else {
		st = winReg.get(g.windowName)
		if st == nil {
			st = winReg.primary()
		}
	}
	if st == nil {
		return nil
	}
	deliverOpenTargets(st, openTargetsAny(g.targets))
	return st
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
