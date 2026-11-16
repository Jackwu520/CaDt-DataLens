//go:build windows

package main

// browser_app_windows.go：给内嵌浏览器注入主窗口查找（windowicon_windows.go）。

import "datalens/internal/browser"

func init() {
	browser.FindParent = findWailsWindow
}
