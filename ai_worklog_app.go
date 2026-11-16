package main

// ai_worklog_app.go：AI 工作日志的 Wails 绑定——引擎在 internal/aiworklog。

import "datalens/internal/aiworklog"

func init() {
	aiworklog.Logf = writeAppLog
}

// AIWorklogAppend write_worklog 工具的后端通道：向 <工作区>/.cadt/logs/ 追加一条工作日志，
// 返回条目正文的绝对路径。root 必须是绝对路径的工作区根；标题必填，摘要可选。
func (a *App) AIWorklogAppend(root string, title string, summary string) (string, error) {
	return aiworklog.Append(root, title, summary)
}
