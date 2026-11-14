package main

// AI 请求构建：双协议（OpenAI 兼容 / Anthropic）的 URL、请求头、请求体与重试策略。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func aiStreamResponse(ctx context.Context, cancel context.CancelCauseFunc, id string, cfg AIConfig, messages []AIMessage, tools []AIToolDef, emit aiEmitter, retryMax int) error {
	watchdog := time.AfterFunc(aiIdleTimeout, func() { cancel(errAIIdleTimeout) })
	defer watchdog.Stop()
	touch := func() { watchdog.Reset(aiIdleTimeout) }
	// 登记到流条目：工具执行/用户输入等长时间无网络数据时，前端经 AITouchStream 重置看门狗。
	aiStreams.Lock()
	if entry := aiStreams.entries[id]; entry != nil {
		entry.watchdog = watchdog
	}
	aiStreams.Unlock()

	for attempt := 0; ; attempt++ {
		req, err := aiBuildChatRequest(ctx, cfg, messages, tools)
		if err != nil {
			return err
		}
		client, err := newAIHTTPClient(cfg)
		if err != nil {
			return err
		}

		resp, err := client.Do(req)
		if err != nil {
			client.CloseIdleConnections()
			if ctx.Err() != nil {
				// 用户停止 / 空闲超时 / 新请求顶替：交给调用方按 ctx cause 处理
				return fmt.Errorf("请求 AI 接口失败：%w", err)
			}
			if attempt >= retryMax {
				return fmt.Errorf("请求 AI 接口失败：%w", err)
			}
			delay := aiRetryDelay(attempt, "")
			emit(aiEventRetry, aiRetryPayload{Id: id, Attempt: attempt + 1, Max: retryMax, DelayMs: int(delay.Milliseconds()), Reason: "网络错误"})
			writeAppLog("warn", "AI 请求失败，%s 后第 %d/%d 次重试：%v", delay.Round(time.Millisecond), attempt+1, retryMax, err)
			if !aiRetryWait(ctx, delay) {
				return fmt.Errorf("请求 AI 接口失败：%w", err)
			}
			touch()
			continue
		}
		touch()

		if aiRetryableStatus(resp.StatusCode) {
			reason := fmt.Sprintf("HTTP %d", resp.StatusCode)
			body, _ := io.ReadAll(io.LimitReader(resp.Body, aiErrorBodyLimit))
			_ = resp.Body.Close()
			client.CloseIdleConnections()
			if attempt >= retryMax {
				return errors.New(aiStatusErrorBodyText(resp.StatusCode, body))
			}
			delay := aiRetryDelay(attempt, resp.Header.Get("Retry-After"))
			emit(aiEventRetry, aiRetryPayload{Id: id, Attempt: attempt + 1, Max: retryMax, DelayMs: int(delay.Milliseconds()), Reason: reason})
			writeAppLog("warn", "AI 接口返回 %d，%s 后第 %d/%d 次重试", resp.StatusCode, delay.Round(time.Millisecond), attempt+1, retryMax)
			if !aiRetryWait(ctx, delay) {
				return errors.New(aiStatusErrorBodyText(resp.StatusCode, body))
			}
			touch()
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			// 非 2xx：读错误体（含网关校验详情），并把完整请求体转储到日志目录——
			// 定位「reasoning_content 必须回传」这类载荷校验问题的真实规则。
			errBody, _ := io.ReadAll(io.LimitReader(resp.Body, aiErrorBodyLimit))
			defer resp.Body.Close()
			defer client.CloseIdleConnections()
			var dumpPayload map[string]any
			var dumpErr error
			if aiProviderOf(cfg) == aiProviderAnthropic {
				dumpPayload, dumpErr = aiBuildAnthropicBody(cfg, messages, tools)
			} else {
				dumpPayload, dumpErr = aiBuildOpenAIBody(cfg, messages, tools)
			}
			if dumpErr == nil {
				if bodyBytes, merr := json.Marshal(dumpPayload); merr == nil {
					dumpPath := filepath.Join(appLogsDir(), fmt.Sprintf("ai-last-4xx-request-%d.json", time.Now().UnixMilli()))
					_ = os.WriteFile(dumpPath, bodyBytes, 0o600)
					writeAppLog("info", "AI 4xx 请求体转储：%s（messages=%d tools=%d）", dumpPath, len(messages), len(tools))
				}
			}
			return errors.New(aiStatusErrorBodyText(resp.StatusCode, errBody))
		}
		contentType := strings.ToLower(resp.Header.Get("Content-Type"))
		if contentType != "" && !strings.Contains(contentType, "text/event-stream") && !strings.Contains(contentType, "text/plain") {
			defer resp.Body.Close()
			defer client.CloseIdleConnections()
			return fmt.Errorf("网关未返回 SSE 流（Content-Type: %s）", resp.Header.Get("Content-Type"))
		}
		defer resp.Body.Close()
		defer client.CloseIdleConnections()

		// 高频 think/content 经 30ms 微批合并；done/error 先 flush 再发出，toolcall 立即透传。
		batcher := newAIChunkBatcher(id, emit)
		defer batcher.flushNow()
		wrapped := func(event string, payload any) {
			switch event {
			case aiEventThink, aiEventChunk:
				if p, ok := payload.(aiChunkPayload); ok {
					batcher.add(event, p.Delta)
					return
				}
				emit(event, payload)
			case aiEventDone, aiEventError:
				batcher.flushNow()
				emit(event, payload)
			default:
				emit(event, payload)
			}
		}
		if aiProviderOf(cfg) == aiProviderAnthropic {
			return streamAnthropicSSE(resp.Body, id, wrapped, touch)
		}
		return streamOpenAISSE(resp.Body, id, wrapped, touch)
	}
}

