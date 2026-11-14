//go:build !windows

// mcp_proc_other.go：非 Windows 平台的 MCP 子进程差异面（项目实际只发布 Windows，保底实现）。
package main

import "os/exec"

func mcpHideWindow(cmd *exec.Cmd) {}

func mcpKillTree(cmd *exec.Cmd) error {
	if cmd.Process != nil {
		return cmd.Process.Kill()
	}
	return nil
}
