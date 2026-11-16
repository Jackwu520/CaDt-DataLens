package main

// browser_app.go：内嵌浏览器引擎（internal/browser）的宿主接线——
// 注入诊断日志；事件推送在 startup 拿到 ctx 后接线（见 app_core.go）。

import "datalens/internal/browser"

func init() {
	browser.Logf = writeAppLog
}