// aiRetryableStatus：429（限流）与 5xx（服务端故障）值得重试；4xx 参数/鉴权错误重试无意义。
func aiRetryableStatus(code int) bool {
	return code == http.StatusTooManyRequests || code >= 500
}

// aiRetryDelay 计算第 attempt 次重试（从 0 计）前的等待：优先 Retry-After（秒），
// 否则指数退避 1s→2s→4s…上限 30s，附 ±15% 抖动避免同时重试踩踏。
func aiRetryDelay(attempt int, retryAfter string) time.Duration {
	if v := strings.TrimSpace(retryAfter); v != "" {
		if seconds, err := strconv.ParseFloat(v, 64); err == nil && seconds >= 0 {
			return time.Duration(seconds * float64(time.Second))
		}
	}
	base := time.Second << min(attempt, 5) // 1s 2s 4s 8s 16s 32s → 上限 30s
	if base > 30*time.Second {
		base = 30 * time.Second
	}
	jitter := time.Duration(float64(base) * (0.85 + 0.3*rand.Float64()))
	return jitter
}

// aiRetryWait 等待重试间隔；被取消（用户停止/超时/新请求）返回 false。
func aiRetryWait(ctx context.Context, delay time.Duration) bool {
	if delay <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// aiStatusErrorBodyText 用已读取的状态码与响应体拼错误文案（响应体已关闭时使用）。
func aiStatusErrorBodyText(statusCode int, body []byte) string {
	text := strings.TrimSpace(string(body))
	var envelope struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if text != "" && json.Unmarshal([]byte(text), &envelope) == nil && strings.TrimSpace(envelope.Error.Message) != "" {
		text = strings.TrimSpace(envelope.Error.Message)
	}
	if text == "" {
		text = http.StatusText(statusCode)
	}
	runes := []rune(text)
	if len(runes) > aiErrorTextLimit {
		text = string(runes[:aiErrorTextLimit]) + "…"
	}
	return fmt.Sprintf("AI 接口返回 HTTP %d：%s", statusCode, text)
}

func aiBuildChatRequest(ctx context.Context, cfg AIConfig, messages []AIMessage, tools []AIToolDef) (*http.Request, error) {
	provider := aiProviderOf(cfg)
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")

	var (
		endpoint string
		body     []byte
		err      error
	)
	if provider == aiProviderAnthropic {
		endpoint = aiAnthropicMessagesURL(base)
		var payload map[string]any
		payload, err = aiBuildAnthropicBody(cfg, messages, tools)
		if err == nil {
			body, err = json.Marshal(payload)
		}
	} else {
		endpoint = aiOpenAIChatURL(base)
		var payload map[string]any
		payload, err = aiBuildOpenAIBody(cfg, messages, tools)
		if err == nil {
			body, err = json.Marshal(payload)
		}
	}
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("请求地址无效：%w", err)
	}
	if err := aiApplyHeaders(req, cfg, provider, true); err != nil {
		return nil, err
	}
	return req, nil
}

