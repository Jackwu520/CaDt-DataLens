//go:build windows

package main

// 关闭行为（最小化到托盘）的 Windows 侧接缝：托盘图标编号与「系统是否正在关机」。

import (
	"syscall"

	"datalens/internal/tray"
)

// appTrayIconID 返回托盘图标用的 exe 图标组编号（与任务栏同一个，见 windowicon_windows.go）。
func appTrayIconID() uintptr { return appIconID }

// traySupported 报告当前平台能否真的挂托盘图标。
func traySupported() bool { return tray.Supported() }

var procShutdownProbe = syscall.NewLazyDLL("user32.dll").NewProc("GetSystemMetrics")

// smShuttingDown 是 GetSystemMetrics 的 SM_SHUTTINGDOWN：非 0 表示系统正在关机/重启。
const smShuttingDown = 0x2000

// systemShuttingDown 报告系统是否正在关机/重启。
// 这时点 X 不能藏进托盘——Windows 在等进程退出，藏起来就等于「关不掉」。
func systemShuttingDown() bool {
	v, _, _ := procShutdownProbe.Call(smShuttingDown)
	return v != 0
}

func init() {
	tray.Logf = writeAppLog
}
