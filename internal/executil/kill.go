// Package executil 子进程执行的平台工具：防黑窗与进程树终止。
//
// 平台无关文件只暴露这两件事，具体实现按 *_windows.go / *_other.go 成对提供；
// 平台无关代码里不要直接引 syscall 的 CreationFlags 或 x/sys/windows。
package executil

import (
	"os/exec"
	"strconv"
)

// KillProcessTree 终止整个进程树。Git for Windows 的 bin/bash.exe 是个 wrapper，
// 真实 bash 是它的子进程：只 Kill wrapper 会让真实子进程继续运行并握住输出管道，
// cmd.Wait 永不返回（同步超时失效、后台作业永不结束）。taskkill /F /T 连树终止。
func KillProcessTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if cmd.Process.Pid > 0 {
		// taskkill 也是控制台程序：GUI 进程直接拉起时 Windows 会为它新建控制台窗口（黑框一闪）。
		killCmd := exec.Command("taskkill", "/F", "/T", "/PID", strconv.Itoa(cmd.Process.Pid))
		HideCommandWindow(killCmd)
		if err := killCmd.Run(); err == nil {
			return nil
		}
	}
	return cmd.Process.Kill()
}
