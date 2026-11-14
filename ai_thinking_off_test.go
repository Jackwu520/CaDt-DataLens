package main

import (
	"testing"
)

// Thinking=false 时按模型名给默认开思考的兼容网下发关闭参数（GLM thinking.type / Qwen enable_thinking）；
// 其他网关（deepseek 等）不发未知参数。回归：命令分类器小预算请求被 GLM 思考烧光、正文为空。
func TestAIOpenAIBodyThinkingOff(t *testing.T) {
	cases := []struct {
		model     string
		wantKey   string
		wantValue any
	}{
		{"GLM-5.3-Flash", "thinking", map[string]any{"type": "disabled"}},
		{"glm-4-flash", "thinking", map[string]any{"type": "disabled"}},
		{"qwen3-max", "enable_thinking", false},
		{"QwQ-32B", "enable_thinking", false},
	}
	for _, c := range cases {
		cfg := AIConfig{Provider: "openai", Model: c.model, Temperature: 0, MaxTokens: 512, Thinking: false}
		body, err := aiBuildOpenAIBody(cfg, []AIMessage{{Role: "user", Content: "q"}}, nil)
		if err != nil {
			t.Fatalf("%s: aiBuildOpenAIBody: %v", c.model, err)
		}
		got, ok := body[c.wantKey]
		if !ok {
			t.Fatalf("%s: 缺少 %s 字段: %#v", c.model, c.wantKey, body)
		}
		if gotValue, isMap := got.(map[string]any); isMap {
			wantMap := c.wantValue.(map[string]any)
			if gotValue["type"] != wantMap["type"] {
				t.Fatalf("%s: %s = %#v", c.model, c.wantKey, got)
			}
		} else if got != c.wantValue {
			t.Fatalf("%s: %s = %#v, want %#v", c.model, c.wantKey, got, c.wantValue)
		}
	}
	// 非思考系模型：不下发未知参数
	for _, model := range []string{"deepseek-chat", "deepseek-flash", "gpt-4o-mini"} {
		cfg := AIConfig{Provider: "openai", Model: model, Temperature: 0, MaxTokens: 100, Thinking: false}
		body, err := aiBuildOpenAIBody(cfg, []AIMessage{{Role: "user", Content: "q"}}, nil)
		if err != nil {
			t.Fatalf("%s: aiBuildOpenAIBody: %v", model, err)
		}
		if _, ok := body["thinking"]; ok {
			t.Fatalf("%s: 不应下发 thinking 字段: %#v", model, body)
		}
		if _, ok := body["enable_thinking"]; ok {
			t.Fatalf("%s: 不应下发 enable_thinking 字段: %#v", model, body)
		}
	}
	// Thinking=true：不下发关闭参数
	cfg := AIConfig{Provider: "openai", Model: "glm-4-flash", Temperature: 0, MaxTokens: 100, Thinking: true}
	body, err := aiBuildOpenAIBody(cfg, []AIMessage{{Role: "user", Content: "q"}}, nil)
	if err != nil {
		t.Fatalf("aiBuildOpenAIBody: %v", err)
	}
	if _, ok := body["thinking"]; ok {
		t.Fatalf("Thinking=true 不应下发 thinking 关闭参数: %#v", body)
	}
}
