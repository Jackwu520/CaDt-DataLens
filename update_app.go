package main

// update_app.go：检查更新的 Wails 绑定——引擎在 internal/update。

import "datalens/internal/update"

func init() {
	update.Version = appVersion
}

func (a *App) CheckForUpdates() (*update.UpdateInfo, error) {
	return update.Check()
}
