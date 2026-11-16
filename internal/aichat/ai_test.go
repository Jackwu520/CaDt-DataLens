package aichat

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"datalens/internal/aitransport"
)

func TestAIListModelsOpenAI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"data":[{"id":"zeta"},{"id":"alpha"},{"id":"beta"}]}`)
	}))
	defer server.Close()

	cfg := aitransport.Config{BaseURL: server.URL + "/v1", APIKey: "test-key", Proxy: "direct"}
	models, err := (&Chat{}).AIListModels(cfg)
	if err != nil {
		t.Fatalf("AIListModels: %v", err)
	}
	want := []string{"alpha", "beta", "zeta"}
	if len(models) != len(want) {
		t.Fatalf("models = %#v", models)
	}
	for i := range want {
		if models[i] != want[i] {
			t.Fatalf("models = %#v", models)
		}
	}
}

func TestAIListModelsAnthropicRefused(t *testing.T) {
	cfg := aitransport.Config{Provider: "anthropic", BaseURL: "https://api.anthropic.com", Proxy: "direct"}
	if _, err := (&Chat{}).AIListModels(cfg); err == nil || !strings.Contains(err.Error(), "手动填写") {
		t.Fatalf("error = %v", err)
	}
}

func TestAITestConnectionOpenAI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"data":[{"id":"m1"},{"id":"m2"}]}`)
	}))
	defer server.Close()

	cfg := aitransport.Config{BaseURL: server.URL + "/v1", Proxy: "direct"}
	message, err := (&Chat{}).AITestConnection(cfg)
	if err != nil {
		t.Fatalf("AITestConnection: %v", err)
	}
	if !strings.Contains(message, "2") {
		t.Fatalf("message = %q", message)
	}
}

func TestAITestConnectionAnthropic(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("path = %s", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "test-key" {
			t.Errorf("x-api-key = %q", r.Header.Get("x-api-key"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"id":"msg_1","type":"message"}`)
	}))
	defer server.Close()

	cfg := aitransport.Config{Provider: "anthropic", BaseURL: server.URL, APIKey: "test-key", Model: "claude-test", Proxy: "direct"}
	message, err := (&Chat{}).AITestConnection(cfg)
	if err != nil {
		t.Fatalf("AITestConnection: %v", err)
	}
	if !strings.Contains(message, "Anthropic") {
		t.Fatalf("message = %q", message)
	}
}

func TestAIEnsureDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ai-memory", "nested")
	if err := (&Chat{}).AIEnsureDir(dir); err != nil {
		t.Fatalf("AIEnsureDir: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		t.Fatalf("dir stat: %v %#v", err, info)
	}
	if err := (&Chat{}).AIEnsureDir("  "); err == nil {
		t.Fatalf("empty dir should fail")
	}
}

func TestAISendChatStopCancels(t *testing.T) {
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()

	app := &Chat{}
	cfg := aitransport.Config{BaseURL: server.URL + "/v1", Model: "m", Proxy: "direct"}
	if err := app.AISendChat("stop-session#0", cfg, []aitransport.Message{{Role: "user", Content: "hi"}}, nil, 0); err != nil {
		t.Fatalf("AISendChat: %v", err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatalf("request did not start")
	}
	app.AIStop("stop-session")

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		aiStreams.Lock()
		active := len(aiStreams.entries)
		aiStreams.Unlock()
		if active == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("stream entry did not clean up")
}

func TestAIHomeDir(t *testing.T) {
	want, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("当前环境无法获取用户主目录: %v", err)
	}
	if got := (&Chat{}).AIHomeDir(); got != filepath.Clean(want) {
		t.Fatalf("AIHomeDir = %q，期望 %q", got, filepath.Clean(want))
	}
}

// Emit 接线后失败请求必须发出 ai-error。这是 aichat.Emit 漏注入事故的回归守卫：
// 曾因 startup 忘记注入导致 AI 流式事件（chunk/think/toolcall/done/error）全量静默丢失，
// 且 emit 的 nil 守卫把接线缺失变成无声吞事件，go test 与构建都发现不了。
func TestAISendChatEmitsErrorToWiredHook(t *testing.T) {
	events := make(chan string, 8)
	oldEmit := Emit
	Emit = func(event string, payload any) { events <- event }
	t.Cleanup(func() { Emit = oldEmit })

	// 500 直接走「重试耗尽→失败」路径（retryMax=0 只试一次），不依赖网络拒绝时序。
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer server.Close()

	cfg := aitransport.Config{BaseURL: server.URL + "/v1", Model: "m", Proxy: "direct"}
	if err := (&Chat{}).AISendChat("emit-session#0", cfg, []aitransport.Message{{Role: "user", Content: "hi"}}, nil, 0); err != nil {
		t.Fatalf("AISendChat: %v", err)
	}
	select {
	case event := <-events:
		if event != aitransport.EventError {
			t.Fatalf("event = %q，期望 %q", event, aitransport.EventError)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("失败请求 3 秒内未发出 ai-error：Emit 事件链路中断")
	}
}
