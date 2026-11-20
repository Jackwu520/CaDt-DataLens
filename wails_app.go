package main

// Wails v3 兼容层：根壳其它文件只依赖这里的窗口/事件/剪贴板/退出动作，
// P2 切多窗口时只需要改「目标窗口」的解析（currentWindow），调用点不动。

import (
	"context"
	"fmt"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

var (
	wailsApp *application.App
	mainWin  *application.WebviewWindow
	winMu    sync.RWMutex
)

// ServiceStartup 实现 v3 的 ServiceStartup 接口，等价 v2 的 OnStartup。
func (a *App) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	a.startup(ctx)
	return nil
}

func setMainWindow(w *application.WebviewWindow) {
	winMu.Lock()
	mainWin = w
	winMu.Unlock()
}

func currentWindow() *application.WebviewWindow {
	winMu.RLock()
	defer winMu.RUnlock()
	return mainWin
}

// emitAppEvent 是 v2 runtime.EventsEmit 在 v3 的替代：P1 仍是全局广播，
// P2 由事件桥接层按 sender/业务 key 过滤（见 wails-v3-event-filtering.md）。
func emitAppEvent(name string, data ...any) {
	if wailsApp == nil {
		return
	}
	wailsApp.Event.Emit(name, data...)
}

// showMainWindow 对应 v2 WindowShow 的语义：显示并把最小化的窗口恢复回来。
func showMainWindow() {
	w := currentWindow()
	if w == nil {
		return
	}
	w.Show()
	if w.IsMinimised() {
		w.UnMinimise()
	}
}

func hideMainWindow() {
	if w := currentWindow(); w != nil {
		w.Hide()
	}
}

func quitApp() {
	if wailsApp != nil {
		wailsApp.Quit()
	}
}

func setMainWindowTitle(title string) {
	if w := currentWindow(); w != nil {
		w.SetTitle(title)
	}
}

func setMainWindowSize(width, height int) {
	if w := currentWindow(); w != nil {
		w.SetSize(width, height)
	}
}

func setMainWindowBackground(r, g, b, a uint8) {
	if w := currentWindow(); w != nil {
		w.SetBackgroundColour(application.NewRGBA(r, g, b, a))
	}
}

func clipboardSetText(text string) error {
	if wailsApp == nil {
		return fmt.Errorf("应用尚未启动")
	}
	wailsApp.Clipboard.SetText(text)
	return nil
}

func clipboardGetText() (string, error) {
	if wailsApp == nil {
		return "", fmt.Errorf("应用尚未启动")
	}
	text, _ := wailsApp.Clipboard.Text()
	return text, nil
}
