//go:build windows

package main

// screenshot_app_windows.go：截图引擎（internal/screenshot）的宿主接线。

import "datalens/internal/screenshot"

func init() {
	screenshot.FindParent = findWailsWindow
}
