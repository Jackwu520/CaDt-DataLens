package main

// app_preview_assets.go：预览资源注册表的 Wails 绑定壳（引擎在 internal/previewassets）。

import "datalens/internal/previewassets"

// RegisterPreviewRoot 供前端注册 HTML 预览的资源根目录，返回访问 token。
func (a *App) RegisterPreviewRoot(dir string) (string, error) {
	return previewassets.Register(dir)
}
