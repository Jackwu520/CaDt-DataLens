package aitransport

// 传输引擎测试：从根目录 ai_test.go 拆出（随包迁移）。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type aiEventRecord struct {
	Name    string
	Payload any
}

type aiCapturedRequest struct {
	Path             string
	Authorization    string
	APIKey           string
	AnthropicVersion string
	Body             map[string]any
}

func runAIStreamForTest(cfg Config, messages []Message, tools []ToolDef) ([]aiEventRecord, error) {
	return runAIStreamForTestRetry(cfg, messages, tools, 0)
}

func runAIStreamForTestRetry(cfg Config, messages []Message, tools []ToolDef, retryMax int) ([]aiEventRecord, error) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(context.Canceled)
	var events []aiEventRecord
	emit := func(name string, payload any) {
		events = append(events, aiEventRecord{Name: name, Payload: payload})
	}
	err := StreamResponse(ctx, cancel, "sess#0", cfg, messages, tools, emit, retryMax)
	return events, err
}

func aiEventsNamed(events []aiEventRecord, name string) []any {
	var out []any
	for _, event := range events {
		if event.Name == name {
			out = append(out, event.Payload)
		}
	}
	return out
}

func aiJoinedDelta(events []aiEventRecord, name string) string {
	var builder strings.Builder
	for _, event := range events {
		if event.Name != name {
			continue
		}
		if payload, ok := event.Payload.(ChunkPayload); ok {
			builder.WriteString(payload.Delta)
		}
	}
	return builder.String()
}

func writeSSEJSON(w http.ResponseWriter, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
}

func writeAnthropicSSE(w http.ResponseWriter, event string, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}

