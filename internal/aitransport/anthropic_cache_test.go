// anthropic_cache_test.go：Anthropic 提示词缓存的断点形状与降级。
// 锁住三件事：断点打在哪（系统提示词 / 最后一个工具 / 最后一条消息）、断点总数不超上限、
// 关掉时请求体必须完全回到原样（网关不认 cache_control 时要能干净降级）。
package aitransport

import (
	"testing"
)

func anthropicCacheFixture() (Config, []Message, []ToolDef) {
	cfg := Config{Provider: "anthropic", Model: "claude-x", MaxTokens: 1024}
	messages := []Message{
		{Role: "system", Content: "系统守则"},
		{Role: "user", Content: "帮我看下"},
		{Role: "assistant", Content: "", ToolCalls: []ToolCall{{Id: "c1", Name: "read_file", Arguments: "{}"}}},
		{Role: "tool", ToolCallId: "c1", Content: "文件内容"},
	}
	tools := []ToolDef{{Name: "read_file"}, {Name: "web_fetch"}}
	return cfg, messages, tools
}

// countCacheControl 数一份请求体里打了几个断点。
func countCacheControl(body map[string]any) int {
	n := 0
	if blocks, ok := body["system"].([]map[string]any); ok {
		for _, block := range blocks {
			if _, has := block["cache_control"]; has {
				n++
			}
		}
	}
	if defs, ok := body["tools"].([]map[string]any); ok {
		for _, def := range defs {
			if _, has := def["cache_control"]; has {
				n++
			}
		}
	}
	if messages, ok := body["messages"].([]map[string]any); ok {
		for _, message := range messages {
			blocks, _ := message["content"].([]any)
			for _, raw := range blocks {
				if block, ok := raw.(map[string]any); ok {
					if _, has := block["cache_control"]; has {
						n++
					}
				}
			}
		}
	}
	return n
}

func TestAnthropicCacheControlBreakpoints(t *testing.T) {
	cfg, messages, tools := anthropicCacheFixture()
	body, err := aiBuildAnthropicBody(cfg, messages, tools)
	if err != nil {
		t.Fatal(err)
	}
	// 系统提示词从纯字符串变成 block 数组，且末块带断点
	blocks, ok := body["system"].([]map[string]any)
	if !ok || len(blocks) != 1 {
		t.Fatalf("system 应是单块数组，实际 %T", body["system"])
	}
	if blocks[0]["text"] != "系统守则" {
		t.Fatalf("system 正文丢失：%v", blocks[0]["text"])
	}
	if _, has := blocks[0]["cache_control"]; !has {
		t.Fatal("系统提示词应带 cache_control")
	}
	// 工具：只有最后一个带断点（前缀末尾才有效）
	defs, _ := body["tools"].([]map[string]any)
	if len(defs) != 2 {
		t.Fatalf("工具数 = %d", len(defs))
	}
	if _, has := defs[0]["cache_control"]; has {
		t.Fatal("只有最后一个工具该带断点")
	}
	if _, has := defs[1]["cache_control"]; !has {
		t.Fatal("最后一个工具应带断点")
	}
	// 最后一条消息的最后一个 block 带断点
	converted, _ := body["messages"].([]map[string]any)
	lastBlocks, _ := converted[len(converted)-1]["content"].([]any)
	lastBlock, _ := lastBlocks[len(lastBlocks)-1].(map[string]any)
	if _, has := lastBlock["cache_control"]; !has {
		t.Fatal("最后一条消息的末块应带断点")
	}
	// 断点总数：Anthropic 上限 4
	if n := countCacheControl(body); n != 3 {
		t.Fatalf("断点数 = %d，期望 3（系统 + 末工具 + 末消息）", n)
	}
}

func TestAnthropicCacheControlDisabled(t *testing.T) {
	cfg, messages, tools := anthropicCacheFixture()
	cfg.noPromptCache = true
	body, err := aiBuildAnthropicBody(cfg, messages, tools)
	if err != nil {
		t.Fatal(err)
	}
	if _, isString := body["system"].(string); !isString {
		t.Fatalf("关掉缓存后 system 应回到纯字符串，实际 %T", body["system"])
	}
	if n := countCacheControl(body); n != 0 {
		t.Fatalf("关掉缓存后不该有断点，实际 %d 个", n)
	}
}

// 最后一条消息只有 thinking 块时不能把断点打在它上面（该类型不接受 cache_control）。
func TestAnthropicCacheControlSkipsThinkingTail(t *testing.T) {
	cfg := Config{Provider: "anthropic", Model: "claude-x", Thinking: true, MaxTokens: 1024}
	messages := []Message{
		{Role: "system", Content: "守则"},
		{Role: "user", Content: "问题"},
		{Role: "assistant", Content: "回答", Thinking: "想了想", ThinkingSignature: "sig"},
	}
	body, err := aiBuildAnthropicBody(cfg, messages, []ToolDef{})
	if err != nil {
		t.Fatal(err)
	}
	converted, _ := body["messages"].([]map[string]any)
	lastBlocks, _ := converted[len(converted)-1]["content"].([]any)
	lastBlock, _ := lastBlocks[len(lastBlocks)-1].(map[string]any)
	if lastBlock["type"] == "thinking" {
		t.Fatal("thinking 块不接受 cache_control：断点应往前落到 text 块")
	}
	if _, has := lastBlock["cache_control"]; !has {
		t.Fatal("应在 text 块上打点")
	}
}

func TestAnthropicRejectsCacheControlDetection(t *testing.T) {
	if !aiRejectsCacheControl(400, []byte(`{"error":"unexpected field cache_control"}`)) {
		t.Fatal("400 + cache_control 应判定为网关不支持")
	}
	if aiRejectsCacheControl(500, []byte("cache_control")) {
		t.Fatal("非 400 不当作字段兼容问题")
	}
	if aiRejectsCacheControl(400, []byte(`{"error":"max_tokens too large"}`)) {
		t.Fatal("无关的 400 不应误判")
	}
}
