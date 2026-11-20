//go:build windows

package main

// browser_app_windows.go：给内嵌浏览器注入宿主窗口解析。
// FindParent 是兜底（测试 / 拿不到调用方窗口时）；绑定路径用 ParentForCall——
// v3 一进程多窗口，浏览器控件归属发起它的窗口（callerWindow + NativeWindow），
// 不再按 Z 序找「第一个 WailsWebviewWindow」导致后台窗口的浏览器渲染到前台。

import (
	"context"

	"datalens/internal/browser"
)

func init() {
	browser.FindParent = findWailsWindow
	browser.ParentForCall = func(ctx context.Context) uintptr {
		w := callerWindow(ctx)
		if w == nil {
			return 0
		}
		p := w.NativeWindow()
		if p == nil {
			return 0
		}
		return uintptr(p)
	}
}
