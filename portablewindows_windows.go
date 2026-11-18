//go:build windows

package main

// 多窗口 = 多进程，没有跨进程事件总线（见 docs/unfinished-plans/multi-instance-sync.md §1.1）。
// 「关掉的是不是最后一个应用窗口」只能靠枚举系统窗口来答：同 exe + 类名 wailsWindow +
// 标题不是 AI 浮窗 / 调试控制台，排除本进程。
//
// 为什么不用 --new-window 或启动参数判定身份：窗口模式（openMode=window）下双击文件拉起的
// 进程既不带 --new-window、参数里也只有那个文件；newwindow.OpenFiles 同样是裸参数。
// 那个标记只决定「要不要抢单实例锁」，与「这是主窗口还是文件窗口」无关。

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	wailsWindowClassName = "wailsWindow"
	// PROCESS_QUERY_LIMITED_INFORMATION：查别的进程 exe 路径用的最小权限。
	processQueryLimitedInfo = 0x1000
	// 长路径上限（\?\ 前缀的 exe 路径可能远超 MAX_PATH）。
	maxLongPath = 32767
)

var (
	procWindowText          = user32.NewProc("GetWindowTextW")
	procWindowTextLength    = user32.NewProc("GetWindowTextLengthW")
	procOpenProcess         = kernel32.NewProc("OpenProcess")
	procCloseHandle         = kernel32.NewProc("CloseHandle")
	procQueryProcessExeName = kernel32.NewProc("QueryFullProcessImageNameW")
)

// countOtherPortableWindows 统计「除本进程之外还活着的应用窗口」数量。
// 隐藏的窗口也算（它进程还在、任务还在跑，正是「别退到后台」的理由）；
// 打不开别人进程信息时按「不算」处理——最坏结果是判成最后一个窗口而藏起来，
// 程序不会丢东西，比误判成「还有窗口」导致程序直接退出要好。
func countOtherPortableWindows() int {
	selfPID := uint32(os.Getpid())
	selfExe := currentExePath()
	count := 0
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var pid uint32
		procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid == 0 || pid == selfPID {
			return 1
		}
		if windowClassName(hwnd) != wailsWindowClassName {
			return 1
		}
		if !isPortableWindowTitle(windowTitle(hwnd)) {
			return 1
		}
		if !strings.EqualFold(exePathForPID(pid), selfExe) {
			return 1
		}
		count++
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return count
}

func windowClassName(hwnd uintptr) string {
	var buf [64]uint16
	n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:n])
}

// windowTitle 跨进程读窗口标题：GetWindowTextW 对别的进程只读窗口缓存，不会发消息，不会卡。
func windowTitle(hwnd uintptr) string {
	n, _, _ := procWindowTextLength.Call(hwnd)
	if n == 0 {
		return ""
	}
	buf := make([]uint16, int(n)+1)
	got, _, _ := procWindowText.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if got == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:got])
}

func exePathForPID(pid uint32) string {
	h, _, _ := procOpenProcess.Call(processQueryLimitedInfo, 0, uintptr(pid))
	if h == 0 {
		return ""
	}
	defer procCloseHandle.Call(h)
	buf := make([]uint16, maxLongPath)
	size := uint32(len(buf))
	ok, _, _ := procQueryProcessExeName.Call(h, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 || size == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}

// currentExePath 本进程 exe 的规范路径（比较用，NotFound 时返回空串）。
func currentExePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Clean(exe)
}
