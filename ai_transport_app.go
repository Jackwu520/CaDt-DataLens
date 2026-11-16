package main

// ai_transport_app.go：AI 传输引擎（internal/aitransport）的宿主接线——
// 注入诊断日志、应用版本、日志目录与流看门狗挂载点。

import "datalens/internal/aitransport"

func init() {
	aitransport.Logf = writeAppLog
	aitransport.Version = appVersion
	aitransport.LogsDir = appLogsDir
	aitransport.AttachWatchdog = attachAIStreamWatchdog
}
