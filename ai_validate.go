package main

// AI 参数校验：端点协议、配置、消息与工具清单的规范化检查。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

func aiProviderOf(cfg AIConfig) aiProviderKind {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "anthropic", "claude":
		return aiProviderAnthropic
	default:
		return aiProviderOpenAI
	}
}

func aiProviderName(cfg AIConfig) string {
	if aiProviderOf(cfg) == aiProviderAnthropic {
		return "anthropic"
	}
	return "openai"
}

func validateAIEndpoint(cfg AIConfig) error {
	base := strings.TrimSpace(cfg.BaseURL)
	if base == "" {
		return errors.New("请先配置 Base URL")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("Base URL 无效：%s", base)
	}
	if scheme := strings.ToLower(u.Scheme); scheme != "http" && scheme != "https" {
		return fmt.Errorf("Base URL 仅支持 http/https：%s", base)
	}
	if cfg.MaxTokens < 0 {
		return errors.New("maxTokens 不能为负数")
	}
	if len(cfg.ExtraHeaders) > aiMaxExtraHeaders {
		return fmt.Errorf("自定义请求头最多 %d 条", aiMaxExtraHeaders)
	}
	for name, value := range cfg.ExtraHeaders {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		if strings.ContainsAny(name, "\r\n") || strings.ContainsAny(value, "\r\n") {
			return fmt.Errorf("自定义请求头包含换行：%s", name)
		}
		if aiForbiddenHeader(name) {
			return fmt.Errorf("不允许自定义请求头：%s", name)
		}
	}
	return nil
}

func validateAIConfig(cfg AIConfig) error {
	if err := validateAIEndpoint(cfg); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return errors.New("请先配置模型名")
	}
	if aiProviderOf(cfg) == aiProviderAnthropic && cfg.Thinking {
		budget := cfg.ThinkingBudget
		if budget < 1024 {
			budget = 1024
		}
		maxTokens := cfg.MaxTokens
		if maxTokens <= 0 {
			maxTokens = aiDefaultMaxTokens
		}
		if maxTokens <= budget {
			return fmt.Errorf("maxTokens（%d）必须大于 Thinking 预算（%d）", maxTokens, budget)
		}
	}
	return nil
}

// sanitizeAIMessages 把非法的工具调用参数收敛为 {}：一条坏历史不应让整轮请求失败。
// 前端会在工具轮结束时把无法修复的参数作为工具错误结果回给模型，这里只是最后兜底。
// 返回被替换的调用数量。
func sanitizeAIMessages(messages []AIMessage) int {
	fixed := 0
	for i := range messages {
		for j := range messages[i].ToolCalls {
			args := strings.TrimSpace(messages[i].ToolCalls[j].Arguments)
			if args == "" {
				continue
			}
			if json.Valid([]byte(args)) {
				messages[i].ToolCalls[j].Arguments = args
				continue
			}
			messages[i].ToolCalls[j].Arguments = "{}"
			fixed++
		}
	}
	return fixed
}

func validateAIMessages(messages []AIMessage) error {
	if len(messages) == 0 {
		return errors.New("消息为空")
	}
	if len(messages) > 1000 {
		return errors.New("消息数量超过上限")
	}
	for i, m := range messages {
		role := strings.ToLower(strings.TrimSpace(m.Role))
		switch role {
		case "system", "user", "assistant":
		case "tool":
			if strings.TrimSpace(m.ToolCallId) == "" {
				return fmt.Errorf("第 %d 条工具消息缺少 toolCallId", i+1)
			}
		default:
			return fmt.Errorf("第 %d 条消息角色无效：%s", i+1, m.Role)
		}
		if len(m.Images) > 0 {
			if role != "user" {
				return fmt.Errorf("第 %d 条消息只有用户消息可以携带图片", i+1)
			}
			if len(m.Images) > aiMaxImagesPerMessage {
				return fmt.Errorf("第 %d 条消息图片超过上限（%d 张）", i+1, aiMaxImagesPerMessage)
			}
			for j, img := range m.Images {
				mime := strings.ToLower(strings.TrimSpace(img.Mime))
				switch mime {
				case "image/png", "image/jpeg", "image/webp", "image/gif":
				default:
					return fmt.Errorf("第 %d 条消息第 %d 张图片格式不支持：%s", i+1, j+1, img.Mime)
				}
				data := strings.TrimSpace(img.Data)
				if data == "" {
					return fmt.Errorf("第 %d 条消息第 %d 张图片数据为空", i+1, j+1)
				}
				if len(data) > aiMaxImageBase64 {
					return fmt.Errorf("第 %d 条消息第 %d 张图片超过大小上限", i+1, j+1)
				}
				if _, err := base64.StdEncoding.DecodeString(data); err != nil {
					return fmt.Errorf("第 %d 条消息第 %d 张图片不是合法 base64", i+1, j+1)
				}
			}
		}
		if len(m.ToolCalls) > aiMaxToolDefs {
			return fmt.Errorf("第 %d 条消息的工具调用过多", i+1)
		}
		for j, call := range m.ToolCalls {
			if strings.TrimSpace(call.Id) == "" || strings.TrimSpace(call.Name) == "" {
				return fmt.Errorf("第 %d 条消息第 %d 个工具调用缺少 id/name", i+1, j+1)
			}
			if strings.TrimSpace(call.Arguments) != "" && !json.Valid([]byte(call.Arguments)) {
				return fmt.Errorf("第 %d 条消息第 %d 个工具调用参数不是合法 JSON", i+1, j+1)
			}
		}
	}
	return nil
}

func validateAITools(tools []AIToolDef) error {
	if len(tools) > aiMaxToolDefs {
		return fmt.Errorf("工具数量超过上限（%d）", aiMaxToolDefs)
	}
	seen := map[string]bool{}
	for i, tool := range tools {
		name := strings.TrimSpace(tool.Name)
		if !aiToolNameRule.MatchString(name) {
			return fmt.Errorf("第 %d 个工具名称无效：%s", i+1, tool.Name)
		}
		if seen[name] {
			return fmt.Errorf("工具名称重复：%s", name)
		}
		seen[name] = true
		if _, err := aiToolSchema(tool); err != nil {
			return err
		}
	}
	return nil
}

func aiToolSchema(tool AIToolDef) (json.RawMessage, error) {
	raw := bytes.TrimSpace(tool.Parameters)
	if len(raw) == 0 {
		return json.RawMessage(`{"type":"object","properties":{}}`), nil
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("工具 %s 的 parameters 不是合法 JSON", tool.Name)
	}
	if raw[0] != '{' {
		return nil, fmt.Errorf("工具 %s 的 parameters 必须是 JSON 对象", tool.Name)
	}
	return json.RawMessage(raw), nil
}

// aiStreamResponse 执行一次流式请求，事件经 emit 归一化输出。
// 空闲 120 秒会取消 ctx，调用方通过 context.Cause 区分超时与用户停止。
// retryMax > 0 时，对 429/5xx/网络错误做指数退避重试（优先遵循 Retry-After）；
// 仅在尚未输出任何流内容前重试，进入 SSE 解析后不再重试。
