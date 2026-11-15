package main

// AI 流式解析与传输：OpenAI/Anthropic SSE 解码、状态错误文本、HTTP 客户端与代理。

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"
)

func streamOpenAISSE(body io.Reader, id string, emit aiEmitter, touch func()) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)

	finishReason := "stop"
	doneSent := false
	var usage aiUsage
	emitDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		payload := aiDonePayload{Id: id, FinishReason: finishReason}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 || usage.CacheWriteTokens > 0 {
			payload.Usage = &usage
		}
		emit(aiEventDone, payload)
	}

	for scanner.Scan() {
		touch()
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			emitDone()
			return nil
		}
		var chunk openAIStreamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return fmt.Errorf("解析流式响应失败：%w", err)
		}
		if chunk.Error != nil && strings.TrimSpace(chunk.Error.Message) != "" {
			return errors.New(strings.TrimSpace(chunk.Error.Message))
		}
		if chunk.Usage != nil {
			usage.PromptTokens = chunk.Usage.PromptTokens
			usage.CompletionTokens = chunk.Usage.CompletionTokens
			usage.TotalTokens = chunk.Usage.TotalTokens
			if usage.TotalTokens <= 0 {
				usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
			}
			usage.CachedTokens = chunk.Usage.PromptCacheHitTokens
			if details := chunk.Usage.PromptTokensDetails; details != nil && details.CachedTokens > usage.CachedTokens {
				usage.CachedTokens = details.CachedTokens
			}
		}
		for _, choice := range chunk.Choices {
			delta := choice.Delta
			// DeepSeek/Qwen/GLM 系用 reasoning_content，OpenRouter 归一为 reasoning。
			// 注意：推理流的分块边界常带空格/换行，不能 TrimSpace，否则英文思考链会粘连。
			if text := delta.ReasoningContent; text != "" {
				emit(aiEventThink, aiChunkPayload{Id: id, Delta: text})
			}
			if text := delta.Reasoning; text != "" {
				emit(aiEventThink, aiChunkPayload{Id: id, Delta: text})
			}
			for _, call := range delta.ToolCalls {
				emit(aiEventToolCall, aiToolCallPayload{
					Id:        id,
					Index:     call.Index,
					CallId:    call.Id,
					Name:      call.Function.Name,
					ArgsDelta: call.argumentsText(),
				})
			}
			if delta.Content != "" {
				emit(aiEventChunk, aiChunkPayload{Id: id, Delta: delta.Content})
			}
			if choice.FinishReason != nil && *choice.FinishReason != "" {
				finishReason = aiFinishReason(*choice.FinishReason)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	emitDone()
	return nil
}

// responsesStreamEvent：只解析 Responses SSE 里会映射到 ai-* 事件的字段。
// 网关普遍会在 data JSON 里带 type；event: 行即使存在也不影响，这里逐行只读 data:。
type responsesStreamEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta"`
	Item  *struct {
		Type      string `json:"type"`
		CallId    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"item"`
	Response *struct {
		Status string `json:"status"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
		Usage *struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
			TotalTokens  int `json:"total_tokens"`
			InputDetails *struct {
				CachedTokens int `json:"cached_tokens"`
			} `json:"input_tokens_details"`
		} `json:"usage"`
	} `json:"response"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func responsesEventError(ev responsesStreamEvent) string {
	if ev.Error != nil && strings.TrimSpace(ev.Error.Message) != "" {
		return strings.TrimSpace(ev.Error.Message)
	}
	if ev.Response != nil && ev.Response.Error != nil && strings.TrimSpace(ev.Response.Error.Message) != "" {
		return strings.TrimSpace(ev.Response.Error.Message)
	}
	return ""
}

// streamResponsesSSE 把 Responses 事件流归一成现有的 ai-chunk / ai-think /
// ai-toolcall / ai-done。工具调用取 output_item.done 里的完整 function_call
// （arguments 已完整，无需拼接 function_call_arguments.delta）。
func streamResponsesSSE(body io.Reader, id string, emit aiEmitter, touch func()) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)

	finishReason := "stop"
	doneSent := false
	var usage aiUsage
	toolIndex := 0
	emitDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		payload := aiDonePayload{Id: id, FinishReason: finishReason}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 {
			payload.Usage = &usage
		}
		emit(aiEventDone, payload)
	}

	for scanner.Scan() {
		touch()
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			emitDone()
			return nil
		}
		var ev responsesStreamEvent
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return fmt.Errorf("解析 Responses 流式响应失败：%w", err)
		}
		if message := responsesEventError(ev); message != "" {
			return errors.New(message)
		}
		switch ev.Type {
		case "response.output_text.delta", "response.refusal.delta":
			if ev.Delta != "" {
				emit(aiEventChunk, aiChunkPayload{Id: id, Delta: ev.Delta})
			}
		case "response.reasoning_text.delta":
			if ev.Delta != "" {
				emit(aiEventThink, aiChunkPayload{Id: id, Delta: ev.Delta})
			}
		case "response.output_item.done":
			item := ev.Item
			if item == nil || item.Type != "function_call" {
				continue
			}
			callId := item.CallId
			if callId == "" {
				callId = fmt.Sprintf("responses-call-%d", toolIndex)
			}
			emit(aiEventToolCall, aiToolCallPayload{
				Id: id, Index: toolIndex, CallId: callId, Name: item.Name, ArgsDelta: item.Arguments,
			})
			toolIndex++
		case "response.completed", "response.incomplete":
			if ev.Response != nil && ev.Response.Usage != nil {
				u := ev.Response.Usage
				usage.PromptTokens = u.InputTokens
				usage.CompletionTokens = u.OutputTokens
				usage.TotalTokens = u.TotalTokens
				if usage.TotalTokens <= 0 {
					usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
				}
				if u.InputDetails != nil {
					usage.CachedTokens = u.InputDetails.CachedTokens
				}
			}
			if ev.Type == "response.incomplete" {
				finishReason = "length"
			}
			emitDone()
			return nil
		case "error", "response.failed":
			return errors.New("Responses 流式响应失败（" + ev.Type + "）")
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	emitDone()
	return nil
}

func streamAnthropicSSE(body io.Reader, id string, emit aiEmitter, touch func()) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)

	eventName := ""
	var dataLines []string
	finishReason := "stop"
	doneSent := false
	var usage aiUsage
	signature := strings.Builder{}

	emitDone := func() {
		if doneSent {
			return
		}
		doneSent = true
		payload := aiDonePayload{
			Id:                id,
			FinishReason:      finishReason,
			ThinkingSignature: signature.String(),
		}
		if usage.TotalTokens > 0 || usage.PromptTokens > 0 || usage.CompletionTokens > 0 || usage.CachedTokens > 0 || usage.CacheWriteTokens > 0 {
			payload.Usage = &usage
		}
		emit(aiEventDone, payload)
	}

	dispatch := func(event, data string) error {
		if strings.TrimSpace(data) == "" {
			return nil
		}
		var envelope anthropicStreamChunk
		if err := json.Unmarshal([]byte(data), &envelope); err != nil {
			return fmt.Errorf("解析 Anthropic 流失败：%w", err)
		}
		if event == "" {
			event = envelope.Type
		}
		switch event {
		case "message_start":
			if envelope.Message != nil {
				u := envelope.Message.Usage
				usage.PromptTokens = u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
				usage.CachedTokens = u.CacheReadInputTokens
				usage.CacheWriteTokens = u.CacheCreationInputTokens
			}
		case "content_block_start":
			if block := envelope.ContentBlock; block != nil {
				switch block.Type {
				case "text":
					if block.Text != "" {
						emit(aiEventChunk, aiChunkPayload{Id: id, Delta: block.Text})
					}
				case "thinking":
					if block.Thinking != "" {
						emit(aiEventThink, aiChunkPayload{Id: id, Delta: block.Thinking})
					}
					if block.Signature != "" {
						signature.WriteString(block.Signature)
					}
				case "tool_use":
					emit(aiEventToolCall, aiToolCallPayload{
						Id:     id,
						Index:  envelope.Index,
						CallId: block.Id,
						Name:   block.Name,
					})
				}
			}
		case "content_block_delta":
			if delta := envelope.Delta; delta != nil {
				if delta.Text != "" {
					emit(aiEventChunk, aiChunkPayload{Id: id, Delta: delta.Text})
				}
				if delta.Thinking != "" {
					emit(aiEventThink, aiChunkPayload{Id: id, Delta: delta.Thinking})
				}
				if delta.Signature != "" {
					signature.WriteString(delta.Signature)
				}
				if delta.PartialJson != "" {
					emit(aiEventToolCall, aiToolCallPayload{
						Id:        id,
						Index:     envelope.Index,
						ArgsDelta: delta.PartialJson,
					})
				}
			}
		case "message_delta":
			if delta := envelope.Delta; delta != nil && delta.StopReason != "" {
				finishReason = aiFinishReason(delta.StopReason)
			}
			if envelope.Usage != nil {
				if envelope.Usage.OutputTokens > 0 {
					usage.CompletionTokens = envelope.Usage.OutputTokens
				}
				if usage.PromptTokens == 0 {
					u := envelope.Usage
					usage.PromptTokens = u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
					usage.CachedTokens = u.CacheReadInputTokens
					usage.CacheWriteTokens = u.CacheCreationInputTokens
				}
				usage.TotalTokens = usage.PromptTokens + usage.CompletionTokens
			}
		case "message_stop":
			emitDone()
			return errAnthropicDone
		case "error":
			if envelope.Error != nil && strings.TrimSpace(envelope.Error.Message) != "" {
				return errors.New(strings.TrimSpace(envelope.Error.Message))
			}
			return errors.New("Anthropic 返回未知错误")
		}
		return nil
	}

	flush := func() error {
		if len(dataLines) == 0 {
			eventName = ""
			return nil
		}
		if err := dispatch(eventName, strings.Join(dataLines, "\n")); err != nil {
			return err
		}
		eventName = ""
		dataLines = dataLines[:0]
		return nil
	}

	for scanner.Scan() {
		touch()
		line := scanner.Text()
		switch {
		case line == "":
			if err := flush(); err != nil {
				if errors.Is(err, errAnthropicDone) {
					return nil
				}
				return err
			}
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if err := flush(); err != nil {
		if errors.Is(err, errAnthropicDone) {
			return nil
		}
		return err
	}
	emitDone()
	return nil
}

func aiFinishReason(reason string) string {
	switch strings.ToLower(strings.TrimSpace(reason)) {
	case "tool_calls", "tool_use", "function_call":
		return "tool"
	default:
		return "stop"
	}
}

func aiStatusErrorText(resp *http.Response) string {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, aiErrorBodyLimit))
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
		text = http.StatusText(resp.StatusCode)
	}
	runes := []rune(text)
	if len(runes) > aiErrorTextLimit {
		text = string(runes[:aiErrorTextLimit]) + "…"
	}
	return fmt.Sprintf("AI 接口返回 HTTP %d：%s", resp.StatusCode, text)
}

func aiBaseHost(baseURL string) string {
	u, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return ""
	}
	return u.Host
}

func newAIHTTPClient(cfg AIConfig) (*http.Client, error) {
	proxy, err := aiProxyFunc(cfg.Proxy)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: aiDialTimeout, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 proxy,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   aiDialTimeout,
		ExpectContinueTimeout: time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	return &http.Client{Transport: transport}, nil
}

func aiProxyFunc(mode string) (func(*http.Request) (*url.URL, error), error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "system":
		return systemAIProxy(), nil
	case "direct", "none", "off":
		return nil, nil
	default:
		u, err := url.Parse(mode)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("代理地址无效：%s", mode)
		}
		switch strings.ToLower(u.Scheme) {
		case "http", "https", "socks5":
		default:
			return nil, fmt.Errorf("代理仅支持 http/https/socks5：%s", mode)
		}
		return http.ProxyURL(u), nil
	}
}

// aiSystemProxyResolver 把 Windows Internet Settings 的 ProxyServer/ProxyOverride
// 转成 Transport 的 Proxy 回调。ProxyServer 支持 "host:port" 与
// "http=host:port;https=host:port;socks=host:port" 两种形式。
func aiSystemProxyResolver(server, override string) func(*http.Request) (*url.URL, error) {
	server = strings.TrimSpace(server)
	if server == "" {
		return nil
	}
	return func(req *http.Request) (*url.URL, error) {
		host := req.URL.Hostname()
		if aiProxyBypassed(host, override) {
			return nil, nil
		}
		raw := aiProxyServerForScheme(server, req.URL.Scheme)
		if raw == "" {
			return nil, nil
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			return nil, nil
		}
		return u, nil
	}
}

func aiProxyServerForScheme(server, scheme string) string {
	server = strings.TrimSpace(server)
	if server == "" {
		return ""
	}
	scheme = strings.ToLower(scheme)
	if !strings.Contains(server, "=") {
		return aiProxyURLWithScheme(server, "http")
	}

	entries := map[string]string{}
	for _, part := range strings.Split(server, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		key, value, ok := strings.Cut(part, "=")
		if !ok {
			if len(entries) == 0 {
				entries["http"] = part
			}
			continue
		}
		entries[strings.ToLower(strings.TrimSpace(key))] = strings.TrimSpace(value)
	}
	// ProxyServer 的 key 是「用于哪种请求」，代理本身默认走 HTTP 协议；
	// 只有 socks 项才用 socks5://。
	if value := entries[scheme]; value != "" {
		return aiProxyURLWithScheme(value, "http")
	}
	if value := entries["http"]; value != "" {
		return aiProxyURLWithScheme(value, "http")
	}
	if value := entries["socks"]; value != "" {
		return aiProxyURLWithScheme(value, "socks5")
	}
	if value := entries["socks5"]; value != "" {
		return aiProxyURLWithScheme(value, "socks5")
	}
	for _, value := range entries {
		return aiProxyURLWithScheme(value, "http")
	}
	return ""
}

func aiProxyURLWithScheme(server, scheme string) string {
	server = strings.TrimSpace(server)
	if server == "" {
		return ""
	}
	if strings.Contains(server, "://") {
		return server
	}
	return scheme + "://" + server
}

func aiProxyBypassed(host, override string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "" || strings.TrimSpace(override) == "" {
		return false
	}
	for _, raw := range strings.FieldsFunc(override, func(r rune) bool { return r == ';' || r == ',' }) {
		pattern := strings.ToLower(strings.TrimSpace(raw))
		if pattern == "" {
			continue
		}
		if pattern == "*" {
			return true
		}
		if pattern == "<local>" {
			if host == "localhost" || host == "127.0.0.1" || host == "::1" || !strings.Contains(host, ".") {
				return true
			}
			continue
		}
		if matched, err := path.Match(pattern, host); err == nil && matched {
			return true
		}
		if host == pattern || strings.HasSuffix(host, "."+pattern) {
			return true
		}
	}
	return false
}

func listAIModels(client *http.Client, cfg AIConfig) ([]string, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	req, err := http.NewRequest(http.MethodGet, aiOpenAIModelsURL(base), nil)
	if err != nil {
		return nil, err
	}
	if err := aiApplyHeaders(req, cfg, aiProviderOpenAI, false); err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("获取模型列表失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, errors.New(aiStatusErrorText(resp))
	}
	var payload struct {
		Data []struct {
			Id string `json:"id"`
		} `json:"data"`
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("解析模型列表失败：%w", err)
	}
	models := make([]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if id := strings.TrimSpace(item.Id); id != "" {
			models = append(models, id)
		}
		if len(models) >= aiMaxModels {
			break
		}
	}
	if len(models) == 0 {
		return nil, errors.New("接口未返回模型列表")
	}
	sort.Strings(models)
	return models, nil
}

// openAIStreamChunk 的 arguments/reasoning 用 RawMessage 兼容个别网关
// 把对象/字符串混发的情况。
type openAIStreamChunk struct {
	Choices []struct {
		Delta struct {
			Content          string                `json:"content"`
			ReasoningContent string                `json:"reasoning_content"`
			Reasoning        string                `json:"reasoning"`
			ToolCalls        []openAIToolCallDelta `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens         int `json:"prompt_tokens"`
		CompletionTokens     int `json:"completion_tokens"`
		TotalTokens          int `json:"total_tokens"`
		PromptCacheHitTokens int `json:"prompt_cache_hit_tokens"`
		PromptTokensDetails  *struct {
			CachedTokens int `json:"cached_tokens"`
		} `json:"prompt_tokens_details"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type openAIToolCallDelta struct {
	Index    int    `json:"index"`
	Id       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

// argumentsText 取字符串形式的参数增量；个别网关直接发对象，原样返回 JSON 文本。
func (call openAIToolCallDelta) argumentsText() string {
	if len(call.Function.Arguments) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(call.Function.Arguments, &text); err == nil {
		return text
	}
	return string(call.Function.Arguments)
}

type anthropicStreamChunk struct {
	Type    string `json:"type"`
	Index   int    `json:"index"`
	Message *struct {
		Usage struct {
			InputTokens              int `json:"input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
	ContentBlock *struct {
		Type      string `json:"type"`
		Text      string `json:"text"`
		Thinking  string `json:"thinking"`
		Signature string `json:"signature"`
		Id        string `json:"id"`
		Name      string `json:"name"`
	} `json:"content_block"`
	Delta *struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		Thinking    string `json:"thinking"`
		Signature   string `json:"signature"`
		PartialJson string `json:"partial_json"`
		StopReason  string `json:"stop_reason"`
	} `json:"delta"`
	Usage *struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	} `json:"usage"`
	Error *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}