func TestAIStreamOpenAI(t *testing.T) {
	requestCh := make(chan aiCapturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			body = map[string]any{"decodeError": err.Error()}
		}
		requestCh <- aiCapturedRequest{
			Path:          r.URL.Path,
			Authorization: r.Header.Get("Authorization"),
			Body:          body,
		}
		w.Header().Set("Content-Type", "text/event-stream")
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"reasoning_content": "先想"},
			"finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"content": "你好"},
			"finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta": map[string]any{"tool_calls": []any{map[string]any{
				"index": 0, "id": "call_1", "type": "function",
				"function": map[string]any{"name": "read_file", "arguments": `{"path":`},
			}}},
			"finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta": map[string]any{"tool_calls": []any{map[string]any{
				"index":    0,
				"function": map[string]any{"arguments": `"a.txt"}`},
			}}},
			"finish_reason": "tool_calls",
		}}})
		writeSSEJSON(w, map[string]any{
			"choices": []any{},
			"usage": map[string]any{
				"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
				"prompt_cache_hit_tokens": 6,
			},
		})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	cfg := Config{
		Provider: "openai", BaseURL: server.URL + "/v1", APIKey: "test-key",
		Model: "test-model", Temperature: 0.2, MaxTokens: 100, Proxy: "direct",
	}
	tools := []ToolDef{{
		Name: "read_file", Description: "读取文件",
		Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`),
	}}
	messages := []Message{{Role: "system", Content: "be brief"}, {Role: "user", Content: "hi"}}

	events, err := runAIStreamForTest(cfg, messages, tools)
	if err != nil {
		t.Fatalf("StreamResponse: %v", err)
	}

	captured := <-requestCh
	if captured.Path != "/v1/chat/completions" {
		t.Fatalf("path = %s", captured.Path)
	}
	if captured.Authorization != "Bearer test-key" {
		t.Fatalf("authorization = %q", captured.Authorization)
	}
	if captured.Body["model"] != "test-model" || captured.Body["stream"] != true {
		t.Fatalf("body = %#v", captured.Body)
	}
	msgs, _ := captured.Body["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages len = %d", len(msgs))
	}
	toolList, _ := captured.Body["tools"].([]any)
	if len(toolList) != 1 {
		t.Fatalf("tools len = %d", len(toolList))
	}

	if got := aiJoinedDelta(events, EventThink); got != "先想" {
		t.Fatalf("think = %q", got)
	}
	if got := aiJoinedDelta(events, EventChunk); got != "你好" {
		t.Fatalf("chunk = %q", got)
	}
	calls := aiEventsNamed(events, EventToolCall)
	if len(calls) != 2 {
		t.Fatalf("toolcall count = %d", len(calls))
	}
	first := calls[0].(ToolCallPayload)
	if first.Id != "sess#0" || first.CallId != "call_1" || first.Name != "read_file" || first.ArgsDelta != `{"path":` {
		t.Fatalf("first call = %#v", first)
	}
	second := calls[1].(ToolCallPayload)
	if second.ArgsDelta != `"a.txt"}` {
		t.Fatalf("second args = %q", second.ArgsDelta)
	}
	done := aiEventsNamed(events, EventDone)
	if len(done) != 1 {
		t.Fatalf("done count = %d", len(done))
	}
	donePayload := done[0].(DonePayload)
	if donePayload.Id != "sess#0" || donePayload.FinishReason != "tool" {
		t.Fatalf("done = %#v", donePayload)
	}
	if donePayload.Usage == nil || donePayload.Usage.TotalTokens != 15 || donePayload.Usage.PromptTokens != 10 || donePayload.Usage.CachedTokens != 6 {
		t.Fatalf("usage = %#v", donePayload.Usage)
	}
}

func TestAIStreamAnthropic(t *testing.T) {
	requestCh := make(chan aiCapturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			body = map[string]any{"decodeError": err.Error()}
		}
		requestCh <- aiCapturedRequest{
			Path:             r.URL.Path,
			APIKey:           r.Header.Get("x-api-key"),
			AnthropicVersion: r.Header.Get("anthropic-version"),
			Body:             body,
		}
		w.Header().Set("Content-Type", "text/event-stream")
		writeAnthropicSSE(w, "message_start", map[string]any{
			"type": "message_start", "message": map[string]any{"usage": map[string]any{
				"input_tokens": 12, "cache_read_input_tokens": 4, "cache_creation_input_tokens": 2,
			}},
		})
		writeAnthropicSSE(w, "content_block_start", map[string]any{
			"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "thinking", "thinking": ""},
		})
		writeAnthropicSSE(w, "content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "thinking_delta", "thinking": "思考中"},
		})
		writeAnthropicSSE(w, "content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "signature_delta", "signature": "sig-abc"},
		})
		writeAnthropicSSE(w, "content_block_start", map[string]any{
			"type": "content_block_start", "index": 1,
			"content_block": map[string]any{"type": "text", "text": ""},
		})
		writeAnthropicSSE(w, "content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 1,
			"delta": map[string]any{"type": "text_delta", "text": "答复"},
		})
		writeAnthropicSSE(w, "content_block_start", map[string]any{
			"type": "content_block_start", "index": 2,
			"content_block": map[string]any{"type": "tool_use", "id": "toolu_1", "name": "read_file"},
		})
		writeAnthropicSSE(w, "content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 2,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": `{"path":"a"}`},
		})
		writeAnthropicSSE(w, "message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": "tool_use"},
			"usage": map[string]any{"output_tokens": 7},
		})
		writeAnthropicSSE(w, "message_stop", map[string]any{"type": "message_stop"})
	}))
	defer server.Close()

	cfg := Config{
		Provider: "anthropic", BaseURL: server.URL, APIKey: "test-key",
		Model: "claude-test", Temperature: 0.1, MaxTokens: 16000,
		Thinking: true, ThinkingBudget: 8000, Proxy: "direct",
		ExtraHeaders: map[string]string{"X-Tenant": "demo"},
	}
	tools := []ToolDef{{
		Name: "read_file", Description: "读取文件",
		Parameters: json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}}}`),
	}}
	messages := []Message{{Role: "system", Content: "sys"}, {Role: "user", Content: "hi"}}

	events, err := runAIStreamForTest(cfg, messages, tools)
	if err != nil {
		t.Fatalf("StreamResponse: %v", err)
	}

	captured := <-requestCh
	if captured.Path != "/v1/messages" {
		t.Fatalf("path = %s", captured.Path)
	}
	if captured.APIKey != "test-key" || captured.AnthropicVersion != "2023-06-01" {
		t.Fatalf("headers = %#v", captured)
	}
	if captured.Body["system"] != "sys" {
		t.Fatalf("system = %#v", captured.Body["system"])
	}
	if captured.Body["max_tokens"] != float64(16000) || captured.Body["stream"] != true {
		t.Fatalf("body = %#v", captured.Body)
	}
	thinking, _ := captured.Body["thinking"].(map[string]any)
	if thinking["type"] != "enabled" || thinking["budget_tokens"] != float64(8000) {
		t.Fatalf("thinking = %#v", thinking)
	}
	toolList, _ := captured.Body["tools"].([]any)
	if len(toolList) != 1 {
		t.Fatalf("tools len = %d", len(toolList))
	}
	tool := toolList[0].(map[string]any)
	if tool["name"] != "read_file" || tool["input_schema"] == nil {
		t.Fatalf("tool = %#v", tool)
	}

	if got := aiJoinedDelta(events, EventThink); got != "思考中" {
		t.Fatalf("think = %q", got)
	}
	if got := aiJoinedDelta(events, EventChunk); got != "答复" {
		t.Fatalf("chunk = %q", got)
	}
	calls := aiEventsNamed(events, EventToolCall)
	if len(calls) != 2 {
		t.Fatalf("toolcall count = %d", len(calls))
	}
	start := calls[0].(ToolCallPayload)
	if start.CallId != "toolu_1" || start.Name != "read_file" || start.ArgsDelta != "" {
		t.Fatalf("tool start = %#v", start)
	}
	args := calls[1].(ToolCallPayload)
	if args.ArgsDelta != `{"path":"a"}` || args.CallId != "" || args.Name != "" {
		t.Fatalf("tool args = %#v", args)
	}
	done := aiEventsNamed(events, EventDone)
	if len(done) != 1 {
		t.Fatalf("done count = %d", len(done))
	}
	donePayload := done[0].(DonePayload)
	if donePayload.FinishReason != "tool" || donePayload.ThinkingSignature != "sig-abc" {
		t.Fatalf("done = %#v", donePayload)
	}
	if donePayload.Usage == nil || donePayload.Usage.PromptTokens != 18 || donePayload.Usage.CachedTokens != 4 ||
		donePayload.Usage.CacheWriteTokens != 2 ||
		donePayload.Usage.CompletionTokens != 7 || donePayload.Usage.TotalTokens != 25 {
		t.Fatalf("usage = %#v", donePayload.Usage)
	}
}

