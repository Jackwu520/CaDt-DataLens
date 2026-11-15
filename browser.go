package main

// 浏览器使用标签页：内容区内嵌 WebView2（browser-use）。
// Windows 实现在 browser_windows.go / browser_com_windows.go，其余平台为 stub。
// 每个 AI 会话可通过 profileKey 获得独立的用户数据目录（cookie/登录态隔离）。

import "regexp"

const browserMaxInstances = 4

// browserProfileRoot 内嵌浏览器每个实例的 WebView2 用户数据根目录名（在应用数据目录下）。
// 关掉标签页不会回收这些目录，「存储与清理」按它列出可清除的实例数据（见 storage_app.go）。
const browserProfileRoot = "BrowserSessions"

var browserProfileKeyRule = regexp.MustCompile(`[^A-Za-z0-9_\-]`)

// sanitizeBrowserProfileKey 把 profileKey 清洗成安全的目录名片段。
func sanitizeBrowserProfileKey(key string) string {
	cleaned := browserProfileKeyRule.ReplaceAllString(key, "_")
	if len(cleaned) > 64 {
		cleaned = cleaned[:64]
	}
	return cleaned
}
