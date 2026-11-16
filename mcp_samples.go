package main

// mcp_samples.go：内置 MCP 示例资源的根壳——embed 路径相对包目录，
// 资源本体由 internal/mcpsamples 消费。

import (
	"embed"

	"datalens/internal/mcpsamples"
)

//go:embed docs/mcp-samples/tts-sapi.ps1 docs/mcp-samples/ocr-windows.ps1 docs/mcp-samples/asr-whisper.py
var mcpSampleFS embed.FS

func init() {
	mcpsamples.Embedded = mcpSampleFS
	mcpsamples.Version = appVersion
}
