package main

// webtools_app.go：联网工具的 Wails 绑定——引擎在 internal/webtools，这里只转发。

import "datalens/internal/webtools"

func (a *App) WebSearch(query string, maxResults int) (map[string]interface{}, error) {
	return webtools.Search(query, maxResults)
}

func (a *App) WebFetch(rawURL string, maxChars int) (map[string]interface{}, error) {
	return webtools.Fetch(rawURL, maxChars)
}
