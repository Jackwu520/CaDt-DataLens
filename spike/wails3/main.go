// CaDt-DataLens Wails v3 P0 spike：验证迁移所需的七项平台还原度。
//
// 本文件是独立 spike 模块（spike/wails3），不参与仓库根包的 v2 构建。
// 验证项：
//  1. Frameless 无边框（Go 侧 Win32 样式自查）
//  2. 托盘（SystemTray + 菜单）
//  3. 单实例转发（SingleInstance + 第二实例参数）
//  4. AI 浮窗（一进程多窗口，运行时创建第二窗口）
//  5. fork 补丁注入点（v3 原生 DisabledFeatures / AdditionalBrowserArgs）
//  6. 定向事件（window.EmitEvent 是否只到目标窗口）
//  7. 每窗口独立 JS context（ExecJS 只影响目标窗口）
package main

import (
	"bytes"
	"embed"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"cadt-spike-v3/service"
)

//go:embed all:assets
var assets embed.FS

const (
	mainWindowName   = "spike-main"
	mainWindowTitle  = "CaDt V3 Spike · main"
	floatWindowName  = "spike-float"
	floatWindowTitle = "CaDt V3 Spike · float"
	appUniqueID      = "local.cadt.datalens.v3spike"

	// 与仓库 main.go 的 miniMenuDisabledFeatures 保持一致。
	miniMenuDisabledFeatures = "msWebOOUI,msPdfOOUI,msEdgeMiniMenu,msEdgeTextSelectionMenu"
)

var (
	app      *application.App
	mainWin  *application.WebviewWindow
	floatWin *application.WebviewWindow
	tray     *application.SystemTray

	logMu   sync.Mutex
	logPath string
)

func logf(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	line := time.Now().Format("15:04:05.000") + " " + msg

	logMu.Lock()
	defer logMu.Unlock()
	fmt.Println(line)
	if logPath == "" {
		return
	}
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	_, _ = f.WriteString(line + "\n")
	_ = f.Close()
}

func main() {
	logPath = filepath.Join(os.TempDir(), "cadt-v3-spike.log")
	// 第二实例只会在 application.New 里被单实例锁拦截后立即退出，
	// 不能让它清掉第一实例已写好的验证日志。
	if !hasArg(os.Args[1:], "--spike-second-instance") {
		_ = os.Remove(logPath)
	}

	exe, _ := os.Executable()
	logf("=== CaDt Wails v3 spike 启动 ===")
	logf("exe=%s pid=%d args=%q", exe, os.Getpid(), os.Args[1:])

	app = application.New(application.Options{
		Name:        "CaDt V3 Spike",
		Description: "Wails v3 P0 spike for CaDt-DataLens migration",
		LogLevel:    slog.LevelInfo,
		Services: []application.Service{
			application.NewService(service.New(service.Deps{
				Logf:        logf,
				EmitPing:    emitPingFromMain,
				OpenFloat:   openFloat,
				CloseFloat:  closeFloat,
				ExecJSProbe: execJSProbe,
				ProbeState:  probeState,
			})),
		},
		Assets: application.AssetOptions{
			Handler: application.BundledAssetFileServer(assets),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: appUniqueID,
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				logf("[go] 第二实例：args=%v cwd=%s", data.Args, data.WorkingDir)
				if mainWin != nil {
					mainWin.EmitEvent("spike:second-instance", data.Args)
					mainWin.Show()
					mainWin.Restore()
					mainWin.Focus()
				}
			},
		},
		Windows: application.WindowsOptions{
			WebviewUserDataPath: filepath.Join(os.TempDir(), "cadt-v3-spike-webview"),
			// 补丁 1（迷你菜单禁用）在 v3 是原生选项，不再需要 fork go-webview2。
			DisabledFeatures: []string{"msWebOOUI", "msPdfOOUI", "msEdgeMiniMenu", "msEdgeTextSelectionMenu"},
			// 补丁 2（闪退隔离）的另一半：把 Chromium 参数注入点也走原生选项。
			AdditionalBrowserArgs: []string{"--disable-background-timer-throttling"},
		},
		ErrorHandler: func(err error) {
			logf("[go] app ErrorHandler: %v", err)
		},
	})

	mainWin = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             mainWindowName,
		Title:            mainWindowTitle,
		Width:            1100,
		Height:           760,
		MinWidth:         720,
		MinHeight:        480,
		Frameless:        true,
		BackgroundColour: application.NewRGB(30, 31, 36),
		URL:              "/?win=main",
		EnableFileDrop:   true,
	})
	logf("[go] 主窗口已创建 name=%s id=%d", mainWin.Name(), mainWin.ID())

	setupTray()

	// 窗口显示后自查 Win32 样式（无边框验证）。
	go func() {
		time.Sleep(2 * time.Second)
		checkFrameless()
	}()

	// --spike-auto：无人值守自检序列（P0 验证用）。
	if hasArg(os.Args[1:], "--spike-auto") {
		go runAutoProbe()
	}

	if err := app.Run(); err != nil {
		logf("[go] app.Run 退出：%v", err)
		os.Exit(1)
	}
	logf("[go] app.Run 正常退出")
}

