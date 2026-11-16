package main

// aischedule_app.go：AI 定时任务引擎（internal/aischedule）的宿主接线——
// 注入诊断日志；事件推送在 startup 拿到 ctx 后接线（见 app_core.go）。

import "datalens/internal/aischedule"

func init() {
	aischedule.Logf = writeAppLog
}
