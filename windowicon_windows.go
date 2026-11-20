//go:build windows

package main

import (
	"os"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	wmSetIcon = 0x0080
	iconSmall = 0
	iconBig   = 1
	imageIcon = 1 // IMAGE_ICON
	appIconID = 3 // 与 wails 的 pkg/options/windows.AppIconID 一致，即 rsrc 里的图标组编号
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procGetClassNameW            = user32.NewProc("GetClassNameW")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procSetClassLongPtrW         = user32.NewProc("SetClassLongPtrW")
	procLoadImageW               = user32.NewProc("LoadImageW")
	procGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procSendMessageTimeoutW      = user32.NewProc("SendMessageTimeoutW")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")
)

// applyTaskbarIcon 给主窗口补上 ICON_BIG。
// wails 只设置了 ICON_SMALL，而 Windows 11 任务栏按钮按 ICON_BIG 绘制，
// 不补会先显示系统默认的空白占位图标，几十秒后才被替换成真实图标。
func applyTaskbarIcon() {
	hwnd := findWailsWindow()
	if hwnd == 0 {
		return
	}
	hinst, _, _ := procGetModuleHandleW.Call(0)
	cx, _, _ := procGetSystemMetrics.Call(11)      // SM_CXICON
	cy, _, _ := procGetSystemMetrics.Call(12)      // SM_CYICON
	cxSmall, _, _ := procGetSystemMetrics.Call(49) // SM_CXSMICON
	cySmall, _, _ := procGetSystemMetrics.Call(50) // SM_CYSMICON
	big, _, _ := procLoadImageW.Call(hinst, appIconID, imageIcon, cx, cy, 0)
	small, _, _ := procLoadImageW.Call(hinst, appIconID, imageIcon, cxSmall, cySmall, 0)
	if big != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconBig, big)
		procSetClassLongPtrW.Call(hwnd, ^uintptr(13), big) // GCLP_HICON = -14
	}
	if small != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, small)
		procSetClassLongPtrW.Call(hwnd, ^uintptr(33), small) // GCLP_HICONSM = -34
	}
}

// showWindowWhenReady 等窗口线程从导航初始化里松手后再显示窗口。
// wails 在 webview 导航完成时就显示窗口，但此时 UI 线程还会被初始化工作占住约 1 秒，
// Explorer 查询窗口图标会超时，任务栏只能先画占位图标。等一小段再显示并补图标。
func showWindowWhenReady(win *application.WebviewWindow) {
	if win == nil {
		return
	}
	go func() {
		time.Sleep(windowShowDelay)
		applyTaskbarIcon()
		win.Show()
		// 任务栏按钮出现后再补两次，确保 Explorer 刷新到窗口图标。
		time.Sleep(60 * time.Millisecond)
		applyTaskbarIcon()
		time.Sleep(300 * time.Millisecond)
		applyTaskbarIcon()
	}()
}

func findWailsWindow() uintptr {
	pid := uint32(os.Getpid())
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var wpid uint32
		procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&wpid)))
		if wpid != pid {
			return 1
		}
		var buf [64]uint16
		n, _, _ := procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		if syscall.UTF16ToString(buf[:n]) == "WailsWebviewWindow" || syscall.UTF16ToString(buf[:n]) == "wailsWindow" {
			found = hwnd
			return 0
		}
		return 1
	})
	procEnumWindows.Call(cb, 0)
	return found
}
