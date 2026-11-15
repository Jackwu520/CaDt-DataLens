//go:build windows

package main

import "github.com/wailsapp/go-webview2/webviewloader"

// setWebViewExtraBrowserArguments 在 wails.Run（创建 WebView2 环境）之前注入
// Chromium 参数。走本地补丁 go-webview2 的显式注入点；直接设
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 会被上游清空，见
// third_party/go-webview2/webviewloader/app_browser_args.go。
func setWebViewExtraBrowserArguments(args string) {
	webviewloader.ExtraBrowserArguments = args
}
