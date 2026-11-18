package watch

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// worktreeSkipPrefix AI 隔离 worktree 的固定父目录（相对监听根，正斜杠语义）。
const worktreeSkipPrefix = ".cadt/worktree"

// skipWorktreeEvent 过滤 AI 隔离 worktree（.cadt/worktree）内部的变更事件：worktree 是
// 给 AI 自己看的草稿区，UI 不需要刷新；且全量检出/依赖安装的事件洪峰会冲出 overflow
// （内核丢事件，前端被迫对所有打开文档 stat 一遍）。patch 回灌到主根后走正常通知路径。
// 只跳 worktree 子树——.cadt/logs、.cadt/patches 等事件量小且有意义，保持推送。
// paths 为监听根相对路径（Windows 下 ReadDirectoryChangesW 返回反斜杠）。overflow 事件
// 本身不过滤（内核已丢事件，前端有既有兜底）。
func skipWorktreeEvent(path string) bool {
	rel := strings.ToLower(strings.Trim(strings.ReplaceAll(path, "\\", "/"), "/"))
	if rel == "" {
		return false
	}
	return rel == worktreeSkipPrefix || strings.HasPrefix(rel, worktreeSkipPrefix+"/")
}

// watchEvent 单条目录通知。Removed 标记「消失」类动作（FILE_ACTION_REMOVED /
// RENAMED_OLD_NAME——文件被删或被 rename 走），与「出现/修改」类区分：wipe-guard 的
// 删除计数只认前者，原子写（temp→rename）与补丁回灌产生的是 added/renamed_new/modified，
// 几十个文件的合法写入不该计入破坏判定。Windows 实现填充本字段，其它平台恒 false。
type watchEvent struct {
	Path    string
	Removed bool
}

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
		err := watchDirectory(root, stop, func(events []watchEvent, overflow bool) {
			filtered := make([]string, 0, len(events))
			removed := make([]string, 0, len(events))
			for _, e := range events {
				if skipWorktreeEvent(e.Path) {
					continue
				}
				filtered = append(filtered, e.Path)
				if e.Removed {
					// 「消失」类动作（被删 / rename 走）单独成组：wipe-guard 的删除计数
					// 只认它——原子写与补丁回灌产生的是 added/renamed_new/modified，
					// 几十个文件的合法写入不该触发破坏告警。
					removed = append(removed, e.Path)
				}
			}
			if overflow || len(filtered) > 0 {
				emit("workspace-changed", map[string]interface{}{
					"root":     root,
					"paths":    filtered,
					"removed":  removed,
					"overflow": overflow,
				})
			}
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
