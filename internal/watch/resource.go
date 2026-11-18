// resource.go：按资源 key 监听目录，变化时发 resource-changed。
//
// 与工作区 Watcher 相互独立：一个进程可能同时监听工作区（递归）与若干打开的
// memo / 会话目录。回调只做过滤与 emit；索引标脏等重活由 OnEvent 钩子异步处理。
package watch

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// ResourceWatcher 按 kind+key 维护多个目录监听。
type ResourceWatcher struct {
	mu      sync.Mutex
	watches map[string]*resourceWatch
	// OnEvent 是可选的进程内钩子（如 ai-session 变更时给派生索引标脏）。
	// 它在 watcher goroutine 里被调用，实现必须自行保证不阻塞（丢 goroutine/队列）。
	OnEvent func(kind, key string, paths []string, overflow bool)
}

type resourceWatch struct {
	kind string
	key  string
	stop chan struct{}
	done chan struct{}
}

// Resources 是进程级的资源监听器；根壳在 startup 注入的事件通道上广播。
var Resources = NewResourceWatcher()

func NewResourceWatcher() *ResourceWatcher {
	return &ResourceWatcher{watches: map[string]*resourceWatch{}}
}

// Watch 开始监听 dir（递归），替换同 kind+key 的旧监听。
// 非 Windows 上系统通知不可用时 goroutine 会记一条 warn；绑定仍返回 nil，
// 前端退回 focus/轮询刷新。
func (w *ResourceWatcher) Watch(kind, key, dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return fmt.Errorf("监听目录为空")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是目录：%s", dir)
	}
	id := kind + "|" + key
	w.mu.Lock()
	w.stopLocked(id)
	stop := make(chan struct{})
	done := make(chan struct{})
	w.watches[id] = &resourceWatch{kind: kind, key: key, stop: stop, done: done}
	w.mu.Unlock()
	logf("info", "资源监听：%s %s -> %s", kind, key, dir)
	go func() {
		defer close(done)
		err := watchDirectory(dir, stop, func(events []watchEvent, overflow bool) {
			paths := make([]string, 0, len(events))
			for _, e := range events {
				paths = append(paths, e.Path)
			}
			if w.OnEvent != nil {
				w.OnEvent(kind, key, paths, overflow)
			}
			emit("resource-changed", map[string]interface{}{
				"kind":     kind,
				"key":      key,
				"paths":    paths,
				"overflow": overflow,
			})
		})
		if err != nil {
			logf("warn", "资源监听已停止（%s %s）：%v", kind, key, err)
		}
	}()
	return nil
}

// Unwatch 停止监听；不存在时静默。
func (w *ResourceWatcher) Unwatch(kind, key string) {
	w.mu.Lock()
	w.stopLocked(kind + "|" + key)
	w.mu.Unlock()
}

// StopAll 停止全部监听（窗口关闭/测试用）。
func (w *ResourceWatcher) StopAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	for id := range w.watches {
		w.stopLocked(id)
	}
}

func (w *ResourceWatcher) stopLocked(id string) {
	item := w.watches[id]
	if item == nil {
		return
	}
	delete(w.watches, id)
	close(item.stop)
	select {
	case <-item.done:
	case <-time.After(2 * time.Second):
	}
}
