package main

// window_factory.go：一进程多窗口的窗口工厂与投递助手（P2）。
//
// 三种窗口：主窗口（可多个，按工作区复用）、AI 浮窗（单例）、调试控制台（单例）。
// 所有窗口共用同一个 App 服务实例；窗口级状态经 windowState 归属（见 windowmeta.go）。

import (
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"datalens/internal/launchargs"
	"datalens/internal/windowgeom"
)

// createWindow 创建并登记窗口，随后 app.Run 会跑它。
func (a *App) createWindow(spec windowSpec) *application.WebviewWindow {
	if spec.Name == "" {
		spec.Name = winReg.nextName(spec.Mode)
	}
	st := winReg.add(spec)
	width, height, minWidth, minHeight := windowSizesFor(spec.Mode)
	initialRect, hasInitialRect := winGeom.initialGeometry(spec, width, height, minWidth, minHeight)
	st.setInitialGeometry(initialRect, hasInitialRect)
	win := wailsApp.Window.NewWithOptions(windowOptionsFor(spec, initialRect, hasInitialRect))
	st.setWindow(win)
	installGeometryHooks(win, st)
	if spec.Mode == windowModeMain && currentWindow() == nil {
		setMainWindow(win)
	}

	win.RegisterHook(events.Windows.WindowClosing, func(e *application.WindowEvent) {
		// 关窗前采集一次并同步落盘：拖拽刚结束就关窗时防抖计时器可能还没到点。
		winGeom.capture(st)
		winGeom.flush()
		if a.beforeCloseWindow(st) {
			e.Cancel()
			return
		}
		winReg.remove(st.name())
		if currentWindow() == win {
			if primary := winReg.primary(); primary != nil {
				setMainWindow(primary.window())
			} else {
				setMainWindow(nil)
			}
		}
	})
	win.RegisterHook(events.Windows.WebViewNavigationCompleted, func(_ *application.WindowEvent) {
		a.windowReady(st)
	})
	writeAppLog("info", "窗口已创建：%s（mode=%s workspace=%q）", spec.Name, spec.Mode, spec.Workspace)
	return win
}

// windowSizesFor 返回窗口类型的默认尺寸与最小尺寸。
func windowSizesFor(mode windowMode) (width, height, minWidth, minHeight int) {
	switch mode {
	case windowModeFloat:
		return 560, 760, 360, 480
	case windowModeDebug:
		return 780, 460, 400, 300
	default:
		return 1280, 800, 720, 480
	}
}

// windowOptionsFor 按窗口类型给出 v3 窗口参数。
func windowOptionsFor(spec windowSpec, initialRect windowgeom.Rect, hasInitialRect bool) application.WebviewWindowOptions {
	width, height, minWidth, minHeight := windowSizesFor(spec.Mode)
	title := "CaDt-DataLens"
	alwaysOnTop := false
	switch spec.Mode {
	case windowModeFloat:
		title = "AI 助手 · CaDt-DataLens"
		alwaysOnTop = true
	case windowModeDebug:
		title = "调试控制台 · CaDt-DataLens"
	}
	opts := application.WebviewWindowOptions{
		Name:               spec.Name,
		Title:              title,
		Width:              width,
		Height:             height,
		MinWidth:           minWidth,
		MinHeight:          minHeight,
		Frameless:          true,
		Hidden:             true,
		AlwaysOnTop:        alwaysOnTop,
		BackgroundColour:   application.NewRGB(30, 31, 36),
		URL:                "/",
		EnableFileDrop:     true,
		ZoomControlEnabled: false,
		Zoom:               1.0,
	}
	// 记住的位置/尺寸（window-state.json）：按当前显示器布局收敛后再交给 v3。
	// 首个窗口在 Run 之前创建，此时 v3 尚未缓存显示器列表，windowReady 会再收敛一次。
	if hasInitialRect {
		opts.InitialPosition = application.WindowXY
		opts.X, opts.Y = initialRect.X, initialRect.Y
		opts.Width, opts.Height = initialRect.Width, initialRect.Height
	}
	return opts
}

