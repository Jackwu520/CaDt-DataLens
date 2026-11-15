//go:build !windows

package main

// AppWindowActive 在非 Windows 平台无窗口判定，恒为前台。
func (a *App) AppWindowActive() bool { return true }

// prepareNotifyApp 在非 Windows 平台无操作。
func prepareNotifyApp() {}

// NotifyAttention 在非 Windows 平台无操作。
func (a *App) NotifyAttention(beep bool) {}

// NotifySystemToast 在非 Windows 平台无操作。
func (a *App) NotifySystemToast(title string, body string, silent bool) error { return nil }
