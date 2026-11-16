package aitransport

// AI 流式增量合并：把思考/正文增量按时间窗合并后再发事件（toolcall/done/error 不过窗）。
// 批处理器结构体在 types.go（aiChunkBatcher）。

import (
	"time"
)

func newAIChunkBatcher(id string, emit Emitter) *aiChunkBatcher {
	return &aiChunkBatcher{id: id, emit: emit}
}

func (b *aiChunkBatcher) add(event, delta string) {
	if delta == "" {
		return
	}
	b.mu.Lock()
	if event == EventThink {
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
		b.emit(EventThink, ChunkPayload{Id: b.id, Delta: think})
	}
	if content != "" {
		b.emit(EventChunk, ChunkPayload{Id: b.id, Delta: content})
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

// ProviderKind 是一家服务商的协议形状；同一 BaseURL 下按协议分别构造与解码。
type ProviderKind int

const (
	ProviderOpenAI ProviderKind = iota
	ProviderAnthropic
	// OpenAI Responses API（/v1/responses）：input/tools/SSE 事件形状都与
	// chat/completions 不同，单独一套构造与解码，见 aiBuildResponsesBody /
	// streamResponsesSSE。认证仍走 Bearer，与 OpenAI 兼容端点一致。
	ProviderResponses
)