func aiOpenAIChatURL(base string) string {
	if strings.HasSuffix(base, "/chat/completions") {
		return base
	}
	return base + "/chat/completions"
}

func aiAnthropicMessagesURL(base string) string {
	if strings.HasSuffix(base, "/messages") {
		return base
	}
	if strings.HasSuffix(base, "/v1") {
		return base + "/messages"
	}
	return base + "/v1/messages"
}

func aiOpenAIModelsURL(base string) string {
	if strings.HasSuffix(base, "/models") {
		return base
	}
	return base + "/models"
}

func aiApplyHeaders(req *http.Request, cfg AIConfig, provider aiProviderKind, stream bool) error {
	req.Header.Set("Content-Type", "application/json")
	if stream {
		req.Header.Set("Accept", "text/event-stream")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	req.Header.Set("User-Agent", "CaDt-DataLens/"+strings.TrimPrefix(appVersion, "v")+" AI")
	if provider == aiProviderAnthropic {
		if key := strings.TrimSpace(cfg.APIKey); key != "" {
			req.Header.Set("x-api-key", key)
		}
		req.Header.Set("anthropic-version", "2023-06-01")
	} else if key := strings.TrimSpace(cfg.APIKey); key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	for name, value := range cfg.ExtraHeaders {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if aiForbiddenHeader(name) {
			return fmt.Errorf("不允许自定义请求头：%s", name)
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("自定义请求头包含换行：%s", name)
		}
		req.Header.Set(name, value)
	}
	return nil
}

func aiForbiddenHeader(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "host", "content-length", "transfer-encoding", "connection",
		"proxy-connection", "upgrade", "te", "trailer":
		return true
	}
	return false
}

func aiBuildOpenAIBody(cfg AIConfig, messages []AIMessage, tools []AIToolDef) (map[string]any, error) {
	passReasoning := strings.Contains(strings.ToLower(cfg.Model), "deepseek")
	converted, err := aiOpenAIMessages(messages, passReasoning)
	if err != nil {
		return nil, err
	}
	body := map[string]any{
		"model":       cfg.Model,
		"messages":    converted,
		"stream":      true,
		"temperature": cfg.Temperature,
	}
	if cfg.MaxTokens > 0 {
		body["max_tokens"] = cfg.MaxTokens
	}
	if effort := strings.TrimSpace(cfg.ReasoningEffort); effort != "" {
		body["reasoning_effort"] = effort
	}
	// 思考关闭提示：Thinking=false 时按模型名给会「默认开思考」的国产兼容网下发关闭参数——
	// 不发的话思考模型（GLM-4.5+/5.x 等）会把 reasoning_content 烧掉 max_tokens、正文为空
	// （小预算请求如命令分类器 120 tok 首当其冲，表现为「分类器输出为空」）。
	// GLM（bigmodel）用 thinking.type；Qwen（DashScope 兼容模式）用 enable_thinking。
	// 只对模型名明确的网关发：DeepSeek chat 本不思考、reasoner 关不掉，其他聚合网不发未知参数防 400。
	if !cfg.Thinking {
		lower := strings.ToLower(cfg.Model)
		if strings.Contains(lower, "glm") {
			body["thinking"] = map[string]any{"type": "disabled"}
		} else if strings.Contains(lower, "qwen") || strings.Contains(lower, "qwq") {
			body["enable_thinking"] = false
		}
	}
	if len(tools) > 0 {
		body["tools"] = aiOpenAITools(tools)
	}
	return body, nil
}

