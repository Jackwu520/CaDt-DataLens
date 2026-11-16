package aichat

// AI 流注册表：按 sessionId 记录取消句柄与空闲看门狗（Wails 绑定 AISendChat /
// AIStop / AITouchStream 的宿主状态）。协议构造与 SSE 解码在 internal/aitransport。

import (
	"context"
	"sync"
	"time"
)

type aiStreamEntry struct {
	cancel   context.CancelCauseFunc
	watchdog *time.Timer
}

var aiStreams = struct {
	sync.Mutex
	entries map[string]*aiStreamEntry
}{entries: make(map[string]*aiStreamEntry)}

// AttachWatchdog 把空闲看门狗挂到会话的流条目上（transport 在流开始时回调）。
func AttachWatchdog(id string, watchdog *time.Timer) {
	aiStreams.Lock()
	if entry := aiStreams.entries[id]; entry != nil {
		entry.watchdog = watchdog
	}
	aiStreams.Unlock()
}
