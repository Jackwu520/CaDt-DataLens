//go:build !windows

package main

// 关闭行为（最小化到托盘）的非 Windows 侧接缝：没有通知区域，能力一律为假。

import "datalens/internal/tray"

func appTrayIconID() uintptr { return 0 }

func traySupported() bool { return tray.Supported() }

func systemShuttingDown() bool { return false }