func aiBuildAnthropicBody(cfg AIConfig, messages []AIMessage, tools []AIToolDef) (map[string]any, error) {
	system, converted, err := aiAnthropicMessages(messages, cfg.Thinking)
	if err != nil {
		return nil, err
	}
	maxTokens := cfg.MaxTokens
	if maxTokens <= 0 {
		maxTokens = aiDefaultMaxTokens
	}
	body := map[string]any{
		"model":      cfg.Model,
		"max_tokens": maxTokens,
		"messages":   converted,
		"stream":     true,
	}
	if system != "" {
		body["system"] = system
	}
	if len(tools) > 0 {
		body["tools"] = aiAnthropicTools(tools)
	}
	if cfg.Thinking {
		// 扩展思考开启时 Anthropic 拒绝 temperature != 1，直接省略（默认 1）。
		budget := cfg.ThinkingBudget
		if budget < 1024 {
			budget = 1024
		}
		body["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
	} else {
		body["temperature"] = cfg.Temperature
	}
	return body, nil
}

func aiOpenAIMessages(messages []AIMessage, passReasoning bool) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(messages))
	for i, m := range messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		switch role {
		case "system", "user":
			if role == "user" && len(m.Images) > 0 {
				parts := make([]any, 0, len(m.Images)+1)
				if strings.TrimSpace(m.Content) != "" {
					parts = append(parts, map[string]any{"type": "text", "text": m.Content})
				}
				for _, img := range m.Images {
					mime := strings.ToLower(strings.TrimSpace(img.Mime))
					parts = append(parts, map[string]any{
						"type": "image_url",
						"image_url": map[string]any{
							"url": "data:" + mime + ";base64," + img.Data,
						},
					})
				}
				out = append(out, map[string]any{"role": "user", "content": parts})
				break
			}
			out = append(out, map[string]any{"role": role, "content": m.Content})
		case "assistant":
			content := any(m.Content)
			if len(m.ToolCalls) > 0 && strings.TrimSpace(m.Content) == "" {
				content = nil
			}
			obj := map[string]any{"role": "assistant", "content": content}
			if len(m.ToolCalls) > 0 {
				calls := make([]map[string]any, 0, len(m.ToolCalls))
				for _, call := range m.ToolCalls {
					args := strings.TrimSpace(call.Arguments)
					if args == "" {
						args = "{}"
					}
					calls = append(calls, map[string]any{
						"id":   call.Id,
						"type": "function",
						"function": map[string]any{
							"name":      call.Name,
							"arguments": args,
						},
					})
				}
				obj["tool_calls"] = calls
			}
			// deepseek 系思考模型要求多轮回传 reasoning_content（缺失时网关 400：
			// "The reasoning_content in the thinking mode must be passed back"）。
			// 网关逐条校验（2026-11-14 重放 4xx 转储实测）：tools 在场且 assistant
			// 为末条（续写形态）或带 tool_calls 时字段必须存在，空串也必须写。
			// 其他 OpenAI 兼容端点可能拒收未知字段，故按模型名门控。
			if passReasoning {
				obj["reasoning_content"] = m.Thinking
			}
			out = append(out, obj)
		case "tool":
			out = append(out, map[string]any{
				"role":         "tool",
				"tool_call_id": m.ToolCallId,
				"content":      m.Content,
			})
		default:
			return nil, fmt.Errorf("第 %d 条消息角色无效：%s", i+1, m.Role)
		}
	}
	return out, nil
}

