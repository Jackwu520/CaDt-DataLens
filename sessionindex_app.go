package main

// sessionindex_app.go：AI 会话搜索索引的 Wails 绑定——引擎在 internal/sessionindex，
// 这里只按调用构造会话存储并转发。

import (
	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
)

// 宿主注入：应用数据根目录来自 appdata.go。
func init() {
	sessionindex.AppDataDir = appDataRoot
}

func (a *App) AISessionSearch(query string, limit int) ([]sessionindex.SearchHit, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return nil, err
	}
	return sessionindex.Search(store, query, limit)
}

func (a *App) AISessionSearchScoped(query string, limit int, brief bool) (sessionindex.ScopedSearchResult, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return sessionindex.ScopedSearchResult{}, err
	}
	return sessionindex.SearchScoped(store, query, limit, brief)
}

func (a *App) AISessionReindex() (int, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return 0, err
	}
	return sessionindex.Reindex(store)
}

func (a *App) AISessionIndexStats() (sessionindex.IndexStats, error) {
	store, err := sessionstore.Default()
	if err != nil {
		return sessionindex.IndexStats{}, err
	}
	return sessionindex.Stats(store)
}

func (a *App) AISessionIndexPath() (string, error) {
	return sessionindex.Path(), nil
}
