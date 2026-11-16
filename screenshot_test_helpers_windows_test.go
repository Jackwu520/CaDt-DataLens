//go:build windows

package main

import "syscall"

// 浏览器宿主已下沉 internal/browser；截图测试只需要一组创建临时窗口的 Win32 入口。
var (
	screenshotUser32   = syscall.NewLazyDLL("user32.dll")
	screenshotKernel32 = syscall.NewLazyDLL("kernel32.dll")

	procBrowserGetModuleHandle = screenshotKernel32.NewProc("GetModuleHandleW")
	procBrowserRegisterClassW  = screenshotUser32.NewProc("RegisterClassExW")
	procBrowserCreateWindowEx  = screenshotUser32.NewProc("CreateWindowExW")
	procBrowserDefWindowProcW  = screenshotUser32.NewProc("DefWindowProcW")
	procBrowserShowWindow      = screenshotUser32.NewProc("ShowWindow")
	procBrowserDestroyWindow   = screenshotUser32.NewProc("DestroyWindow")
)