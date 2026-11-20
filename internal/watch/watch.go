package watch

import (
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// worktreeSkipPrefix AI 隔离 worktree 的固定父目录（相对监听根，正斜杠语义）。
const worktreeSkipPrefix = ".cadt/worktree"

// quietGraceDuration 静默期结束后的宽限期：内核缓冲区里可能还压着静默期间产生的通知，
// 给它们留出读出窗口，避免「操作刚结束、旧删除事件刚好读出来」又计数。
// 变量而非常量只为测试可替换（生产恒 2s）。
var quietGraceDuration = 2 * time.Second

var (
	// quietDepth 正在进行的应用自身批量目录操作数（>0 = 静默中）。
	quietDepth atomic.Int32
	// quietUntil 静默解除后的宽限截止（UnixNano）。
	quietUntil atomic.Int64
)

// BeginQuiet 开始一段「应用自身的批量目录操作」静默期：插件安装 / 更新 / 卸载这类
// 整目录删除再复制的动作由应用主动发起，不该被 wipe-guard 当成工作区破坏。
// 静默期内 workspace-changed 事件照常推送（UI 仍需刷新），只是 removed / present
// 两个供破坏判定用的分组被清空。
func BeginQuiet() { quietDepth.Add(1) }

// EndQuiet 结束一段静默期；归零时再保留 quietGrace 的宽限。
func EndQuiet() {
	if quietDepth.Add(-1) > 0 {
		return
	}
	quietDepth.Store(0) // 配对出错（多调了 End）时不落到负数
	quietUntil.Store(time.Now().Add(quietGraceDuration).UnixNano())
}

// quietActive 当前是否处于静默期。
func quietActive() bool {
	if quietDepth.Load() > 0 {
		return true
	}
	return time.Now().UnixNano() < quietUntil.Load()
}

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

// WatchWorkspaceFor 递归监听 owner 的工作区，变化时通过 workspace-changed 事件推
// 给前端；监听失败时前端仍保留轮询兜底。root 为空 = 停掉该归属者的监听。
// 同归属者重复调用 = 换根（替换自己的槽）；不同归属者互不影响。
func (w *Watcher) WatchWorkspaceFor(owner, root string) error {
	owner = strings.TrimSpace(owner)
	root = strings.TrimSpace(root)
	w.mu.Lock()
	if old := w.slotLocked(owner); old != nil {
		stopSlotLocked(old)
		w.setSlotLocked(owner, nil)
	}
	if root == "" {
		w.mu.Unlock()
		return nil
	}
	info, err := os.Stat(root)
	if err != nil {
		w.mu.Unlock()
		return err
	}
	if !info.IsDir() {
		w.mu.Unlock()
		return fmt.Errorf("不是目录：%s", root)
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	w.setSlotLocked(owner, &watchSlot{root: root, stop: stop, done: done})
	w.mu.Unlock()
	logf("info", "文件监听：%s（owner=%s）", root, owner)
	go func() {
		defer close(done)
		err := watchDirectory(root, stop, func(events []watchEvent, overflow bool) {
			filtered := make([]string, 0, len(events))
			removed := make([]string, 0, len(events))
			present := make([]string, 0, len(events))
			// present 同批去重：构建写盘时同一个文件会连着来好几条 MODIFIED，
			// 前端只关心「这一批里它出现过」，重复项纯属载荷浪费（一次 build 能省一半）。
			seenPresent := make(map[string]struct{}, len(events))
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
				} else {
					// 「出现/修改」单独成组同样给 wipe-guard：删除后同路径又出现的
					// （删目录再复制、temp→rename 落盘）属于替换不是消失，前端据此抵消。
					if _, dup := seenPresent[e.Path]; dup {
						continue
					}
					seenPresent[e.Path] = struct{}{}
					present = append(present, e.Path)
				}
			}
			if overflow || len(filtered) > 0 {
				// 应用自身的批量目录操作期间清空两个判定分组：这些增删由应用主动发起
				// （插件整目录替换 / 卸载），不是工作区破坏。paths 照常推送。
				if quietActive() {
					removed = removed[:0]
					present = present[:0]
				}
				emit("workspace-changed", map[string]interface{}{
					"root":     root,
					"paths":    filtered,
					"removed":  removed,
					"present":  present,
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

// UnwatchWorkspaceFor 停掉指定归属者的工作区监听。
func (w *Watcher) UnwatchWorkspaceFor(owner string) {
	owner = strings.TrimSpace(owner)
	w.mu.Lock()
	old := w.slotLocked(owner)
	w.setSlotLocked(owner, nil)
	w.mu.Unlock()
	stopSlotLocked(old)
}

// UnwatchAll 停掉全部监听槽（应用退出收口用）。
func (w *Watcher) UnwatchAll() {
	w.mu.Lock()
	slots := make([]*watchSlot, 0, len(w.slots))
	for _, s := range w.slots {
		slots = append(slots, s)
	}
	w.slots = map[string]*watchSlot{}
	w.mu.Unlock()
	for _, s := range slots {
		stopSlotLocked(s)
	}
}
