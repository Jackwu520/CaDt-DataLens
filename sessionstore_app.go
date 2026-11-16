package main

// sessionstore_app.go：AI 会话磁盘存储的宿主注入——绑定方法随 Service 移入
// internal/sessionstore，这里只登记应用数据目录与派生索引的标脏钩子。

import (
	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
)

func init() {
	sessionstore.AppDataDir = appDataRoot
	sessionstore.OnBodyChange = sessionindex.MarkDirty
	sessionstore.OnMetaChange = sessionindex.UpdateMeta
	sessionstore.OnRemove = sessionindex.Delete
	sessionstore.OnClear = sessionindex.Clear
}
