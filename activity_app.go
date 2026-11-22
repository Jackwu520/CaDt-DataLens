package main

// activity_app.go：操作留痕的 Wails 绑定——引擎在 internal/activity，这里只转发。

import "datalens/internal/activity"

// 宿主注入：应用数据根目录与诊断日志都来自 main 包。
func init() {
	activity.AppDataDir = appDataRoot
	activity.Logf = writeAppLog
}

func (a *App) ActivityAppend(entriesJSON string) error {
	return activity.Append(entriesJSON)
}

func (a *App) ActivityRead(queryJSON string) (string, error) {
	return activity.Read(queryJSON)
}

func (a *App) ActivityClear() error {
	return activity.Clear()
}

func (a *App) ActivityPath() (string, error) {
	return activity.Path()
}