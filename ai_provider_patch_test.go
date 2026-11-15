package main

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

// 插件 provider 的请求体补丁：业务字段可覆盖，stream 恒为 true（SSE 解码依赖）。
func TestAIApplyBodyPatchKeepsStream(t *testing.T) {
	body := map[string]any{"model": "demo", "messages": []any{}, "stream": true}
	aiApplyBodyPatch(body, map[string]any{
		"stream":      false,
		"tool_choice": "none",
		"tools":       []any{map[string]any{"type": "function"}},
	})
	if body["stream"] != true {
		t.Fatalf("stream 被插件改成了 %v", body["stream"])
	}
	if body["tool_choice"] != "none" {
		t.Fatalf("tool_choice 未合并：%v", body["tool_choice"])
	}
	if _, ok := body["tools"]; !ok {
		t.Fatal("tools 未合并")
	}
	if body["model"] != "demo" {
		t.Fatalf("model 被意外改动：%v", body["model"])
	}
}

// 超量补丁整体忽略，避免绕过 aiMaxExtraBodyKeys 护栏。
func TestAIApplyBodyPatchRejectsOversized(t *testing.T) {
	body := map[string]any{"stream": true, "marker": 1}
	patch := map[string]any{}
	for i := 0; i <= aiMaxExtraBodyKeys; i++ {
		patch["k"+string(rune('a'+i%26))+strings.Repeat("x", i)] = i
	}
	aiApplyBodyPatch(body, patch)
	if len(body) != 2 || body["marker"] != 1 {
		t.Fatalf("超量补丁不应生效：%v", body)
	}
}

func TestValidateAIEndpointExtraBody(t *testing.T) {
	cfg := AIConfig{BaseURL: "https://example.com/v1", Model: "demo", MaxTokens: 8}
	cfg.ExtraBody = map[string]any{"tool_choice": "none"}
	if err := validateAIEndpoint(cfg); err != nil {
		t.Fatalf("合法补丁被拒：%v", err)
	}
	cfg.ExtraBody = map[string]any{"blob": strings.Repeat("x", aiMaxExtraBodyBytes)}
	if err := validateAIEndpoint(cfg); err == nil {
		t.Fatal("超过体积上限的补丁应被拒")
	}
	cfg.ExtraBody = make(map[string]any, aiMaxExtraBodyKeys+1)
	for i := 0; i <= aiMaxExtraBodyKeys; i++ {
		cfg.ExtraBody["k"+strings.Repeat("x", i)] = i
	}
	if err := validateAIEndpoint(cfg); err == nil {
		t.Fatal("超过键数上限的补丁应被拒")
	}
}

// 端到端：补丁确实进入最终 HTTP 请求体，且 stream 仍为 true。
func TestAIChatRequestAppliesPluginBodyPatch(t *testing.T) {
	cfg := AIConfig{
		BaseURL:    "https://example.com/v1",
		APIKey:     "public",
		Model:      "demo",
		MaxTokens:  8,
		ExtraBody:  map[string]any{"stream": false, "tool_choice": "none", "custom_flag": 7},
	}
	req, err := aiBuildChatRequest(context.Background(), cfg, []AIMessage{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("请求体不是 JSON：%v", err)
	}
	if payload["stream"] != true {
		t.Fatalf("实际请求体 stream = %v", payload["stream"])
	}
	if payload["tool_choice"] != "none" || payload["custom_flag"] != float64(7) {
		t.Fatalf("补丁未进入请求体：%v", payload)
	}
	if req.URL.String() != "https://example.com/v1/chat/completions" {
		t.Fatalf("端点被改动：%s", req.URL.String())
	}
}
