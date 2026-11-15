package main

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestAIProviderOfResponses(t *testing.T) {
	for _, value := range []string{"responses", "openai-responses", " Responses "} {
		if got := aiProviderOf(AIConfig{Provider: value}); got != aiProviderResponses {
			t.Fatalf("%q 未识别成 responses：%v", value, got)
		}
	}
	if aiProviderName(AIConfig{Provider: "responses"}) != "responses" {
		t.Fatal("aiProviderName 未返回 responses")
	}
	if aiProviderOf(AIConfig{Provider: "anthropic"}) != aiProviderAnthropic ||
		aiProviderOf(AIConfig{Provider: "openai"}) != aiProviderOpenAI {
		t.Fatal("原有协议识别被破坏")
	}
}

func TestAIResponsesURL(t *testing.T) {
	cases := map[string]string{
		"https://api.openai.com/v1":              "https://api.openai.com/v1/responses",
		"https://api.openai.com/v1/responses":    "https://api.openai.com/v1/responses",
		"https://x/v1/chat/completions":          "https://x/v1/responses",
	}
	for base, want := range cases {
		if got := aiResponsesURL(base); got != want {
			t.Fatalf("%s → %s，期望 %s", base, got, want)
		}
	}
}

func TestAIBuildResponsesBody(t *testing.T) {
	cfg := AIConfig{Provider: "responses", Model: "gpt-5", MaxTokens: 512, Temperature: 0.4, ReasoningEffort: "high"}
	messages := []AIMessage{
		{Role: "system", Content: "规则"},
		{Role: "user", Content: "hi"},
		{Role: "assistant", ToolCalls: []AIToolCall{{Id: "c1", Name: "read", Arguments: `{"path":"a"}`}}},
		{Role: "tool", ToolCallId: "c1", Content: "文件内容"},
	}
	tools := []AIToolDef{{Name: "read", Description: "读文件", Parameters: json.RawMessage(`{"type":"object"}`)}}
	body, err := aiBuildResponsesBody(cfg, messages, tools)
	if err != nil {
		t.Fatal(err)
	}
	if body["instructions"] != "规则" || body["model"] != "gpt-5" || body["stream"] != true ||
		body["max_output_tokens"] != 512 || body["temperature"] != 0.4 {
		t.Fatalf("基础字段不对：%v", body)
	}
	if effort, ok := body["reasoning"].(map[string]any); !ok || effort["effort"] != "high" {
		t.Fatalf("reasoning 未映射：%v", body["reasoning"])
	}
	input, ok := body["input"].([]any)
	if !ok || len(input) != 3 {
		t.Fatalf("input 数量不对：%v", body["input"])
	}
	call, ok := input[1].(map[string]any)
	if !ok || call["type"] != "function_call" || call["name"] != "read" || call["call_id"] != "c1" {
		t.Fatalf("function_call 映射不对：%v", input[1])
	}
	output, ok := input[2].(map[string]any)
	if !ok || output["type"] != "function_call_output" || output["call_id"] != "c1" || output["output"] != "文件内容" {
		t.Fatalf("function_call_output 映射不对：%v", input[2])
	}
	user, ok := input[0].(map[string]any)
	if !ok || user["role"] != "user" {
		t.Fatalf("user 消息映射不对：%v", input[0])
	}
	parts, ok := user["content"].([]any)
	if !ok || len(parts) != 1 {
		t.Fatalf("input_text 部件不对：%v", user["content"])
	}
	list, ok := body["tools"].([]any)
	if !ok || len(list) != 1 {
		t.Fatalf("tools 不对：%v", body["tools"])
	}
	tool, ok := list[0].(map[string]any)
	if !ok || tool["type"] != "function" || tool["name"] != "read" {
		t.Fatalf("Responses 工具必须是扁平的：%v", list[0])
	}
}

// 请求侧端到端：URL / Bearer / ExtraBody 补丁 / stream 强制。
func TestAIChatRequestResponses(t *testing.T) {
	cfg := AIConfig{
		Provider: "responses", BaseURL: "https://api.openai.com/v1", APIKey: "k",
		Model: "gpt-5", MaxTokens: 8,
		ExtraBody: map[string]any{"tool_choice": "auto", "stream": false},
	}
	req, err := aiBuildChatRequest(context.Background(), cfg, []AIMessage{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if req.URL.String() != "https://api.openai.com/v1/responses" {
		t.Fatalf("端点不对：%s", req.URL.String())
	}
	if req.Header.Get("Authorization") != "Bearer k" {
		t.Fatalf("鉴权头不对：%s", req.Header.Get("Authorization"))
	}
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["stream"] != true || payload["tool_choice"] != "auto" {
		t.Fatalf("补丁 / stream 护栏不对：%v", payload)
	}
	if _, ok := payload["input"]; !ok {
		t.Fatal("Responses 请求缺少 input")
	}
	if _, ok := payload["messages"]; ok {
		t.Fatal("Responses 请求不该带 chat/completions 的 messages")
	}
}

func TestStreamResponsesSSE(t *testing.T) {
	stream := strings.Join([]string{
		`event: response.reasoning_text.delta`,
		`data: {"type":"response.reasoning_text.delta","delta":"想一想"}`,
		`data: {"type":"response.output_text.delta","delta":"你好"}`,
		`data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"c1","name":"read","arguments":"{\"path\":\"a\"}"}}`,
		`data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":3}}}}`,
		``,
	}, "\n")

	type event struct {
		name    string
		payload any
	}
	var events []event
	emit := func(name string, payload any) { events = append(events, event{name, payload}) }
	if err := streamResponsesSSE(strings.NewReader(stream), "id1", emit, func() {}); err != nil {
		t.Fatal(err)
	}
	var text, think string
	var toolName string
	var done *aiDonePayload
	for _, ev := range events {
		switch p := ev.payload.(type) {
		case aiChunkPayload:
			if ev.name == aiEventChunk {
				text += p.Delta
			} else if ev.name == aiEventThink {
				think += p.Delta
			}
		case aiToolCallPayload:
			toolName = p.Name
		case aiDonePayload:
			copy := p
			done = &copy
		}
	}
	if text != "你好" || think != "想一想" || toolName != "read" {
		t.Fatalf("事件归一不对：text=%q think=%q tool=%q", text, think, toolName)
	}
	if done == nil || done.FinishReason != "stop" || done.Usage == nil ||
		done.Usage.TotalTokens != 15 || done.Usage.CachedTokens != 3 {
		t.Fatalf("done / usage 不对：%+v", done)
	}
}

func TestStreamResponsesSSEError(t *testing.T) {
	stream := "data: {\"type\":\"error\",\"error\":{\"message\":\"额度不足\"}}\n"
	err := streamResponsesSSE(strings.NewReader(stream), "id1", func(string, any) {}, func() {})
	if err == nil || !strings.Contains(err.Error(), "额度不足") {
		t.Fatalf("错误事件未上报：%v", err)
	}
}