// hasArg 判断启动参数里是否有某个开关。
func hasArg(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

// runAutoProbe 无人值守跑完七项里可自动化的部分，最后退出进程。
func runAutoProbe() {
	step := func(d time.Duration, name string, fn func()) {
		time.Sleep(d)
		logf("[auto] ---- %s ----", name)
		fn()
	}

	step(4*time.Second, "多窗口（AI 浮窗）", func() { openFloat() })
	step(5*time.Second, "定向事件 window.EmitEvent", func() { emitPingFromMain() })
	step(5*time.Second, "per-window JS context（ExecJS 只写主窗口）", func() { execJSProbe() })
	step(4*time.Second, "单实例转发（拉起第二个进程）", func() {
		exe, err := os.Executable()
		if err != nil {
			logf("[auto] 定位自身失败：%v", err)
			return
		}
		cmd := exec.Command(exe, "--spike-second-instance", "hello-from-auto")
		if err := cmd.Start(); err != nil {
			logf("[auto] 拉起第二实例失败：%v", err)
			return
		}
		go func() {
			_ = cmd.Wait()
			logf("[auto] 第二实例进程已退出（state=%v），转发回调应已触发", cmd.ProcessState)
		}()
	})
	step(8*time.Second, "自检结束，退出", func() {
		logf("[auto] 全部自动探针完成，请求退出")
		app.Quit()
	})
}

// setupTray 创建系统托盘与菜单（验证项 2）。
func setupTray() {
	tray = app.SystemTray.New()
	tray.SetIcon(trayIconPNG())
	tray.SetTooltip("CaDt V3 Spike（Wails v3 P0）")
	tray.SetLabel("V3")

	menu := application.NewMenu()

	show := menu.Add("显示主窗口")
	show.OnClick(func(_ *application.Context) {
		mainWin.Show()
		mainWin.Restore()
		mainWin.Focus()
	})

	menu.AddSeparator()

	open := menu.Add("打开 AI 浮窗（第二窗口）")
	open.OnClick(func(_ *application.Context) { openFloat() })

	ping := menu.Add("发送定向事件 spike:ping")
	ping.OnClick(func(_ *application.Context) { emitPingFromMain() })

	probe := menu.Add("ExecJS 上下文探针")
	probe.OnClick(func(_ *application.Context) { execJSProbe() })

	menu.AddSeparator()

	quit := menu.Add("退出")
	quit.OnClick(func(_ *application.Context) {
		logf("[go] 托盘菜单请求退出")
		app.Quit()
	})

	tray.SetMenu(menu)
	tray.OnClick(func() {
		mainWin.Show()
		mainWin.Restore()
		mainWin.Focus()
	})
	logf("[go] 托盘已创建（右键菜单 5 项）")
}

// openFloat 在运行时创建第二个窗口（验证项 4：一进程多窗口）。
func openFloat() string {
	if floatWin != nil {
		floatWin.Show()
		floatWin.Restore()
		floatWin.Focus()
		logf("[go] 浮窗已存在，聚焦 id=%d", floatWin.ID())
		return "focused"
	}
	floatWin = app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             floatWindowName,
		Title:            floatWindowTitle,
		Width:            560,
		Height:           760,
		MinWidth:         360,
		MinHeight:        480,
		Frameless:        true,
		AlwaysOnTop:      true,
		BackgroundColour: application.NewRGB(30, 31, 36),
		URL:              "/?win=float",
	})
	logf("[go] 浮窗已创建 name=%s id=%d（同进程 pid=%d）", floatWin.Name(), floatWin.ID(), os.Getpid())
	return "created"
}

func closeFloat() string {
	if floatWin == nil {
		return "none"
	}
	floatWin.Close()
	floatWin = nil
	logf("[go] 浮窗已关闭")
	return "closed"
}

// emitPingFromMain 用窗口对象发射事件（验证项 6：定向性）。
func emitPingFromMain() string {
	payload := map[string]any{
		"from": "mainWin.EmitEvent",
		"ts":   time.Now().Format("15:04:05.000"),
	}
	mainWin.EmitEvent("spike:ping", payload)
	logf("[go] mainWin.EmitEvent(spike:ping) 已发；若 float 也收到即广播 bug（#6608）")
	return "emitted"
}

// execJSProbe 只向主窗口写标记（验证项 7：每窗口独立 JS context）。
func execJSProbe() string {
	marker := fmt.Sprintf("main-only-%d", time.Now().UnixMilli())
	mainWin.ExecJS(fmt.Sprintf(`window.__spikeMarker = %q;`, marker))
	logf("[go] ExecJS 只写入主窗口：marker=%s（float 若也报告则 JS context 串了）", marker)
	return marker
}

func probeState() map[string]any {
	state := map[string]any{
		"pid":     os.Getpid(),
		"logPath": logPath,
		"mainID":  mainWin.ID(),
	}
	if floatWin != nil {
		state["floatID"] = floatWin.ID()
	}
	return state
}

// ---- Win32 自查（无边框）在 probe_windows.go / probe_other.go 按平台成对实现 ----

// trayIconPNG 生成 16x16 纯色 PNG（避免外部资源依赖）。
func trayIconPNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{R: 0x2e, G: 0xa0, B: 0x43, A: 0xff})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}
