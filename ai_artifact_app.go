package main

// ai_artifact_app.go：AI 工具结果大对象落盘区的 Wails 绑定——引擎在 internal/aiartifact，
// 这里只转发。前端在工具结果超阈值时写、删会话时清。

import "datalens/internal/aiartifact"

// AIArtifactWrite 把一段超长工具结果落盘，返回绝对路径（路径由宿主决定，前端不能指定目录）。
func (a *App) AIArtifactWrite(sessionID string, name string, content string) (string, error) {
	return aiartifact.Write(sessionID, name, content)
}

// AIArtifactClear 删除某会话的全部产物（删会话时调用）。
func (a *App) AIArtifactClear(sessionID string) error {
	return aiartifact.ClearSession(sessionID)
}

// AIArtifactClearAll 删除全部产物（删除所有会话时调用；也是一键清缓存里的同名条目）。
func (a *App) AIArtifactClearAll() error {
	return aiartifact.ClearAll()
}
