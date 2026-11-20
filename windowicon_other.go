//go:build !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func applyTaskbarIcon() {}

func showWindowWhenReady(win *application.WebviewWindow, maximised bool) {
	if win == nil {
		return
	}
	if maximised {
		win.Maximise()
		return
	}
	win.Show()
}
