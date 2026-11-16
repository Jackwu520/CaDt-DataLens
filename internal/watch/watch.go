package watch

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// WatchWorkspace 递归监听工作区，变化时通过 workspace-changed 事件推给前端；
// 监听失败时前端仍保留轮询兜底。
func (w *Watcher) WatchWorkspace(root string) error {
	root = strings.TrimSpace(root)
	if root == "" {
		w.stopWorkspaceWatch()
		return nil
	}
	info, err := os.Stat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是目录：%s", root)
	}
	w.mu.Lock()
	w.stopWatcherLocked()
	stop := make(chan struct{})
	done := make(chan struct{})
	w.root = root
	w.stop = stop
	w.done = done
	w.mu.Unlock()
	logf("info", "文件监听：%s", root)
	go func() {
		defer close(done)
		err := watchDirectory(root, stop, func(paths []string, overflow bool) {
			emit("workspace-changed", map[string]interface{}{
				"root":     root,
				"paths":    paths,
				"overflow": overflow,
			})
		})
		if err != nil {
			logf("warn", "文件监听已停止（%s）：%v", root, err)
		}
	}()
	return nil
}

func (w *Watcher) UnwatchWorkspace() {
	w.stopWorkspaceWatch()
}

func (w *Watcher) stopWorkspaceWatch() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopWatcherLocked()
}

func (w *Watcher) stopWatcherLocked() {
	if w.stop == nil {
		return
	}
	close(w.stop)
	w.stop = nil
	done := w.done
	w.done = nil
	w.root = ""
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}
