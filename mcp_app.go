// mcp_app.go：MCP 客户端的宿主注入——绑定方法随 Client 移入 internal/mcp，
// 这里只登记日志、appdata 目录、版本，并保留退出前的统一关闭入口。
package main

import "datalens/internal/mcp"

// 宿主注入：诊断日志、appdata 目录与应用版本都来自 main 包。
// 图片落地不需要注入——internal/mcp 自带 DefaultImageSaver（%TEMP%/CaDt-DataLens/mcp-images）。
func init() {
	mcp.Logf = writeAppLog
	mcp.AppDataDir = appDataRoot
	mcp.Version = appVersion
}

// mcpCloseAll 应用退出前全量关闭（总预算 8s）。beforeClose 与 ForceClose 都走这里。
func (a *App) mcpCloseAll() {
	mcp.CloseClient(a.Client)
}
