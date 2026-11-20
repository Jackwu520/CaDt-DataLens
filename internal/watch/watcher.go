// Package watch 工作区文件监听（Windows 读目录变化通知，其余平台报不支持）。
package watch

import (
	"sync"
	"time"
)

// watchSlot 单个归属者的监听槽（root + 停止通道）。
type watchSlot struct {
	root string
	stop chan struct{}
	done chan struct{}
}

// Watcher 文件监听器：按归属者（v3 = 调用方窗口名）键控多槽。
// v2 一窗一进程时单槽即够；v3 一进程多窗口后两个窗口各自监听自己的工作区，
// 后开窗口不得顶掉先开窗口的槽位（否则先开窗口的自动刷新失效、wipe-guard L2
// 对它的工作区静默失明——2026-11-21 审查第 1 项）。
type Watcher struct {
	mu    sync.Mutex
	slots map[string]*watchSlot
}

func (w *Watcher) slotLocked(owner string) *watchSlot {
	if w.slots == nil {
		w.slots = map[string]*watchSlot{}
	}
	return w.slots[owner]
}

func (w *Watcher) setSlotLocked(owner string, slot *watchSlot) {
	if w.slots == nil {
		w.slots = map[string]*watchSlot{}
	}
	if slot == nil {
		delete(w.slots, owner)
		return
	}
	w.slots[owner] = slot
}

// stopSlotLocked 停掉一个槽并等 goroutine 退出（最多 2s）。
func stopSlotLocked(slot *watchSlot) {
	if slot == nil || slot.stop == nil {
		return
	}
	close(slot.stop)
	slot.stop = nil
	if slot.done != nil {
		select {
		case <-slot.done:
		case <-time.After(2 * time.Second):
		}
	}
}

// 宿主注入（main 的 startup 接线）。
var (
	// Emit 前端事件推送（main 在 startup 注入 Wails EventsEmit）。
	Emit func(event string, data any)
	// Logf 诊断日志（main/logging.go 的 writeAppLog）。
	Logf func(level, format string, args ...any)
)

func emit(event string, data any) {
	if Emit != nil {
		Emit(event, data)
	}
}

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}
