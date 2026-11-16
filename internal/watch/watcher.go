// Package watch 工作区文件监听（Windows 读目录变化通知，其余平台报不支持）。
package watch

import "sync"

// Watcher 文件监听器。每次只监听一个工作区根。
type Watcher struct {
	mu   sync.Mutex
	root string
	stop chan struct{}
	done chan struct{}
}

// 宿主注入（main 的 startup 接线）。
var (
	// Emit 前端事件推送（main 在 startup 注入 Wails EventsEmit）。
	Emit func(event string, data any)
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
)

func emit(event string, data any) {
	if Emit != nil {
		Emit(event, data)
	}
}

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}
