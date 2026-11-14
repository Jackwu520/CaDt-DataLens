package main

// AI 对话入口（Wails 绑定层）：发消息/停止/触摸看门狗/连通性测试/模型列举与目录工具。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) AISendChat(sessionId string, cfg AIConfig, messages []AIMessage, tools []AIToolDef, retryMax int) error {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return errors.New("会话标识为空")
	}
	if retryMax < 0 {
		retryMax = 0
	}
	if retryMax > 10 {
		retryMax = 10
	}
	if err := validateAIConfig(cfg); err != nil {
		return err
	}
	if fixed := sanitizeAIMessages(messages); fixed > 0 {
		// 兜底：前端已在工具轮把错误作为工具结果回给模型；这里防止旧会话/其他路径的坏参数整轮拒收。
		writeAppLog("warn", "AI 请求包含 %d 个非法工具参数，已按 {} 兜底发送", fixed)
	}
	if err := validateAIMessages(messages); err != nil {
		return err
	}
	if err := validateAITools(tools); err != nil {
		return err
	}

	ctx, cancel := context.WithCancelCause(context.Background())
	entry := &aiStreamEntry{cancel: cancel}

	aiStreams.Lock()
	if old := aiStreams.entries[sessionId]; old != nil {
		old.cancel(context.Canceled)
	}
	aiStreams.entries[sessionId] = entry
	aiStreams.Unlock()

	go func() {
		defer func() {
			aiStreams.Lock()
			if aiStreams.entries[sessionId] == entry {
				delete(aiStreams.entries, sessionId)
			}
			aiStreams.Unlock()
			cancel(context.Canceled)
		}()

		started := time.Now()
		writeAppLog("info", "AI 请求：provider=%s host=%s model=%s messages=%d tools=%d",
			aiProviderName(cfg), aiBaseHost(cfg.BaseURL), cfg.Model, len(messages), len(tools))
		err := aiStreamResponse(ctx, cancel, sessionId, cfg, messages, tools, a.aiEmit, retryMax)
		cause := context.Cause(ctx)

		switch {
		case errors.Is(cause, errAIIdleTimeout):
			a.aiEmit(aiEventError, aiErrorPayload{Id: sessionId, Message: errAIIdleTimeout.Error()})
			writeAppLog("error", "AI 流中断：%v", errAIIdleTimeout)
		case errors.Is(cause, context.Canceled):
			a.aiEmit(aiEventDone, aiDonePayload{Id: sessionId, FinishReason: "stopped"})
			writeAppLog("info", "AI 请求已停止（%s）", time.Since(started).Round(time.Millisecond))
		case err != nil:
			a.aiEmit(aiEventError, aiErrorPayload{Id: sessionId, Message: err.Error()})
			writeAppLog("error", "AI 请求失败（%s）：%v", time.Since(started).Round(time.Millisecond), err)
		default:
			writeAppLog("info", "AI 请求结束（%s）", time.Since(started).Round(time.Millisecond))
		}
	}()
	return nil
}

// AIStop 取消匹配 sessionId 的正在进行的请求（前缀匹配支持 session.id#round）。
func (a *App) AIStop(sessionId string) {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return
	}
	var cancels []context.CancelCauseFunc
	aiStreams.Lock()
	for id, entry := range aiStreams.entries {
		if id == sessionId || strings.HasPrefix(id, sessionId+"#") {
			cancels = append(cancels, entry.cancel)
		}
	}
	aiStreams.Unlock()
	for _, cancel := range cancels {
		cancel(context.Canceled)
	}
}

// AITouchStream 重置匹配会话的空闲看门狗（sessionId 前缀匹配）。前端在工具
// 执行/等待用户输入等无网络数据阶段定期调用，避免 120 秒空闲超时误杀挂起的流。
func (a *App) AITouchStream(sessionId string) {
	sessionId = strings.TrimSpace(sessionId)
	if sessionId == "" {
		return
	}
	aiStreams.Lock()
	for id, entry := range aiStreams.entries {
		if id == sessionId || strings.HasPrefix(id, sessionId+"#") {
			if entry.watchdog != nil {
				entry.watchdog.Reset(aiIdleTimeout)
			}
		}
	}
	aiStreams.Unlock()
}

// AITestConnection 验证当前 Profile 的地址/密钥/模型是否可用。
func (a *App) AITestConnection(cfg AIConfig) (string, error) {
	if err := validateAIEndpoint(cfg); err != nil {
		return "", err
	}
	if aiProviderOf(cfg) == aiProviderAnthropic && strings.TrimSpace(cfg.Model) == "" {
		return "", errors.New("请先配置模型名")
	}
	client, err := newAIHTTPClient(cfg)
	if err != nil {
		return "", err
	}
	defer client.CloseIdleConnections()

	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	if aiProviderOf(cfg) == aiProviderAnthropic {
		body, err := json.Marshal(map[string]any{
			"model":      cfg.Model,
			"max_tokens": 1,
			"messages":   []map[string]any{{"role": "user", "content": "ping"}},
		})
		if err != nil {
			return "", err
		}
		req, err := http.NewRequest(http.MethodPost, aiAnthropicMessagesURL(base), bytes.NewReader(body))
		if err != nil {
			return "", err
		}
		if err := aiApplyHeaders(req, cfg, aiProviderAnthropic, false); err != nil {
			return "", err
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("连接失败：%w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return "", errors.New(aiStatusErrorText(resp))
		}
		return fmt.Sprintf("连接成功（Anthropic，HTTP %d）", resp.StatusCode), nil
	}

	models, err := listAIModels(client, cfg)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("连接成功，可用模型 %d 个", len(models)), nil
}

// AIListModels 拉取 OpenAI 兼容端点的模型列表（Anthropic 需手动填写模型名）。
func (a *App) AIListModels(cfg AIConfig) ([]string, error) {
	if err := validateAIEndpoint(cfg); err != nil {
		return nil, err
	}
	if aiProviderOf(cfg) == aiProviderAnthropic {
		return nil, errors.New("Anthropic 不提供模型列表接口，请手动填写模型名")
	}
	client, err := newAIHTTPClient(cfg)
	if err != nil {
		return nil, err
	}
	defer client.CloseIdleConnections()
	return listAIModels(client, cfg)
}

// AIAppDir 返回应用数据根目录（记忆 app 模式、技能 app 级目录都挂在其下）。
func (a *App) AIAppDir() string {
	return appDataRoot()
}

// AIHomeDir 返回当前用户主目录（用户级技能 ~/.agents/skills 解析用；失败返回空串）。
func (a *App) AIHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Clean(home)
}

// AIExePath 返回当前可执行文件绝对路径（内置技能 {{EXE_PATH}} 占位用；失败返回空串）。
func (a *App) AIExePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Clean(exe)
}

// AIEnsureDir 创建记忆/技能目录（MkdirAll，已存在不报错）。
func (a *App) AIEnsureDir(dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return errors.New("目录路径为空")
	}
	info, err := os.Stat(dir)
	if err == nil && info.IsDir() {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建目录失败：%w", err)
	}
	return nil
}

func (a *App) aiEmit(event string, payload any) {
	if a == nil || a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, event, payload)
}
