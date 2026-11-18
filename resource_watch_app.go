// resource_watch_app.go：多实例同步的资源目录监听（memo / AI 会话）。
//
// 监听本身在 internal/watch；这里只做三件事：按业务 id 解析目录、把
// ai-session 的变更异步标脏派生索引、暴露 Wails 绑定。回调必须快，
// MarkDirty 走 SQLite，丢 goroutine 执行。

package main

import (
	"strings"

	"datalens/internal/memo"
	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
	"datalens/internal/watch"
)

func init() {
	watch.Resources.OnEvent = func(kind, key string, paths []string, overflow bool) {
		if kind != "ai-session" {
			return
		}
		if overflow || len(paths) == 0 {
			go sessionindex.MarkDirty(key)
			return
		}
		for _, path := range paths {
			norm := strings.ToLower(strings.ReplaceAll(path, "\\", "/"))
			if strings.HasSuffix(norm, "session.v1.jsonl") || strings.HasSuffix(norm, "meta.json") {
				go sessionindex.MarkDirty(key)
				return
			}
		}
	}
}

// MemoWatch 监听一个便签作用域目录。工作区作用域已有 workspace-changed，
// 前端只需对全局作用域调用；绑定保留 scope 参数以便复用。
func (a *App) MemoWatch(scope, workspace string) error {
	root, err := memo.RootPath(scope, workspace)
	if err != nil {
		return err
	}
	return watch.Resources.Watch("memo", scope, root)
}

// MemoUnwatch 停止便签目录监听。
func (a *App) MemoUnwatch(scope, workspace string) error {
	watch.Resources.Unwatch("memo", scope)
	return nil
}

// AISessionWatch 监听当前打开的会话目录；目录不存在（新会话）时返回错误，前端忽略。
func (a *App) AISessionWatch(id string) error {
	store, err := sessionstore.Default()
	if err != nil {
		return err
	}
	dir, err := store.SessionDir(id)
	if err != nil {
		return err
	}
	return watch.Resources.Watch("ai-session", id, dir)
}

// AISessionUnwatch 停止会话目录监听。
func (a *App) AISessionUnwatch(id string) error {
	watch.Resources.Unwatch("ai-session", id)
	return nil
}
