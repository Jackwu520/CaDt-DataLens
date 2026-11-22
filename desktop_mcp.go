package main

// desktop_mcp.go：内置桌面控制组件（windows-mcp wheel）的根壳——embed 路径相对包目录，
// 释放 / 配置行 / 安装流程都由 internal/desktopmcp 承担（根目录只留绑定与接线）。
//
// 这里同时统一 mcp.PrepareServer 的唯一注入点：内嵌资源有两个家族（内置 MCP 示例脚本、
// 内置桌面 wheel）都要在 server spawn 前自愈，而钩子只有一个，必须组合后一次赋给。

import (
	"embed"

	"datalens/internal/desktopmcp"
	"datalens/internal/mcp"
	"datalens/internal/mcpsamples"
)

//go:embed docs/mcp-desktop/windows_mcp-0.8.9+p3-py3-none-any.whl
var desktopMcpFS embed.FS

func init() {
	desktopmcp.Embedded = desktopMcpFS
	desktopmcp.Logf = mcp.Logf
	mcp.PrepareServer = prepareMCPServers
}

// prepareMCPServers 是所有内嵌 MCP 资源家族共用的 spawn 前自愈入口。
func prepareMCPServers(cfg mcp.MCPServerConfig) {
	mcpsamples.EnsureServerScript(cfg)
	desktopmcp.EnsureServerWheel(cfg)
}