func TestAIAnthropicMessages(t *testing.T) {
	messages := []Message{
		{Role: "system", Content: "A"},
		{Role: "system", Content: "B"},
		{Role: "user", Content: "q"},
		{Role: "assistant", Content: "answer", Thinking: "think", ThinkingSignature: "sig",
			ToolCalls: []ToolCall{{Id: "c1", Name: "read_file", Arguments: `{"path":"x"}`}}},
		{Role: "tool", ToolCallId: "c1", Content: "body"},
		{Role: "tool", ToolCallId: "c2", Content: "body2"},
	}
	system, out, err := aiAnthropicMessages(messages, true)
	if err != nil {
		t.Fatalf("aiAnthropicMessages: %v", err)
	}
	if system != "A\n\nB" {
		t.Fatalf("system = %q", system)
	}
	if len(out) != 3 {
		t.Fatalf("turns = %d", len(out))
	}

	assistant := out[1]
	blocks := assistant["content"].([]any)
	if len(blocks) != 3 {
		t.Fatalf("assistant blocks = %d", len(blocks))
	}
	thinkingBlock := blocks[0].(map[string]any)
	if thinkingBlock["type"] != "thinking" || thinkingBlock["signature"] != "sig" || thinkingBlock["thinking"] != "think" {
		t.Fatalf("thinking block = %#v", thinkingBlock)
	}
	textBlock := blocks[1].(map[string]any)
	if textBlock["type"] != "text" || textBlock["text"] != "answer" {
		t.Fatalf("text block = %#v", textBlock)
	}
	useBlock := blocks[2].(map[string]any)
	useInput := useBlock["input"].(map[string]any)
	if useBlock["type"] != "tool_use" || useBlock["id"] != "c1" || useBlock["name"] != "read_file" || useInput["path"] != "x" {
		t.Fatalf("tool_use block = %#v", useBlock)
	}

	toolTurn := out[2]
	toolBlocks := toolTurn["content"].([]any)
	if len(toolBlocks) != 2 {
		t.Fatalf("tool_result blocks = %d", len(toolBlocks))
	}
	for i, raw := range toolBlocks {
		block := raw.(map[string]any)
		if block["type"] != "tool_result" {
			t.Fatalf("block %d = %#v", i, block)
		}
	}
	if toolBlocks[0].(map[string]any)["tool_use_id"] != "c1" || toolBlocks[1].(map[string]any)["tool_use_id"] != "c2" {
		t.Fatalf("tool ids = %#v", toolBlocks)
	}
}

func TestAIAnthropicThinkingNeedsSignature(t *testing.T) {
	_, out, err := aiAnthropicMessages([]Message{
		{Role: "user", Content: "q"},
		{Role: "assistant", Content: "answer", Thinking: "think"},
	}, true)
	if err != nil {
		t.Fatalf("aiAnthropicMessages: %v", err)
	}
	blocks := out[1]["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("thinking without signature should be omitted, blocks = %#v", blocks)
	}
	if blocks[0].(map[string]any)["type"] != "text" {
		t.Fatalf("blocks = %#v", blocks)
	}
}

func TestAIAnthropicThinkingOmittedWhenDisabled(t *testing.T) {
	_, out, err := aiAnthropicMessages([]Message{
		{Role: "user", Content: "q"},
		{Role: "assistant", Content: "answer", Thinking: "think", ThinkingSignature: "sig"},
	}, false)
	if err != nil {
		t.Fatalf("aiAnthropicMessages: %v", err)
	}
	blocks := out[1]["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("thinking should be omitted when disabled, blocks = %#v", blocks)
	}
	if blocks[0].(map[string]any)["type"] != "text" {
		t.Fatalf("blocks = %#v", blocks)
	}
}

func TestAIAnthropicBodyThinkingOmitsTemperature(t *testing.T) {
	cfg := Config{
		Provider:       "anthropic",
		Model:          "claude-sonnet-4-5",
		Temperature:    0.7,
		MaxTokens:      16000,
		Thinking:       true,
		ThinkingBudget: 8000,
	}
	body, err := aiBuildAnthropicBody(cfg, []Message{{Role: "user", Content: "q"}}, nil)
	if err != nil {
		t.Fatalf("aiBuildAnthropicBody: %v", err)
	}
	if _, ok := body["temperature"]; ok {
		t.Fatalf("temperature should be omitted when thinking enabled: %#v", body)
	}
	thinking, ok := body["thinking"].(map[string]any)
	if !ok || thinking["type"] != "enabled" || thinking["budget_tokens"] != 8000 {
		t.Fatalf("thinking = %#v", body["thinking"])
	}

	cfg.Thinking = false
	body, err = aiBuildAnthropicBody(cfg, []Message{{Role: "user", Content: "q"}}, nil)
	if err != nil {
		t.Fatalf("aiBuildAnthropicBody: %v", err)
	}
	if body["temperature"] != 0.7 {
		t.Fatalf("temperature = %#v", body["temperature"])
	}
	if _, ok := body["thinking"]; ok {
		t.Fatalf("thinking should be absent: %#v", body)
	}
}

