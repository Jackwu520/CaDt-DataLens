package main

// run_project_app.go：项目感知运行的 Wails 绑定——引擎在 internal/runproject。

import "datalens/internal/runproject"

// DetectRunProject 从文件或目录向上探测项目标记，返回项目根与候选命令。
func (a *App) DetectRunProject(path string) (*runproject.RunProjectInfo, error) {
	return runproject.Detect(path)
}
