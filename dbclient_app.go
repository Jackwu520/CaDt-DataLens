package main

// dbclient_app.go：数据库连接与浏览的 Wails 绑定——引擎整体在 internal/dbclient，这里只转发。
// 前端经 Call.ByName('main.App.<方法>') 动态解析；dev/mock-backend.js 必须补同名 mock。

import (
	"datalens/internal/dbclient"
	"datalens/internal/sqlview"
)

// 宿主注入：应用数据根目录与诊断日志都来自 main 包（activity_app.go 同款）。
func init() {
	dbclient.AppDataDir = appDataRoot
	dbclient.Logf = writeAppLog
}

func (a *App) DBOpen(path string, allowEdit bool) (dbclient.SessionInfo, error) {
	return dbclient.OpenSQLite(path, allowEdit)
}

func (a *App) DBConnect(connectionID string) (dbclient.SessionInfo, error) {
	return dbclient.Connect(connectionID)
}

func (a *App) DBListDatabases(id string) ([]string, error) {
	return dbclient.ListDatabases(id)
}

func (a *App) DBListObjects(id, database string) ([]dbclient.DBObject, error) {
	return dbclient.ListObjects(id, database)
}

func (a *App) DBDescribe(id, database, table string, noCache bool) (*dbclient.DBTableMeta, error) {
	return dbclient.Describe(id, database, table, noCache)
}

// DBListServerObjects 服务器对象分组（MySQL 专属：排序规则/用户/系统虚拟视图；其他 kind 返回 null）。
func (a *App) DBListServerObjects(id string) (*dbclient.ServerObjects, error) {
	return dbclient.ListServerObjects(id)
}

func (a *App) DBBrowse(id string, req dbclient.BrowseRequest) (sqlview.SQLResult, error) {
	return dbclient.Browse(id, req)
}

// DBQuery 控制台查询：confirmed=false 时危险/缺 WHERE 语句返回 Status=confirm（两阶段确认）。
func (a *App) DBQuery(id, queryID, query string, confirmed bool, limit int) (dbclient.QueryOutcome, error) {
	return dbclient.Query(id, queryID, query, confirmed, limit)
}

func (a *App) DBCancel(id, queryID string) error {
	return dbclient.Cancel(id, queryID)
}

func (a *App) DBClose(id string) error {
	return dbclient.CloseSession(id)
}

func (a *App) DBListConnections() ([]dbclient.ConnectionConfig, error) {
	return dbclient.ListConnections()
}

func (a *App) DBSaveConnection(cfg dbclient.ConnectionConfig, password string) (dbclient.ConnectionConfig, error) {
	return dbclient.SaveConnection(cfg, password)
}

func (a *App) DBDeleteConnection(id string) error {
	return dbclient.DeleteConnection(id)
}

func (a *App) DBTestConnection(cfg dbclient.ConnectionConfig, password string) (string, error) {
	return dbclient.TestConnection(cfg, password)
}

func (a *App) DBPreviewChanges(id string, changes dbclient.TableChanges) ([]dbclient.ChangeStatement, error) {
	return dbclient.PreviewChanges(id, changes)
}

func (a *App) DBApplyChanges(id string, changes dbclient.TableChanges) (dbclient.ApplyResult, error) {
	return dbclient.ApplyChanges(id, changes)
}

// DBCredentialPut / DBCredentialGet：插件数据库驱动的通用凭据存取
// （键任意字符串，约定 dbplug:<条目id>:<字段键>；dpapi 加密，与连接凭据同一张表）。
func (a *App) DBCredentialPut(key, plain string) error {
	return dbclient.CredentialPut(key, plain)
}

func (a *App) DBCredentialGet(key string) (string, error) {
	return dbclient.CredentialGet(key)
}
