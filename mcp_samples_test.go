package main

// mcp_samples_test.go：内置 MCP 示例的自愈钩子接线护栏。
// 逻辑本体在 internal/mcpsamples（有单测），这里只守「根壳有没有接上」——
// 漏接时应用照常编译，但脚本被存储清理删掉后服务器会永久起不来。

import (
	"testing"

	"datalens/internal/mcp"
)

func TestMCPSampleHealHookWired(t *testing.T) {
	if mcp.PrepareServer == nil {
		t.Fatal("mcp.PrepareServer 未接线：内置示例脚本被存储清理删掉后无法自愈")
	}
}
