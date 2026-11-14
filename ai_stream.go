package main

// AI 流式增量合并：把思考/正文增量按时间窗合并后再发事件（toolcall/done/error 不过窗）。
// 从 ai.go 拆出（同包）。

import (
	"context"
	"sync"
	"time"
)


func newAIChunkBatcher(id string, emit aiEmitter) *aiChunkBatcher {
	return &aiChunkBatcher{id: id, emit: emit}
}

func (b *aiChunkBatcher) add(event, delta string) {
	if delta == "" {
		return
	}
	b.mu.Lock()
	if event == aiEventThink {
		b.think.WriteString(delta)
	} else {
		b.content.WriteString(delta)
	}
	if b.timer == nil {
		b.timer = time.AfterFunc(aiChunkBatchWindow, b.flush)
	}
	b.mu.Unlock()
}

// flush 取出窗口内缓冲并按 think→content 顺序发出（由 AfterFunc 或 flushNow 调用）。
func (b *aiChunkBatcher) flush() {
	b.mu.Lock()
	think := b.think.String()
	content := b.content.String()
	b.think.Reset()
	b.content.Reset()
	b.timer = nil
	b.mu.Unlock()
	if think != "" {
		b.emit(aiEventThink, aiChunkPayload{Id: b.id, Delta: think})
	}
	if content != "" {
		b.emit(aiEventChunk, aiChunkPayload{Id: b.id, Delta: content})
	}
}

// flushNow 流结束前同步清空缓冲，done/error 随后发出，保证内容完整先于终态。
func (b *aiChunkBatcher) flushNow() {
	b.mu.Lock()
	if b.timer != nil {
		b.timer.Stop()
		b.timer = nil
	}
	b.mu.Unlock()
	b.flush()
}

type aiStreamEntry struct {
	cancel   context.CancelCauseFunc
	watchdog *time.Timer
}

var aiStreams = struct {
	sync.Mutex
	entries map[string]*aiStreamEntry
}{entries: make(map[string]*aiStreamEntry)}

type aiProviderKind int

const (
	aiProviderOpenAI aiProviderKind = iota
	aiProviderAnthropic
)

// AISendChat 启动一轮流式对话。立即返回后由 goroutine 通过 ai-* 事件推送：
// ai-chunk / ai-think / ai-toolcall / ai-done / ai-error。同一 sessionId 的新请求
// 会先取消旧请求；AIStop 按 sessionId 前缀取消（前端传 session.id#round）。
