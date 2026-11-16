package main

// ai_catalog_app.go：模型配置表的 Wails 绑定——引擎在 internal/aicatalog，
// 这里只转发并注入应用数据目录与版本。

import (
	"context"
	"time"

	"datalens/internal/aicatalog"
)

func init() {
	aicatalog.AppDataDir = appDataRoot
	aicatalog.Version = appVersion
}

// AIModelCatalogCached 读缓存；没有缓存返回空 blob（不是错误——内置表兜底）。
func (a *App) AIModelCatalogCached() (*aicatalog.Blob, error) {
	return aicatalog.Cached()
}

// AIModelCatalogSync 拉取远端表：校验通过才落盘，失败时旧缓存原样保留。
func (a *App) AIModelCatalogSync(rawURL string) (*aicatalog.Blob, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return aicatalog.Sync(ctx, rawURL)
}
