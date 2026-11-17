package main

// mcp_samples.go：内置 MCP 示例资源的根壳——embed 路径相对包目录，
// 资源本体由 internal/mcpsamples 消费。

import (
	"embed"

	"datalens/internal/mcp"
	"datalens/internal/mcpsamples"
)

//go:embed docs/mcp-samples/tts-sapi.ps1 docs/mcp-samples/ocr-windows.ps1 docs/mcp-samples/asr-whisper.py
var mcpSampleFS embed.FS

func init() {
	mcpsamples.Embedded = mcpSampleFS
	mcpsamples.Version = appVersion
	// 启动前自愈：脚本被存储清理删掉 / 版本升级换了目录时，按 mcp.json 里的原路径补回，
	// 否则已注册的示例服务器会初始化失败十次后放弃（见 storage specs 的 builtin-mcp-samples）。
	mcp.PrepareServer = mcpsamples.EnsureServerScript
}
