package main

// ai_gen_app.go：生图/视频执行通道的 Wails 绑定——引擎在 internal/aigen，
// 这里只转发参数并把应用版本注入 User-Agent。

import "datalens/internal/aigen"

func init() {
	aigen.Version = appVersion
}

func (a *App) AIGenHTTPRequest(specJSON string) aigen.HTTPResult {
	return aigen.HTTPRequest(specJSON)
}

func (a *App) AIGenSaveProducts(specJSON string) aigen.SaveResult {
	return aigen.SaveProducts(specJSON)
}