func TestClaudeRejectsFixedThinkingBudget(t *testing.T) {
	cases := map[string]bool{
		"claude-opus-5-5":            true,
		"claude-sonnet-5-5":          true,
		"claude-haiku-5-5":           true,
		"claude-fable-5-2":           true,
		"claude-sonnet-4-6":          true,
		"claude-opus-4-8":            true,
		"claude-sonnet-4-5":          false,
		"claude-sonnet-4-5-20250929": false,
		"claude-haiku-4-5":           false,
		"claude-3-5-sonnet":          false, // 数字在前的老命名，不在新规则内
		"deepseek-flash":             false, // 走 Anthropic 格式的第三方模型保持固定预算
		"deepseek-v4-pro":            false,
		"":                           false,
	}
	for model, want := range cases {
		if got := claudeRejectsFixedThinkingBudget(model); got != want {
			t.Fatalf("claudeRejectsFixedThinkingBudget(%q) = %v, want %v", model, got, want)
		}
	}
}

func TestAIAnthropicBodyAdaptiveThinkingForNewFamilies(t *testing.T) {
	cfg := Config{
		Provider:       "anthropic",
		Model:          "claude-sonnet-5-5",
		Temperature:    0.7,
		MaxTokens:      16000,
		Thinking:       true,
		ThinkingBudget: 8000,
	}
	body, err := aiBuildAnthropicBody(cfg, []Message{{Role: "user", Content: "q"}}, nil)
	if err != nil {
		t.Fatalf("aiBuildAnthropicBody: %v", err)
	}
	thinking, ok := body["thinking"].(map[string]any)
	if !ok || thinking["type"] != "adaptive" {
		t.Fatalf("新家族应使用自适应思考：%#v", body["thinking"])
	}
	if _, bad := thinking["budget_tokens"]; bad {
		t.Fatalf("新家族不接受固定预算：%#v", thinking)
	}
	if _, ok := body["temperature"]; ok {
		t.Fatalf("开启思考时不应带 temperature：%#v", body)
	}
}

func TestAIOpenAIBodyReasoningEffort(t *testing.T) {
	cfg := Config{Provider: "openai", Model: "deepseek-flash", Temperature: 0.2, MaxTokens: 100, ReasoningEffort: "high"}
	body, err := aiBuildOpenAIBody(cfg, []Message{{Role: "user", Content: "q"}}, nil)
	if err != nil {
		t.Fatalf("aiBuildOpenAIBody: %v", err)
	}
	if body["reasoning_effort"] != "high" {
		t.Fatalf("reasoning_effort = %#v", body["reasoning_effort"])
	}

	cfg.ReasoningEffort = ""
	body, err = aiBuildOpenAIBody(cfg, []Message{{Role: "user", Content: "q"}}, nil)
	if err != nil {
		t.Fatalf("aiBuildOpenAIBody: %v", err)
	}
	if _, ok := body["reasoning_effort"]; ok {
		t.Fatalf("reasoning_effort should be omitted: %#v", body)
	}
}

func TestAIOpenAIMessages(t *testing.T) {
	out, err := aiOpenAIMessages([]Message{
		{Role: "system", Content: "sys"},
		{Role: "user", Content: "q"},
		{Role: "assistant", Content: "", ToolCalls: []ToolCall{
			{Id: "call_1", Name: "read_file", Arguments: `{"path":"a"}`},
		}},
		{Role: "tool", ToolCallId: "call_1", Content: "body"},
	}, true)
	if err != nil {
		t.Fatalf("aiOpenAIMessages: %v", err)
	}
	if len(out) != 4 {
		t.Fatalf("messages = %d", len(out))
	}
	assistant := out[2]
	if assistant["content"] != nil {
		t.Fatalf("assistant content = %#v", assistant["content"])
	}
	calls := assistant["tool_calls"].([]map[string]any)
	function := calls[0]["function"].(map[string]any)
	if calls[0]["id"] != "call_1" || function["name"] != "read_file" || function["arguments"] != `{"path":"a"}` {
		t.Fatalf("call = %#v", calls[0])
	}
	// deepseek 思考模型逐条校验：passReasoning=true 时 assistant 必须带
	// reasoning_content 字段，空串也必须写（缺失即网关 400，d5ad6ac）。
	if v, ok := assistant["reasoning_content"]; !ok || v != "" {
		t.Fatalf("assistant reasoning_content = %#v（应为空串字段）", v)
	}
	if out[3]["tool_call_id"] != "call_1" || out[3]["content"] != "body" {
		t.Fatalf("tool msg = %#v", out[3])
	}
}

