package main

// reading_app.go：阅读模式引擎（internal/reading）的宿主接线——
// 注入诊断日志；事件推送在 startup 拿到 ctx 后接线（见 app_core.go）。

import (
	"datalens/internal/applog"
	"datalens/internal/reading"
)

func init() {
	reading.Logf = writeAppLog
	reading.DebugEnabled = func() bool { return applog.DevMode() }
}
