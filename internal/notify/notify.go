// Package notify 系统通知（Windows Toast + 任务栏提醒）。
package notify

// Notifier 通知引擎（无状态）。
type Notifier struct{}

// 宿主注入（main/notify_app_windows.go 接线）。
var (
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
	// IconID 是 exe 内嵌图标组编号（main/windowicon_windows.go 的 appIconID）。
	IconID uintptr
)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}
