//go:build windows

package main

// screenshot_app_windows.go：给截图引擎注入宿主窗口解析。
// FindParent 是兜底（测试 / 拿不到调用方窗口时）；绑定路径用 ParentForCall——
// 截图目标归属发起调用的窗口（与浏览器同批，2026-11-21 审查第 3 项）。

import (
	"context"

	"datalens/internal/screenshot"
)

func init() {
	screenshot.FindParent = findWailsWindow
	screenshot.ParentForCall = func(ctx context.Context) uintptr {
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
