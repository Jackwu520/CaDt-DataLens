//go:build !windows

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func applyTaskbarIcon() {}

func showWindowWhenReady(win *application.WebviewWindow) {
	if win != nil {
		win.Show()
	}
}
