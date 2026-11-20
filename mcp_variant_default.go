//go:build !mcp

package main

// 标准构建（无 -tags mcp）：完全不包含 v3 内置 MCP server，无网络端点。
// 需要「外部 agent 驱动应用」能力时用 tools/rebuild-exe.ps1 -IncludeMCP 出变体包，
// 见 mcp_variant.go 与 docs/finished-plans/app-mcp-server.md。

// mcpVariantEnabled 仅供启动日志判定。
const mcpVariantEnabled = false

func bootstrapMCPVariant() {}
