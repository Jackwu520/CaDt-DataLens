package main

import (
	"embed"
	"fmt"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"datalens/internal/applog"
	"datalens/internal/convertcli"
	"datalens/internal/patchcli"
	"datalens/internal/previewassets"
)

//go:embed all:frontend/dist
var assets embed.FS

// disableMiniMenu 禁用 Edge/WebView2 的「文本选中迷你菜单」（mini menu：Select All /
// Paste / Find … 的白色横条，可编辑区域触发，不受应用主题控制也绕过 JS 的
// contextmenu 接管）。
//
// 注意：不能靠 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 环境变量——go-webview2 会在
// init() 与每次创建环境时调 preventEnvAndRegistryOverrides() 把它清空，参数根本到不了
// 浏览器进程。改走本地补丁的 COM/环境双通道注入点，见
// third_party/go-webview2/webviewloader/app_browser_args.go。
// 须在 WebView2 环境创建（wails.Run）之前调用。
//
// msWebOOUI / msPdfOOUI 是微软在 WebView2Feedback#2140 给出的官方 workaround；
// 后两项是旧实现里的名字，保留以兼容不同 Edge 版本（未知 feature 会被忽略）。
const miniMenuDisabledFeatures = "msWebOOUI,msPdfOOUI,msEdgeMiniMenu,msEdgeTextSelectionMenu"

func disableMiniMenu() {
	setWebViewExtraBrowserArguments("--disable-features=" + miniMenuDisabledFeatures)
}

func main() {
	disableMiniMenu()
	if runInstallerCommand(os.Args[1:]) {
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

	app := NewApp()
	app.convert = convertOpts

	width, height, minWidth, minHeight := 1280, 800, 720, 480
	if hasArg("--ai-float") {
		width, height, minWidth, minHeight = 560, 760, 360, 480
	}
	var instanceLock *options.SingleInstanceLock
	if !isConvert {
		instanceLock = &options.SingleInstanceLock{
			UniqueId:               uniqueIDForLaunch(),
			OnSecondInstanceLaunch: app.secondInstance,
		}
	}

	err := wails.Run(&options.App{
		Title:            "CaDt-DataLens",
		Width:            width,
		Height:           height,
		MinWidth:         minWidth,
		MinHeight:        minHeight,
		Frameless:        true,
		StartHidden:      true,
		BackgroundColour: &options.RGBA{R: 30, G: 31, B: 36, A: 1},
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: previewassets.Middleware,
		},
		OnStartup:     app.startup,
		OnDomReady:    app.domReady,
		OnBeforeClose: app.beforeClose,
		Logger:        applog.WailsLogger{},
		Windows: &windows.Options{
			IsZoomControlEnabled: false,
			DisablePinchZoom:     true,
			ZoomFactor:           1.0,
			WebviewUserDataPath:  webviewDataPath(),
		},
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: false,
		},
		SingleInstanceLock: instanceLock,
		Bind:               []interface{}{app},
	})
	if err != nil {
		writeAppLog("error", "wails.Run 退出：%v", err)
	}
	if isConvert {
		os.Exit(app.convertExitCode)
	}
}