func TestAIAnthropicUserImages(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("fake-png"))
	_, out, err := aiAnthropicMessages([]Message{{
		Role:    "user",
		Content: "",
		Images:  []ImagePart{{Mime: "image/png", Data: data}},
	}}, false)
	if err != nil {
		t.Fatalf("aiAnthropicMessages: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("turns = %d", len(out))
	}
	blocks := out[0]["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("blocks = %#v", blocks)
	}
	image := blocks[0].(map[string]any)
	source := image["source"].(map[string]any)
	if image["type"] != "image" || source["type"] != "base64" || source["media_type"] != "image/png" || source["data"] != data {
		t.Fatalf("image block = %#v", image)
	}
}

func TestAIOpenAIUserImages(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("fake-jpeg"))
	out, err := aiOpenAIMessages([]Message{{
		Role:    "user",
		Content: "看看这张图",
		Images:  []ImagePart{{Mime: "image/jpeg", Data: data}},
	}}, false)
	if err != nil {
		t.Fatalf("aiOpenAIMessages: %v", err)
	}
	parts := out[0]["content"].([]any)
	if len(parts) != 2 {
		t.Fatalf("parts = %#v", parts)
	}
	text := parts[0].(map[string]any)
	if text["type"] != "text" || text["text"] != "看看这张图" {
		t.Fatalf("text part = %#v", text)
	}
	image := parts[1].(map[string]any)
	imageURL := image["image_url"].(map[string]any)
	if image["type"] != "image_url" || imageURL["url"] != "data:image/jpeg;base64,"+data {
		t.Fatalf("image part = %#v", image)
	}
}

func TestAIMessageImageValidation(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte("img"))
	err := ValidateMessages([]Message{{Role: "assistant", Images: []ImagePart{{Mime: "image/png", Data: data}}}})
	if err == nil || !strings.Contains(err.Error(), "用户消息") {
		t.Fatalf("assistant image error = %v", err)
	}
	err = ValidateMessages([]Message{{Role: "user", Images: []ImagePart{{Mime: "image/bmp", Data: data}}}})
	if err == nil || !strings.Contains(err.Error(), "不支持") {
		t.Fatalf("bad mime error = %v", err)
	}
	err = ValidateMessages([]Message{{Role: "user", Images: []ImagePart{{Mime: "image/png", Data: "not base64!!"}}}})
	if err == nil || !strings.Contains(err.Error(), "base64") {
		t.Fatalf("bad data error = %v", err)
	}
}

func TestSanitizeAIMessagesToolArguments(t *testing.T) {
	messages := []Message{
		{Role: "assistant", ToolCalls: []ToolCall{
			{Id: "a", Name: "ask_user", Arguments: `{"questions": []}}`},
			{Id: "b", Name: "read_file", Arguments: `{"path":"x.txt"}`},
			{Id: "c", Name: "todo_write", Arguments: "  "},
			{Id: "d", Name: "run_command", Arguments: `{"command":`},
		}},
	}
	if fixed := SanitizeMessages(messages); fixed != 2 {
		t.Fatalf("应兜底替换 2 个非法参数，实际 %d", fixed)
	}
	calls := messages[0].ToolCalls
	if calls[0].Arguments != "{}" || calls[3].Arguments != "{}" {
		t.Fatalf("非法参数未收敛为 {}: %#v", calls)
	}
	if calls[1].Arguments != `{"path":"x.txt"}` {
		t.Fatalf("合法参数被改写: %q", calls[1].Arguments)
	}
	if strings.TrimSpace(calls[2].Arguments) != "" {
		t.Fatalf("空参数不应改写: %q", calls[2].Arguments)
	}
	if err := ValidateMessages(messages); err != nil {
		t.Fatalf("兜底后校验仍失败: %v", err)
	}
}

func TestAIStreamHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprint(w, `{"error":{"message":"invalid key"}}`)
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", APIKey: "bad", Model: "m", Proxy: "direct"}
	events, err := runAIStreamForTest(cfg, []Message{{Role: "user", Content: "hi"}}, nil)
	if err == nil {
		t.Fatalf("expected error, events = %#v", events)
	}
	if !strings.Contains(err.Error(), "HTTP 401") || !strings.Contains(err.Error(), "invalid key") {
		t.Fatalf("error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %#v", events)
	}
}

