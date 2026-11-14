//go:build windows

// mcp_proc_windows.go：MCP 子进程的平台差异收敛——把 Windows-only 的进程辅助
// （executil / app_commands 的未打标签实现）隔离进带标签文件，供跨平台安全的 mcp_client.go 调用。
package main

import "os/exec"

func mcpHideWindow(cmd *exec.Cmd) {
	hideCommandWindow(cmd) // CREATE_NO_WINDOW：GUI 进程拉起控制台子进程防黑框
}

func mcpKillTree(cmd *exec.Cmd) error {
	return killProcessTree(cmd) // taskkill /F /T 连树终止，失败回落 Process.Kill()
}
