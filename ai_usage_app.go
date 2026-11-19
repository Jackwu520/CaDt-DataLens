package main

// ai_usage_app.go：AI 余额查询的 Wails 绑定——官方白名单引擎在 internal/aiusage，
// 模板/脚本额度查询走 aigen 哑通道（前端渲染规格，这里只发请求）。

import (
	"datalens/internal/aigen"
	"datalens/internal/aitransport"
	"datalens/internal/aiusage"
)

func init() {
	aiusage.Version = appVersion
}

func (a *App) AIUsageQuery(cfg aitransport.Config) aiusage.AIUsageResult {
	return aiusage.Query(cfg)
}

// AIUsageHTTPRequest 额度查询的哑通道：前端把模板变量替换与请求体渲染做完，
// 这里按规格发一次同步 HTTP（转发 aigen.HTTPRequest，代理/超时/响应上限沿用），
// 响应体原样回给前端沙箱里的 extractor 提取。错误摘要由 aigen 侧做密钥形态脱敏。
func (a *App) AIUsageHTTPRequest(specJSON string) aigen.HTTPResult {
	return aigen.HTTPRequest(specJSON)
}
