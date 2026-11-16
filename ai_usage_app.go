package main

// ai_usage_app.go：AI 余额查询的 Wails 绑定——引擎在 internal/aiusage。

import (
	"datalens/internal/aitransport"
	"datalens/internal/aiusage"
)

func init() {
	aiusage.Version = appVersion
}

func (a *App) AIUsageQuery(cfg aitransport.Config) aiusage.AIUsageResult {
	return aiusage.Query(cfg)
}
