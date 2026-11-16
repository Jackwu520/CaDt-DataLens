package main

// sqlview_app.go：只读 SQL 查询的 Wails 绑定——引擎整体在 internal/sqlview，这里只转发。

import "datalens/internal/sqlview"

func (a *App) SQLImport(path, kind, encoding, text string, useText bool) (sqlview.SQLImportInfo, error) {
	return sqlview.Import(path, kind, encoding, text, useText)
}

func (a *App) SQLQuery(id, query string, limit int) (sqlview.SQLResult, error) {
	return sqlview.Query(id, query, limit)
}

func (a *App) SQLClose(id string) error {
	return sqlview.Close(id)
}