func TestAIStreamNonSSE(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"choices":[{"message":{"content":"nope"}}]}`)
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", Model: "m", Proxy: "direct"}
	_, err := runAIStreamForTest(cfg, []Message{{Role: "user", Content: "hi"}}, nil)
	if err == nil || !strings.Contains(err.Error(), "SSE") {
		t.Fatalf("error = %v", err)
	}
}

func TestAIStreamMalformedChunk(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {not json}\n\n")
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", Model: "m", Proxy: "direct"}
	_, err := runAIStreamForTest(cfg, []Message{{Role: "user", Content: "hi"}}, nil)
	if err == nil || !strings.Contains(err.Error(), "解析流式响应失败") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateAIConfigThinking(t *testing.T) {
	cfg := Config{
		Provider: "anthropic", BaseURL: "https://example.com", Model: "m",
		MaxTokens: 4096, Thinking: true, ThinkingBudget: 8000,
	}
	err := ValidateConfig(cfg)
	if err == nil || !strings.Contains(err.Error(), "Thinking 预算") {
		t.Fatalf("error = %v", err)
	}
}

func TestValidateAITools(t *testing.T) {
	base := ToolDef{Name: "read_file", Parameters: json.RawMessage(`{"type":"object"}`)}
	bad := []ToolDef{
		{Name: "bad name", Parameters: json.RawMessage(`{}`)},
		{Name: "x", Parameters: json.RawMessage(`[]`)},
	}
	for _, tool := range bad {
		if err := ValidateTools([]ToolDef{tool}); err == nil {
			t.Fatalf("tool %#v should fail", tool)
		}
	}
	if err := ValidateTools([]ToolDef{base, base}); err == nil || !strings.Contains(err.Error(), "重复") {
		t.Fatalf("duplicate error = %v", err)
	}
	if err := ValidateTools([]ToolDef{{Name: "ok", Parameters: nil}}); err != nil {
		t.Fatalf("empty schema should pass: %v", err)
	}
}

func TestAIProxyServerForScheme(t *testing.T) {
	cases := []struct {
		server string
		scheme string
		want   string
	}{
		{"127.0.0.1:7890", "https", "http://127.0.0.1:7890"},
		{"http=127.0.0.1:7890;https=127.0.0.1:7891", "https", "http://127.0.0.1:7891"},
		{"http=127.0.0.1:7890;https=127.0.0.1:7891", "http", "http://127.0.0.1:7890"},
		{"socks=127.0.0.1:1080", "https", "socks5://127.0.0.1:1080"},
		{"https://proxy.example.com:8443", "http", "https://proxy.example.com:8443"},
	}
	for _, c := range cases {
		if got := aiProxyServerForScheme(c.server, c.scheme); got != c.want {
			t.Fatalf("server=%q scheme=%q got=%q want=%q", c.server, c.scheme, got, c.want)
		}
	}
}

func TestAIProxyBypassed(t *testing.T) {
	override := "*.example.com;example.com;localhost;<local>"
	cases := map[string]bool{
		"api.example.com": true,
		"example.com":     true,
		"localhost":       true,
		"127.0.0.1":       true,
		"api.other.com":   false,
	}
	for host, want := range cases {
		if got := aiProxyBypassed(host, override); got != want {
			t.Fatalf("host=%q got=%v want=%v", host, got, want)
		}
	}
}

func TestAIStreamOpenAIReasoningKeepsWhitespace(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"reasoning_content": "I have"},
			"finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"reasoning_content": " enough"},
			"finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"reasoning_content": "\n\nNext line"},
			"finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"content": "done"},
			"finish_reason": "stop",
		}}})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	cfg := Config{
		Provider: "openai", BaseURL: server.URL + "/v1", APIKey: "test-key",
		Model: "test-model", Temperature: 0.2, MaxTokens: 100, Proxy: "direct",
	}
	events, err := runAIStreamForTest(cfg, []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("StreamResponse: %v", err)
	}
	if got, want := aiJoinedDelta(events, EventThink), "I have enough\n\nNext line"; got != want {
		t.Fatalf("reasoning = %q, want %q", got, want)
	}
	if got := aiJoinedDelta(events, EventChunk); got != "done" {
		t.Fatalf("content = %q", got)
	}
}

func TestAIStreamRetry429Backoff(t *testing.T) {
	var requestCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&requestCount, 1)
		if n <= 2 {
			// 前两次限流：Retry-After: 0（测试提速），第三次成功
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = fmt.Fprint(w, `{"error":{"message":"rate limited"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta":         map[string]any{"content": "重试成功"},
			"finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{}, "usage": map[string]any{
			"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5,
		}})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", APIKey: "k", Model: "m", Proxy: "direct"}
	events, err := runAIStreamForTestRetry(cfg, []Message{{Role: "user", Content: "hi"}}, nil, 5)
	if err != nil {
		t.Fatalf("StreamResponse: %v", err)
	}
	if got := atomic.LoadInt32(&requestCount); got != 3 {
		t.Fatalf("请求数 = %d，想要 3（两次 429 + 一次成功）", got)
	}
	retries := aiEventsNamed(events, EventRetry)
	if len(retries) != 2 {
		t.Fatalf("ai-retry 事件数 = %d，想要 2", len(retries))
	}
	first, _ := retries[0].(RetryPayload)
	// 429 是配额类限流：有效次数 = retryMax + 3（分钟窗恢复预算）
	if first.Attempt != 1 || first.Max != 8 || first.Reason != "HTTP 429" {
		t.Fatalf("首个重试事件 = %#v", first)
	}
	if first.DelayMs != 0 {
		t.Fatalf("Retry-After: 0 应生效，DelayMs = %d", first.DelayMs)
	}
	chunks := aiJoinedDelta(events, EventChunk)
	if !strings.Contains(chunks, "重试成功") {
		t.Fatalf("重试后的内容缺失：%q", chunks)
	}
	done := aiEventsNamed(events, EventDone)
	if len(done) != 1 {
		t.Fatalf("ai-done 事件数 = %d", len(done))
	}
}

