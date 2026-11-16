// Package executil：拉起/终止子进程的小助手（防黑窗、杀进程树），
// app_commands / run / search_rg / internal/mcp 共用。原 hideCommandWindow 与
// hideConsoleWindow 是两份逐字节相同的实现，本次下沉合并为一个。
package executil

import (
	"os/exec"
	"syscall"
)

// HideCommandWindow 避免 GUI 进程拉起控制台子进程时闪出黑窗。
func HideCommandWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
