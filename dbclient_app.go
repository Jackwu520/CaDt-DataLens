package main

// dbclient_app.go：数据库连接与浏览的 Wails 绑定——引擎整体在 internal/dbclient，这里只转发。
// 前端经 Call.ByName('main.App.<方法>') 动态解析；dev/mock-backend.js 必须补同名 mock。

import (
	"fmt"
	"os"

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

// DBCreateSQLite 新建空 SQLite 库文件（已存在即报错，不覆盖；前端「新建 SQLite 数据库…」入口）。
func (a *App) DBCreateSQLite(path string) error {
	return dbclient.CreateSQLite(path)
}

// DBReadImportFile 导入数据（CSV/JSONL）的文本读取：UTF-8，上限 20 MB 防大文件卡顿。
func (a *App) DBReadImportFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(data) > 20*1024*1024 {
		return "", fmt.Errorf("导入文件超过 20 MB 上限，请先拆分再导入")
	}
	return string(data), nil
}

func (a *App) DBConnect(connectionID string) (dbclient.SessionInfo, error) {
	return dbclient.Connect(connectionID)
}

// ---------- Redis 键空间（redis_session.go；方案 §5.4） ----------

// DBRedisScan SCAN 一批键（cursor 续扫；MATCH/TYPE/COUNT 可选），批量带出类型/TTL/长度。
func (a *App) DBRedisScan(id, database, pattern string, cursor uint64, count int, typeFilter string) (dbclient.RedisScanResult, error) {
	return dbclient.RedisScanKeys(id, database, pattern, cursor, count, typeFilter)
}

// DBRedisFetchValue 读一个键的值（按类型统一转行集；string 走 Text/HexText）。
func (a *App) DBRedisFetchValue(id, database, key string) (dbclient.RedisValue, error) {
	return dbclient.RedisFetchValue(id, database, key)
}

// DBRedisApply 结构化编辑提交（editable 会话；前端展示等价命令预览后调用）。
func (a *App) DBRedisApply(id string, ops []dbclient.RedisOp) (sqlview.SQLResult, error) {
	return dbclient.RedisApply(id, ops)
}

// DBRedisDeleteByPrefix 前缀批量删除（SCAN + UNLINK；前端确认后调用；空前缀拒绝）。
func (a *App) DBRedisDeleteByPrefix(id, database, prefix string) (dbclient.RedisPrefixDelete, error) {
	return dbclient.RedisDeleteByPrefix(id, database, prefix)
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
