package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/applog"
	"datalens/internal/convertcli"
	"datalens/internal/installercli"
	"datalens/internal/launchargs"
	"datalens/internal/patchcli"
	"datalens/internal/previewassets"
)

//go:embed all:frontend/dist
var assets embed.FS

// disableMiniMenu 禁用 Edge/WebView2 的「文本选中迷你菜单」（mini menu：Select All /
// Paste / Find … 的白色横条，可编辑区域触发，不受应用主题控制也绕过 JS 的
// contextmenu 接管）。
//
// 主窗口走 v3 原生 Windows.DisabledFeatures（见 main 里的 application.Options）；
// 这里仍保留 go-webview2 fork 的注入点，因为内嵌浏览器标签页（internal/browser）
// 直接依赖 fork 的 pkg/edge，需要同一个 feature 列表。
//
// 注意：不能靠 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量——go-webview2 会在
// init() 与每次创建环境时调 preventEnvAndRegistryOverrides() 把它清空，参数根本到不了
// 浏览器进程。改走本地补丁的 COM/环境双通道注入点，见
// third_party/go-webview2/webviewloader/app_browser_args.go。
// 须在 WebView2 环境创建之前调用。
//
// msWebOOUI / msPdfOOUI 是微软在 WebView2Feedback#2140 给出的官方 workaround；
// 后两项是旧实现里的名字，保留以兼容不同 Edge 版本（未知 feature 会被忽略）。
const miniMenuDisabledFeatures = "msWebOOUI,msPdfOOUI,msEdgeMiniMenu,msEdgeTextSelectionMenu"

func disableMiniMenu() {
	setWebViewExtraBrowserArguments("--disable-features=" + miniMenuDisabledFeatures)
}

func main() {
	disableMiniMenu()
	if installercli.Run(os.Args[1:]) {
		return
	}
	convertOpts, isConvert, convertErr := convertcli.ParseArgs(os.Args[1:])
	if isConvert {
		attachParentConsole()
		if convertErr != nil {
			fmt.Fprintln(os.Stderr, convertErr)
			os.Exit(2)
		}
	}

	// 补丁命令行：不启动窗口、不依赖 AI，处理完直接退出。
	if patchOpts, isPatch, patchErr := patchcli.ParseArgs(os.Args[1:]); isPatch {
		attachParentConsole()
		if patchErr != nil {
			fmt.Fprintln(os.Stderr, patchErr)
			os.Exit(2)
		}
		os.Exit(patchcli.Run(patchOpts))
	}

	ensureAppDataDir()
	applog.Start()
	defer applog.Stop()
	writeAppLog("info", "启动 CaDt-DataLens %s", appVersion)
	if exe, err := os.Executable(); err == nil {
		writeAppLog("info", "程序路径：%s", exe)
	}
	writeAppLog("info", "启动参数：%q", os.Args[1:])
	// 上次在设置页里排的 WebView2 清理：趁浏览器进程还没起来执行（见 cleanup_apply.go）。
	applyPendingStorageCleanup()
	// MCP 变体（-tags mcp，tools/rebuild-exe.ps1 -IncludeMCP）：Run 内会自动启动
	// v3 内置 MCP server，这里先把令牌/端口准备好并写连接信息文件。标准构建是空操作。
	bootstrapMCPVariant()

	app := NewApp()
	app.convert = convertOpts

	var singleInstance *application.SingleInstanceOptions
	if !isConvert {
		singleInstance = &application.SingleInstanceOptions{
			UniqueID: uniqueIDForLaunch(),
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				// v3 的 Args 是完整 os.Args（含 exe 路径），v2 语义是 os.Args[1:]。
				args := data.Args
				if len(args) > 0 && (args[0] == os.Args[0] || args[0] == appExePath()) {
					args = args[1:]
				}
				app.secondInstance(args)
			},
		}
	}

	wailsApp = application.New(application.Options{
		Name:        "CaDt-DataLens",
		Description: "轻量级多格式数据查看与编辑器",
		Services: []application.Service{
			application.NewService(app),
		},
		Assets: application.AssetOptions{
			Handler:    application.BundledAssetFileServer(assets),
			Middleware: previewassets.Middleware,
		},
		SingleInstance: singleInstance,
		Windows: application.WindowsOptions{
			WebviewUserDataPath: webviewDataPath(),
			// 迷你菜单禁用（v3 原生选项，自动与上游 feature 合并）；见 disableMiniMenu 注释。
			DisabledFeatures: []string{"msWebOOUI", "msPdfOOUI", "msEdgeMiniMenu", "msEdgeTextSelectionMenu"},
		},
		ErrorHandler: func(err error) {
			writeAppLog("error", "wails v3：%v", err)
		},
	})

	// 首个窗口：按启动参数决定形态（主窗口 / AI 浮窗 / 调试控制台）。
	primary := windowSpec{
		Name:         "main",
		Mode:         windowModeMain,
		Targets:      launchargs.ParseOpenTargets(os.Args[1:]),
		SessionID:    launchargs.ParseAISessionArg(os.Args[1:]),
		SettingsPane: launchargs.ParseOpenSettingsArg(os.Args[1:]),
		MemoLocator:  launchargs.ParseMemoLocatorArg(os.Args[1:]),
	}
	if hasArg("--ai-float") {
		primary.Name = "float"
		primary.Mode = windowModeFloat
	}
	if hasArg("--debug-console") {
		primary.Name = "debug"
		primary.Mode = windowModeDebug
	}
	app.createWindow(primary)

	err := wailsApp.Run()
	if err != nil {
		writeAppLog("error", "wails.Run 退出：%v", err)
	}
	// 兜底落盘：正常路径在最后一个窗口的 WindowClosing 钩子里已经 flush，
	// 这里覆盖非关窗退出（托盘退出/外部结束）时防抖计时器还没到点的情况。
	winGeom.flush()
	if isConvert {
		os.Exit(app.convertExitCode)
	}
}

// appExePath 返回当前 exe 路径（第二实例参数比对用；取不到时退回 os.Args[0]）。
func appExePath() string {
	if exe, err := os.Executable(); err == nil {
		return exe
	}
	return os.Args[0]
}
