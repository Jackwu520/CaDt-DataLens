package main

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"
)

// AI 面板的 Go 侧只做两件事：双协议 HTTP + SSE 流式转发（事件归一化），
// 以及记忆/技能目录解析。Agent 编排、审批、diff 全在前端。
const (
	aiIdleTimeout         = 120 * time.Second
	aiDialTimeout         = 10 * time.Second
	aiErrorBodyLimit      = 64 << 10
	aiErrorTextLimit      = 500
	aiDefaultMaxTokens    = 4096
	aiMaxExtraHeaders     = 8
	// 插件 provider 每轮注入的请求体补丁上限（与前端 plugin-ai-providers.js 对齐）
	aiMaxExtraBodyKeys    = 32
	aiMaxExtraBodyBytes   = 64 << 10
	aiMaxToolDefs         = 128
	aiMaxModels           = 500
	aiMaxImagesPerMessage = 6
	aiMaxImageBase64      = 8 << 20
	// aiChunkBatchWindow 合并 ai-think/ai-chunk 的时间窗：DeepSeek reasoning 每秒可达
	// 上百个小块，逐块 EventsEmit 会造成 WebView2 IPC 洪泛、渲染进程主线程被压到流
	// 结束才消化完（思考内容表现为「全部输出完才出现」）。窗口内的同类文本合并一次发出。
	aiChunkBatchWindow = 30 * time.Millisecond
)

const (
	aiEventChunk    = "ai-chunk"
	aiEventThink    = "ai-think"
	aiEventToolCall = "ai-toolcall"
	aiEventDone     = "ai-done"
	aiEventError    = "ai-error"
	aiEventRetry    = "ai-retry"
	// 服务端参数校验给出的上限（如 max_tokens 超模型上限）被自动收敛时通知前端，
	// 由前端提示用户并把该模型条目的输出窗口回写到配置。
	aiEventParamAdjust = "ai-param-adjust"
)

var (
	errAIIdleTimeout = errors.New("AI 响应超时（120 秒无数据）")
	errAnthropicDone = errors.New("anthropic stream done")
	aiToolNameRule   = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// AIConfig 由前端 Profile 组装；API Key 只存在于前端 localStorage 与请求头，
// 不写入日志、不落盘。
type AIConfig struct {
	Provider       string            `json:"provider"`
	BaseURL        string            `json:"baseURL"`
	APIKey         string            `json:"apiKey"`
	Model          string            `json:"model"`
	Temperature    float64           `json:"temperature"`
	MaxTokens      int               `json:"maxTokens"`
	Proxy          string            `json:"proxy,omitempty"`
	ExtraHeaders   map[string]string `json:"extraHeaders,omitempty"`
	// ExtraBody 是插件 provider 每轮注入的请求体补丁；stream 由 aiApplyBodyPatch 强制保持 true，
	// 否则 SSE 解码会拿不到流。字段上限与合法性在 validateAIEndpoint 里校验。
	ExtraBody      map[string]any    `json:"extraBody,omitempty"`
	Thinking       bool              `json:"thinking,omitempty"`
	ThinkingBudget int               `json:"thinkingBudget,omitempty"`
	// ReasoningEffort 仅用于 OpenAI 兼容协议，按 reasoning_effort 原样发送。
	ReasoningEffort string `json:"reasoningEffort,omitempty"`
}

// AIMessage 是前端与 Go 之间的会话消息（规范化中间格式）。
// assistant 的 ToolCalls 为工具调用请求，role=tool 的消息用 ToolCallId 回填结果。
type AIMessage struct {
	Role              string        `json:"role"`
	Content           string        `json:"content,omitempty"`
	Images            []AIImagePart `json:"images,omitempty"`
	ToolCalls         []AIToolCall  `json:"toolCalls,omitempty"`
	ToolCallId        string        `json:"toolCallId,omitempty"`
	Name              string        `json:"name,omitempty"`
	Thinking          string        `json:"thinking,omitempty"`
	ThinkingSignature string        `json:"thinkingSignature,omitempty"`
}

type AIImagePart struct {
	Mime string `json:"mime"`
	Data string `json:"data"`
}

type AIToolCall struct {
	Id        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type AIToolDef struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type aiChunkPayload struct {
	Id    string `json:"id"`
	Delta string `json:"delta"`
}

type aiToolCallPayload struct {
	Id        string `json:"id"`
	Index     int    `json:"index"`
	CallId    string `json:"callId,omitempty"`
	Name      string `json:"name,omitempty"`
	ArgsDelta string `json:"argsDelta,omitempty"`
}

type aiUsage struct {
	PromptTokens     int `json:"promptTokens,omitempty"`
	CompletionTokens int `json:"completionTokens,omitempty"`
	TotalTokens      int `json:"totalTokens,omitempty"`
	CachedTokens     int `json:"cachedTokens,omitempty"`
	// CacheWriteTokens 只对 Anthropic 有值（cache_creation_input_tokens）：写进提示缓存的量，
	// 与「缓存读取」分开统计，前端每轮用量浮层会单独列一行。
	CacheWriteTokens int `json:"cacheWriteTokens,omitempty"`
}

type aiDonePayload struct {
	Id                string   `json:"id"`
	FinishReason      string   `json:"finishReason"`
	ThinkingSignature string   `json:"thinkingSignature,omitempty"`
	Usage             *aiUsage `json:"usage,omitempty"`
}

type aiErrorPayload struct {
	Id      string `json:"id"`
	Message string `json:"message"`
}

type aiRetryPayload struct {
	Id      string `json:"id"`
	Attempt int    `json:"attempt"`
	Max     int    `json:"max"`
	DelayMs int    `json:"delayMs"`
	Reason  string `json:"reason"`
}

// aiParamAdjustPayload：一次请求内因服务端参数上限而自动降档的通知。
// Previous/Value 都是 max_tokens 的 token 数；前端按 Value 回写模型条目的 outputWindow。
type aiParamAdjustPayload struct {
	Id       string `json:"id"`
	Model    string `json:"model"`
	Field    string `json:"field"`
	Previous int    `json:"previous"`
	Value    int    `json:"value"`
	Message  string `json:"message"`
}

type aiEmitter func(event string, payload any)

// aiChunkBatcher 按时间窗合并思考/正文增量。toolcall/done/error 不经批处理，
// 终端事件发出前先同步 flush，保证前端收到 done 时内容已完整。
type aiChunkBatcher struct {
	mu      sync.Mutex
	id      string
	think   strings.Builder
	content strings.Builder
	timer   *time.Timer
	emit    aiEmitter
}
