//go:build windows

package main

// spike 的 Win32 自查：无边框（验证项 1）与同进程窗口枚举。

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

var (
	user32             = syscall.NewLazyDLL("user32.dll")
	procFindWindowW    = user32.NewProc("FindWindowW")
	procGetWindowLongW = user32.NewProc("GetWindowLongW")
	procGetWindowRect  = user32.NewProc("GetWindowRect")
	procGetClientRect  = user32.NewProc("GetClientRect")
	procClientToScreen = user32.NewProc("ClientToScreen")
)

func checkFrameless() {
	title, err := syscall.UTF16PtrFromString(mainWindowTitle)
	if err != nil {
		logf("[go] frameless 自查：标题转换失败 %v", err)
		return
	}
	hwnd, _, callErr := procFindWindowW.Call(0, uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		logf("[go] frameless 自查：FindWindowW 未找到窗口（title=%q, err=%v）", mainWindowTitle, callErr)
		return
	}

	// v3 的 Frameless 是标准 custom-frame 方案（WM_NCCALCSIZE 裁非客户区），
	// 窗口仍保留 WS_OVERLAPPEDWINDOW（为了 resize/阴影）。所以判据不是
	// WS_CAPTION 位，而是「客户区是否铺满整窗」：frame 内缩量应为 0。
	const gwlStyle = ^uintptr(15) // -16
	style, _, _ := procGetWindowLongW.Call(hwnd, gwlStyle)
	s := uint32(style)

	type rect struct{ Left, Top, Right, Bottom int32 }
	var wr rect
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&wr)))
	var cr rect
	procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&cr)))
	var origin struct{ X, Y int32 }
	procClientToScreen.Call(hwnd, uintptr(unsafe.Pointer(&origin)))

	frameLeft := origin.X - wr.Left
	frameTop := origin.Y - wr.Top
	frameRight := wr.Right - (origin.X + cr.Right)
	frameBottom := wr.Bottom - (origin.Y + cr.Bottom)
	total := frameLeft + frameTop + frameRight + frameBottom

	logf("[go] frameless 自查：hwnd=%#x style=%#x WS_CAPTION=%v", hwnd, s, s&0x00C00000 != 0)
	logf("[go] frameless 自查：frame 内缩 left=%d top=%d right=%d bottom=%d（合计 %d）→ frameless=%v",
		frameLeft, frameTop, frameRight, frameBottom, total, total <= 4)

	// 枚举本进程窗口，辅助确认两个窗口都在同一进程。
	enumWindowsByPID(os.Getpid())
}

func enumWindowsByPID(pid int) {
	user32Enum := user32.NewProc("EnumWindows")
	var found []string
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var wpid uint32
		user32.NewProc("GetWindowThreadProcessId").Call(hwnd, uintptr(unsafe.Pointer(&wpid)))
		if wpid != uint32(pid) {
			return 1
		}
		buf := make([]uint16, 256)
		n, _, _ := user32.NewProc("GetWindowTextW").Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		title := syscall.UTF16ToString(buf[:n])
		visible, _, _ := user32.NewProc("IsWindowVisible").Call(hwnd)
		if title != "" {
			found = append(found, fmt.Sprintf("%q(visible=%v)", title, visible != 0))
		}
		return 1
	})
	user32Enum.Call(cb, 0)
	logf("[go] 本进程窗口枚举（pid=%d）：%v", pid, found)
}
