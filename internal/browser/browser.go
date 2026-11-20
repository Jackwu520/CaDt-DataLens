package browser

// 浏览器使用标签页：内容区内嵌 WebView2（browser-use）。
// Windows 实现在 browser_windows.go / browser_com_windows.go，其余平台为 stub。
// 每个 AI 会话可通过 profileKey 获得独立的用户数据目录（cookie/登录态隔离）。

import (
	"context"
	"regexp"
)

// Host 内嵌浏览器引擎。Windows 下持有 WebView2 宿主线程；其余平台为 stub。
type Host struct{}

// 宿主注入（main 包的根壳在 init/startup 接线）。
var (
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
	// Emit 前端事件推送（main 在 startup 注入 Wails EventsEmit）。
	Emit func(event string, data any)
	// FindParent 返回 WebView2 控件的兜底宿主父窗口（main/windowicon_windows.go 的
	// findWailsWindow）。v3 一进程多窗口后只在拿不到调用方窗口时兜底（测试/非绑定路径）。
	FindParent func() uintptr
	// ParentForCall 返回绑定调用方窗口的原生句柄（main 用 callerWindow+NativeWindow）。
	// 浏览器控件归属发起它的窗口——不再按 Z 序猜「当前主窗口」。
	ParentForCall func(ctx context.Context) uintptr
)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

func emit(event string, data any) {
	if Emit != nil {
		Emit(event, data)
	}
}

const browserMaxInstances = 4

// ProfileRoot 内嵌浏览器每个实例的 WebView2 用户数据根目录名（在应用数据目录下）。
// 关掉标签页不会回收这些目录，「存储与清理」按它列出可清除的实例数据（见 storage_app.go）。
const ProfileRoot = "BrowserSessions"

var browserProfileKeyRule = regexp.MustCompile(`[^A-Za-z0-9_\-]`)

// sanitizeBrowserProfileKey 把 profileKey 清洗成安全的目录名片段。
func sanitizeBrowserProfileKey(key string) string {
	cleaned := browserProfileKeyRule.ReplaceAllString(key, "_")
	if len(cleaned) > 64 {
		cleaned = cleaned[:64]
	}
	return cleaned
}