func TestAIStreamRetryExhausted(t *testing.T) {
	var requestCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = fmt.Fprint(w, `{"error":{"message":"rate limited"}}`)
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", APIKey: "k", Model: "m", Proxy: "direct"}
	events, err := runAIStreamForTestRetry(cfg, []Message{{Role: "user", Content: "hi"}}, nil, 2)
	if err == nil || !strings.Contains(err.Error(), "HTTP 429") || !strings.Contains(err.Error(), "rate limited") {
		t.Fatalf("error = %v", err)
	}
	// 429 有效次数 = retryMax(2) + 3 次限流额外预算 = 5 次重试
	if got := atomic.LoadInt32(&requestCount); got != 6 {
		t.Fatalf("请求数 = %d，想要 6（首次 + 5 次重试）", got)
	}
	if retries := aiEventsNamed(events, EventRetry); len(retries) != 5 {
		t.Fatalf("ai-retry 事件数 = %d，想要 5", len(retries))
	}
}

func TestAIStreamNoRetryOn400(t *testing.T) {
	var requestCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprint(w, `{"error":{"message":"bad request"}}`)
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", APIKey: "k", Model: "m", Proxy: "direct"}
	events, err := runAIStreamForTestRetry(cfg, []Message{{Role: "user", Content: "hi"}}, nil, 5)
	if err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("error = %v", err)
	}
	if got := atomic.LoadInt32(&requestCount); got != 1 {
		t.Fatalf("400 不应重试，请求数 = %d", got)
	}
	if retries := aiEventsNamed(events, EventRetry); len(retries) != 0 {
		t.Fatalf("400 不应有 ai-retry 事件，实际 %d 个", len(retries))
	}
}

func TestAIMaxTokensLimitFromError(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"SenseNova 原文", `field MaxTokens invalid, should be in [1, 131072]`, 131072},
		{"JSON 错误体", `{"error":{"message":"field MaxTokens invalid, should be in [1, 131072]"}}`, 131072},
		{"snake_case", `max_tokens should be in [1, 65536]`, 65536},
		{"max_completion_tokens", `max_completion_tokens must be in [ 1 , 8192 ]`, 8192},
		{"其它字段不误伤", `temperature should be in [0, 2]`, 0},
		{"没有范围", `field MaxTokens invalid`, 0},
		{"上下界反了", `MaxTokens should be in [131072, 1]`, 0},
		{"空错误体", ``, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := aiMaxTokensLimitFromError([]byte(tc.body)); got != tc.want {
				t.Fatalf("上界 = %d，想要 %d", got, tc.want)
			}
		})
	}
}