// windowReady 在首屏导航完成后显示窗口（v2 OnDomReady 的等价时机）。
func (a *App) windowReady(st *windowState) {
	if a.convert != nil {
		return
	}
	win := st.window()
	if win == nil {
		return
	}
	spec := st.startup()
	maximised := false
	if rect, ok := st.takeInitialGeometry(); ok {
		// 首个窗口创建于 Run 之前，v3 那时还没枚举显示器；这里按当前屏幕布局
		// 再收敛一次（窗口仍隐藏，用户看不到跳动）。后续导航重载不重复应用。
		_, _, minW, minH := windowSizesFor(spec.Mode)
		areas, primary := screenWorkAreas()
		rect = windowgeom.Normalize(rect, minW, minH, areas, primary)
		win.SetPosition(rect.X, rect.Y)
		win.SetSize(rect.Width, rect.Height)
		maximised = rect.Maximised
	}
	if spec.Mode == windowModeMain {
		showWindowWhenReady(win, maximised)
	} else if maximised {
		win.Maximise()
	} else {
		win.Show()
	}
}

// ensureFloatWindow 打开（或聚焦）AI 浮窗；targets 非空时作为该窗口的启动目标
// （新建窗口走启动上下文，已存在的窗口直接投 open-targets 事件）。
func (a *App) ensureFloatWindow(targets ...launchargs.OpenTarget) *application.WebviewWindow {
	if st := winReg.get("float"); st != nil {
		if w := st.window(); w != nil {
			if len(targets) > 0 {
				w.EmitEvent("open-targets", targets)
			}
			activateWindow(w)
			return w
		}
	}
	return a.createWindow(windowSpec{Name: "float", Mode: windowModeFloat, Targets: targets})
}

// ensureDebugWindow 打开（或聚焦）独立调试控制台窗口。
func (a *App) ensureDebugWindow() *application.WebviewWindow {
	if st := winReg.get("debug"); st != nil {
		if w := st.window(); w != nil {
			activateWindow(w)
			return w
		}
	}
	return a.createWindow(windowSpec{Name: "debug", Mode: windowModeDebug})
}

// activateWindow 把窗口显示并前置（最小化时先恢复，不用 Restore 以免还原最大化）。
func activateWindow(w *application.WebviewWindow) {
	if w == nil {
		return
	}
	w.Show()
	if w.IsMinimised() {
		w.UnMinimise()
	}
	w.Focus()
}

// deliverOpenTargets 把打开目标事件投给指定窗口（sender 由 v3 填窗口名）。
func deliverOpenTargets(st *windowState, targets []any) {
	w := st.window()
	if w == nil {
		return
	}
	w.EmitEvent("open-targets", targets)
	activateWindow(w)
}

// deliverOpenSession 把「打开某个 AI 会话」投给指定窗口（替代 v2 的文件信箱）；
// reqID 由投递方生成，目标窗口处理完经 WindowReuseResult 回执。
func deliverOpenSession(st *windowState, reqID, workspace, sessionID string) {
	w := st.window()
	if w == nil {
		return
	}
	w.EmitEvent("app-open-ai-session", map[string]string{
		"reqId":     reqID,
		"workspace": workspace,
		"sessionId": sessionID,
	})
	activateWindow(w)
}

// openMainWindow 新建一个主窗口（--new-window / 新目录 / 软切换）。
func (a *App) openMainWindow(spec windowSpec) *application.WebviewWindow {
	spec.Mode = windowModeMain
	return a.createWindow(spec)
}

// closeWindow 关闭指定窗口（触发该窗口的 WindowClosing 钩子）。
func closeWindow(w *application.WebviewWindow) {
	if w != nil {
		w.Close()
	}
}

// closeOtherWindows 关闭除 except 外的全部窗口（最后一个主窗口退出时带走浮窗/调试台）。
// 先置 forceClose：这些窗口的 AI 回合/未保存状态已经算进主窗口的退出确认，不再逐个弹框。
func closeOtherWindows(except *windowState) {
	for _, st := range winReg.list() {
		if st == except {
			continue
		}
		st.markForceClose()
		st.SetDirty(false)
		st.SetAIRunning(false)
		closeWindow(st.window())
	}
}

// windowShowDelay 是 UI 线程从导航初始化松手的等待（v2 的图标占位问题）。
const windowShowDelay = 120 * time.Millisecond
