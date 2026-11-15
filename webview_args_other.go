//go:build !windows

package main

// 非 Windows 平台没有 WebView2，无需注入浏览器参数。
func setWebViewExtraBrowserArguments(_ string) {}