func TestAIStreamDowngradeMaxTokensOn400(t *testing.T) {
	var requestCount int32
	var seen []float64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&requestCount, 1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mt, _ := body["max_tokens"].(float64)
		seen = append(seen, mt)
		if n == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = fmt.Fprint(w, `{"error":{"message":"field MaxTokens invalid, should be in [1, 131072]"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		writeSSEJSON(w, map[string]any{"choices": []any{map[string]any{
			"delta": map[string]any{"content": "降档成功"}, "finish_reason": nil,
		}}})
		writeSSEJSON(w, map[string]any{"choices": []any{}, "usage": map[string]any{
			"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5,
		}})
		_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	// retryMax=0：参数型降档与 429/5xx 退避重试互不影响。
	cfg := Config{BaseURL: server.URL + "/v1", APIKey: "k", Model: "sensenova-6.8-flash",
		MaxTokens: 134144, Proxy: "direct"}
	events, err := runAIStreamForTestRetry(cfg, []Message{{Role: "user", Content: "hi"}}, nil, 0)
	if err != nil {
		t.Fatalf("StreamResponse: %v", err)
	}
	if got := atomic.LoadInt32(&requestCount); got != 2 {
		t.Fatalf("请求数 = %d，想要 2（超限 400 + 降档重试）", got)
	}
	if len(seen) != 2 || seen[0] != 134144 || seen[1] != 131072 {
		t.Fatalf("max_tokens = %v，想要 [134144 131072]", seen)
	}
	adjusts := aiEventsNamed(events, EventParamAdjust)
	if len(adjusts) != 1 {
		t.Fatalf("ai-param-adjust 事件数 = %d，想要 1", len(adjusts))
	}
	payload, ok := adjusts[0].(ParamAdjustPayload)
	if !ok || payload.Model != cfg.Model || payload.Field != "maxTokens" ||
		payload.Previous != 134144 || payload.Value != 131072 || !strings.Contains(payload.Message, "131072") {
		t.Fatalf("降档事件 = %#v", adjusts[0])
	}
	if got := aiJoinedDelta(events, EventChunk); !strings.Contains(got, "降档成功") {
		t.Fatalf("降档后正文缺失：%q", got)
	}
	if retries := aiEventsNamed(events, EventRetry); len(retries) != 0 {
		t.Fatalf("参数降档不应产生退避重试事件，实际 %d 个", len(retries))
	}
}

func TestAIStreamDowngradeOnlyOnce(t *testing.T) {
	var requestCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprint(w, `{"error":{"message":"field MaxTokens invalid, should be in [1, 131072]"}}`)
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", APIKey: "k", Model: "m", MaxTokens: 200000, Proxy: "direct"}
	events, err := runAIStreamForTestRetry(cfg, []Message{{Role: "user", Content: "hi"}}, nil, 5)
	if err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("error = %v", err)
	}
	if got := atomic.LoadInt32(&requestCount); got != 2 {
		t.Fatalf("请求数 = %d，想要 2（降档最多一次，不许循环）", got)
	}
	if adjusts := aiEventsNamed(events, EventParamAdjust); len(adjusts) != 1 {
		t.Fatalf("降档事件数 = %d，想要 1", len(adjusts))
	}
}

func TestAIStreamNoDowngradeWhenWithinLimit(t *testing.T) {
	var requestCount int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprint(w, `{"error":{"message":"field MaxTokens invalid, should be in [1, 131072]"}}`)
	}))
	defer server.Close()

	cfg := Config{BaseURL: server.URL + "/v1", APIKey: "k", Model: "m", MaxTokens: 4096, Proxy: "direct"}
	events, err := runAIStreamForTestRetry(cfg, []Message{{Role: "user", Content: "hi"}}, nil, 5)
	if err == nil || !strings.Contains(err.Error(), "HTTP 400") {
		t.Fatalf("error = %v", err)
	}
	if got := atomic.LoadInt32(&requestCount); got != 1 {
		t.Fatalf("未超限的 400 不应重试，请求数 = %d", got)
	}
	if adjusts := aiEventsNamed(events, EventParamAdjust); len(adjusts) != 0 {
		t.Fatalf("未超限不应发降档事件，实际 %d 个", len(adjusts))
	}
}

func TestAIRetryDelayExponential(t *testing.T) {
	cases := map[int]time.Duration{
		0: 1 * time.Second,
		1: 2 * time.Second,
		2: 4 * time.Second,
		5: 30 * time.Second, // 32s 被上限压到 30s
		9: 30 * time.Second,
	}
	for attempt, want := range cases {
		got := aiRetryDelay(attempt, "", 0)
		if got < want*85/100 || got > want*115/100 {
			t.Fatalf("attempt %d：delay = %v，期望 %v ±15%%", attempt, got, want)
		}
	}
	if d := aiRetryDelay(3, "7", 0); d != 7*time.Second {
		t.Fatalf("Retry-After 7 应生效，实际 %v", d)
	}
	// HTTP-date 形式的 Retry-After（约 90s 后）
	header := time.Now().UTC().Add(90 * time.Second).Format(http.TimeFormat)
	if d := aiRetryDelay(0, header, 429); d < 85*time.Second || d > 90*time.Second {
		t.Fatalf("Retry-After HTTP-date 应换算成等待时长，实际 %v", d)
	}
	// 过去的 HTTP-date 立即重试
	past := time.Now().UTC().Add(-time.Minute).Format(http.TimeFormat)
	if d := aiRetryDelay(0, past, 429); d != 0 {
		t.Fatalf("过期的 HTTP-date 应立即重试，实际 %v", d)
	}
}

func TestAIRetryDelayRateLimit(t *testing.T) {
	// 429（分钟窗配额）专用曲线：2s→4s→8s→16s→32s→60s 封顶
	cases := map[int]time.Duration{
		0: 2 * time.Second,
		1: 4 * time.Second,
		2: 8 * time.Second,
		4: 32 * time.Second,
		5: 60 * time.Second, // 64s 被上限压到 60s
		9: 60 * time.Second,
	}
	for attempt, want := range cases {
		got := aiRetryDelay(attempt, "", 429)
		if got < want*85/100 || got > want*115/100 {
			t.Fatalf("429 attempt %d：delay = %v，期望 %v ±15%%", attempt, got, want)
		}
	}
}

func TestAIRetryAttempts(t *testing.T) {
	cases := []struct {
		retryMax, code, want int
	}{
		{5, 429, 8}, // 限流额外预算 +3
		{1, 429, 4},
		{10, 429, 13},
		{0, 429, 0}, // 用户显式关闭重试时不强加
		{5, 500, 5}, // 5xx 按用户设置
		{5, 0, 5},   // 网络错误按用户设置
	}
	for _, c := range cases {
		if got := aiRetryAttempts(c.retryMax, c.code); got != c.want {
			t.Fatalf("aiRetryAttempts(%d, %d) = %d，期望 %d", c.retryMax, c.code, got, c.want)
		}
	}
}

func TestAIRetryWaitTouchesWatchdog(t *testing.T) {
	// 长等待必须分段喂看门狗：delay=100ms、每 30ms 一段 → touch 至少 2 次
	previous := aiRetryTouchEvery
	aiRetryTouchEvery = 30 * time.Millisecond
	defer func() { aiRetryTouchEvery = previous }()
	ctx := context.Background()
	touches := 0
	if !aiRetryWait(ctx, 100*time.Millisecond, func() { touches++ }) {
		t.Fatalf("等待被意外取消")
	}
	if touches < 2 {
		t.Fatalf("分段 touch 次数 = %d，期望 ≥2", touches)
	}
	// 用户取消时立即返回 false
	ctx2, cancel := context.WithCancel(context.Background())
	cancel()
	if aiRetryWait(ctx2, time.Second, func() {}) {
		t.Fatalf("已取消的 ctx 应返回 false")
	}
}
