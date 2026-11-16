//go:build windows

package main

// notify_app_windows.go：系统通知引擎（internal/notify）的宿主接线。

import "datalens/internal/notify"

func init() {
	notify.Logf = writeAppLog
	notify.IconID = appIconID
}