func aiAnthropicMessages(messages []AIMessage, includeThinking bool) (string, []map[string]any, error) {
	var systemParts []string
	out := make([]map[string]any, 0, len(messages))

	for i, m := range messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		switch role {
		case "system":
			if strings.TrimSpace(m.Content) != "" {
				systemParts = append(systemParts, m.Content)
			}
		case "user":
			if strings.TrimSpace(m.Content) == "" && len(m.Images) == 0 {
				continue
			}
			blocks := make([]any, 0, len(m.Images)+1)
			if strings.TrimSpace(m.Content) != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
			}
			for _, img := range m.Images {
				mime := strings.ToLower(strings.TrimSpace(img.Mime))
				blocks = append(blocks, map[string]any{
					"type": "image",
					"source": map[string]any{
						"type":       "base64",
						"media_type": mime,
						"data":       img.Data,
					},
				})
			}
			aiAppendAnthropicTurn(&out, "user", blocks)
		case "assistant":
			blocks := make([]any, 0, 3+len(m.ToolCalls))
			if includeThinking && strings.TrimSpace(m.Thinking) != "" && strings.TrimSpace(m.ThinkingSignature) != "" {
				blocks = append(blocks, map[string]any{
					"type":      "thinking",
					"thinking":  m.Thinking,
					"signature": m.ThinkingSignature,
				})
			}
			if strings.TrimSpace(m.Content) != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.Content})
			}
			for _, call := range m.ToolCalls {
				args := strings.TrimSpace(call.Arguments)
				if args == "" {
					args = "{}"
				}
				var input any
				if err := json.Unmarshal([]byte(args), &input); err != nil {
					return "", nil, fmt.Errorf("第 %d 条消息的工具调用参数不是合法 JSON：%w", i+1, err)
				}
				blocks = append(blocks, map[string]any{
					"type":  "tool_use",
					"id":    call.Id,
					"name":  call.Name,
					"input": input,
				})
			}
			aiAppendAnthropicTurn(&out, "assistant", blocks)
		case "tool":
			if strings.TrimSpace(m.ToolCallId) == "" {
				return "", nil, fmt.Errorf("第 %d 条工具消息缺少 toolCallId", i+1)
			}
			aiAppendAnthropicTurn(&out, "user", []any{map[string]any{
				"type":        "tool_result",
				"tool_use_id": m.ToolCallId,
				"content":     m.Content,
			}})
		default:
			return "", nil, fmt.Errorf("第 %d 条消息角色无效：%s", i+1, m.Role)
		}
	}

	if len(out) == 0 {
		return "", nil, errors.New("消息为空")
	}
	return strings.Join(systemParts, "\n\n"), out, nil
}

// aiAppendAnthropicTurn 合并相邻同角色轮次，保证 user/assistant 交替。
func aiAppendAnthropicTurn(out *[]map[string]any, role string, blocks []any) {
	if len(blocks) == 0 {
		return
	}
	if len(*out) > 0 {
		last := (*out)[len(*out)-1]
		if lastRole, _ := last["role"].(string); lastRole == role {
			existing, _ := last["content"].([]any)
			last["content"] = append(existing, blocks...)
			return
		}
	}
	*out = append(*out, map[string]any{"role": role, "content": blocks})
}

func aiOpenAITools(tools []AIToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema, err := aiToolSchema(tool)
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"type": "function",
			"function": map[string]any{
				"name":        tool.Name,
				"description": tool.Description,
				"parameters":  schema,
			},
		})
	}
	return out
}

func aiAnthropicTools(tools []AIToolDef) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		schema, err := aiToolSchema(tool)
		if err != nil {
			continue
		}
		out = append(out, map[string]any{
			"name":         tool.Name,
			"description":  tool.Description,
			"input_schema": schema,
		})
	}
	return out
}
