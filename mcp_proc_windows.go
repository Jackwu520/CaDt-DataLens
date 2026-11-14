//go:build windows

// mcp_proc_windows.go：MCP 子进程的平台差异收敛——把 Windows-only 的进程辅助
// （executil / app_commands 的未打标签实现）隔离进带标签文件，供跨平台安全的 mcp_client.go 调用。
// Job Object 是 taskkill 之外的内核级兜底：本应用崩溃/被强杀时（taskkill 没机会执行）
// 句柄关闭即杀整组；server 进程已退出、孙进程成孤儿的场景 taskkill /T 无从展开，Job 仍持有。
package main

import (
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

func mcpHideWindow(cmd *exec.Cmd) {
	hideCommandWindow(cmd) // CREATE_NO_WINDOW：GUI 进程拉起控制台子进程防黑框
}

func mcpKillTree(cmd *exec.Cmd) error {
	return killProcessTree(cmd) // taskkill /F /T 连树终止，失败回落 Process.Kill()
}

// mcpAttachJob 把子进程放进 KILL_ON_JOB_CLOSE 的 Job，返回释放函数（关句柄 = 杀整组）。
// 必须在 cmd.Start() 之后调用（要有 PID）；Start 到 attach 之间的极短窗口里拉起的
// 子进程会逃出 Job——所以 killProcessTree 与 Job 两条路都要，不是二选一。
func mcpAttachJob(cmd *exec.Cmd) (closeFn func(), err error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info))); err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		_ = windows.CloseHandle(job)
		return nil, err
	}
	return func() { _ = windows.CloseHandle(job) }, nil
}
