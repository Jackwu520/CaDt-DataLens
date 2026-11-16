package webtools

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeConfigDefaults(t *testing.T) {
	cfg := DefaultConfig()
	for _, key := range CapabilityKeys {
		want := ModeOff
		if key == "search" || key == "fetch" {
			want = ModeBuiltin
		}
		if got := cfg.Capabilities[key].Mode; got != want {
			t.Fatalf("%s 默认来源 = %q，期望 %q", key, got, want)
		}
	}
	if cfg.SearchCount != 10 {
		t.Fatalf("默认搜索条数 = %d，期望 10", cfg.SearchCount)
	}

	cfg = NormalizeConfig(Config{
		SearchCount: 999,
		Capabilities: map[string]Capability{
			"search": {Mode: "PROVIDER"},
			"ocr":    {Mode: "builtin"}, // 非搜索/抓取不允许 builtin
			"tts":    {Mode: "mcp"},
		},
		MCPBindings: map[string]string{"tts": "  mcp__srv__say  "},
	})
	if cfg.SearchCount != 50 {
		t.Fatalf("搜索条数未裁剪：%d", cfg.SearchCount)
	}
	if cfg.Capabilities["search"].Mode != ModeProvider {
		t.Fatalf("search mode = %q", cfg.Capabilities["search"].Mode)
	}
	if cfg.Capabilities["ocr"].Mode != ModeOff {
		t.Fatalf("ocr 的非法 builtin 应回落 off，实际 %q", cfg.Capabilities["ocr"].Mode)
	}
	if cfg.Capabilities["tts"].Mode != ModeMCP {
		t.Fatalf("tts mode = %q", cfg.Capabilities["tts"].Mode)
	}
	if cfg.MCPBindings["tts"] != "mcp__srv__say" {
		t.Fatalf("绑定未 trim：%q", cfg.MCPBindings["tts"])
	}
}

func TestConfigLoadSaveMask(t *testing.T) {
	path := filepath.Join(t.TempDir(), "external-tools.json")
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ModeOf("search") != ModeBuiltin || cfg.ModeOf("ocr") != ModeOff {
		t.Fatalf("缺失文件应返回默认配置：%+v", cfg)
	}
	cfg.Enabled = true
	cfg.APIKey = "sk-test"
	cfg.BaseURL = "https://example.com/v1/tools"
	cfg.Capabilities["ocr"] = Capability{Mode: ModeProvider}
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.ProviderReady() || loaded.ModeOf("ocr") != ModeProvider {
		t.Fatalf("保存后读取不一致：%+v", loaded)
	}
	masked := MaskedConfig(loaded)
	if masked["apiKeySet"] != true {
		t.Fatalf("掩码应显示已配置 key：%+v", masked)
	}
	if _, exists := masked["apiKey"]; exists {
		t.Fatal("掩码配置不得回传 apiKey 明文")
	}
}

func TestRequireProvider(t *testing.T) {
	cfg := DefaultConfig()
	if err := RequireProvider(cfg, "search"); err == nil {
		t.Fatal("内置来源不应通过 provider 校验")
	}
	cfg.Capabilities["ocr"] = Capability{Mode: ModeProvider}
	if err := RequireProvider(cfg, "ocr"); err == nil || !strings.Contains(err.Error(), "总开关") {
		t.Fatalf("未启用时应报总开关错误，实际 %v", err)
	}
	cfg.Enabled = true
	if err := RequireProvider(cfg, "ocr"); err == nil || !strings.Contains(err.Error(), "API Key") {
		t.Fatalf("缺少 key 时应报错，实际 %v", err)
	}
	cfg.APIKey = "sk-test"
	if err := RequireProvider(cfg, "ocr"); err != nil {
		t.Fatalf("配置完整时应通过：%v", err)
	}
}

func providerTestConfig(baseURL string) Config {
	cfg := DefaultConfig()
	cfg.Enabled = true
	cfg.APIKey = "sk-test"
	cfg.BaseURL = baseURL
	for _, key := range CapabilityKeys {
		cfg.Capabilities[key] = Capability{Mode: ModeProvider}
	}
	return cfg
}

func TestProviderSearchMapping(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" {
			t.Errorf("路径 = %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("Authorization = %q", got)
		}
		var body struct {
			Query string `json:"query"`
			Count int    `json:"count"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Query != "golang" || body.Count != 2 {
			t.Errorf("请求体 = %+v", body)
		}
		_, _ = io.WriteString(w, `{"results":[
			{"title":"Go","url":"https://go.dev","snippet":"official","date":"2026-01-02T03:04:05Z"},
			{"title":"Empty snippet","url":"https://example.com","snippet":"","summary":"long summary"},
			{"title":"bad","url":"ftp://x","snippet":"skip"}
		]}`)
	}))
	defer server.Close()
	result, err := ProviderSearch(providerTestConfig(server.URL), "golang", 2)
	if err != nil {
		t.Fatal(err)
	}
	if result["engine"] != "deepseek" {
		t.Fatalf("engine = %v", result["engine"])
	}
	results := result["results"].([]map[string]string)
	if len(results) != 2 {
		t.Fatalf("结果数 = %d，期望 2（ftp 条目应跳过）", len(results))
	}
	if results[0]["title"] != "Go" || results[0]["published"] != "2026-01-02T03:04:05Z" {
		t.Fatalf("第一条映射错误：%+v", results[0])
	}
	if results[1]["snippet"] != "long summary" {
		t.Fatalf("snippet 为空时应回退 summary：%+v", results[1])
	}
}

func TestProviderFetchMapping(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/fetch" {
			t.Errorf("路径 = %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"title":"Example","content":"# Title\n\nHello **world**"}`)
	}))
	defer server.Close()
	result, err := ProviderFetch(providerTestConfig(server.URL), "https://example.com/a", 5)
	if err != nil {
		t.Fatal(err)
	}
	if result["engine"] != "deepseek" || result["title"] != "Example" {
		t.Fatalf("抓取映射错误：%+v", result)
	}
	if result["text"] != "# Tit" || result["truncated"] != true {
		t.Fatalf("截断行为错误：%+v", result)
	}
	if links, ok := result["links"].([]map[string]string); !ok || len(links) != 0 {
		t.Fatalf("links 应为空数组：%+v", result["links"])
	}
}

func TestProviderFetchRejectsNonPublic(t *testing.T) {
	cfg := providerTestConfig("http://127.0.0.1:1")
	for _, raw := range []string{"http://localhost/x", "http://127.0.0.1/x", "ftp://example.com/x"} {
		if _, err := ProviderFetch(cfg, raw, 1000); err == nil {
			t.Fatalf("%s 应被拒绝", raw)
		}
	}
}

func TestProviderOCRMultipart(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ocr" {
			t.Errorf("路径 = %s", r.URL.Path)
		}
		if err := r.ParseMultipartForm(4 << 20); err != nil {
			t.Fatal(err)
		}
		if got := r.FormValue("purpose"); got != "rich_layout_recognition" {
			t.Errorf("purpose = %q", got)
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		data, _ := io.ReadAll(file)
		if string(data) != "fake-image" || header.Filename != "sample.png" {
			t.Errorf("文件 = %s / %q", data, header.Filename)
		}
		_, _ = io.WriteString(w, `{"id":"ocr-1","purpose":"rich_layout_recognition","page_count":2,
			"pages":[{"index":0,"text":"第一页","finish_reason":"stop"},{"index":1,"text":"第二页","finish_reason":"length"}],
			"usage":{"input_tokens":10,"output_tokens":20,"total_tokens":30}}`)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "sample.png")
	if err := os.WriteFile(path, []byte("fake-image"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := ProviderOCR(providerTestConfig(server.URL), path, "rich_layout_recognition")
	if err != nil {
		t.Fatal(err)
	}
	if result["pageCount"] != 2 || result["id"] != "ocr-1" {
		t.Fatalf("OCR 结果 = %+v", result)
	}
	pages := result["pages"].([]map[string]interface{})
	if len(pages) != 2 || pages[1]["finishReason"] != "length" {
		t.Fatalf("分页解析错误：%+v", pages)
	}
}

func TestProviderTTSWritesFile(t *testing.T) {
	audio := []byte("RIFF0000WAVEfmt-")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tts" {
			t.Errorf("路径 = %s", r.URL.Path)
		}
		var body struct {
			Text           string `json:"text"`
			VoiceID        string `json:"voice_id"`
			Format         string `json:"format"`
			FilterMarkdown bool   `json:"filter_markdown"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Text != "你好" || body.VoiceID != "tide" || body.Format != "wav" || !body.FilterMarkdown {
			t.Errorf("TTS 请求体 = %+v", body)
		}
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(audio)
	}))
	defer server.Close()
	workspace := t.TempDir()
	result, err := ProviderTTS(providerTestConfig(server.URL), workspace, "你好", "tide")
	if err != nil {
		t.Fatal(err)
	}
	path := result["path"].(string)
	if !strings.HasPrefix(filepath.ToSlash(result["relPath"].(string)), ".cadt/gen/tts/tts-") {
		t.Fatalf("相对路径 = %v", result["relPath"])
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != string(audio) || result["bytes"] != int64(len(audio)) {
		t.Fatalf("音频落盘不一致：%d 字节", len(raw))
	}
	if result["chars"] != 2 || result["voice"] != "tide" {
		t.Fatalf("TTS 元数据 = %+v", result)
	}
}

func TestProviderASRAndAudioBytes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(4 << 20); err != nil {
			t.Fatal(err)
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		data, _ := io.ReadAll(file)
		if header.Filename != "clip.wav" || string(data) != "wav-bytes" {
			t.Errorf("上传 = %q / %q", header.Filename, data)
		}
		_, _ = io.WriteString(w, `{"request_id":"asr-1","text":"你好","duration_ms":3200}`)
	}))
	defer server.Close()
	cfg := providerTestConfig(server.URL)
	audio, err := AudioBytesForASR("", base64.StdEncoding.EncodeToString([]byte("wav-bytes")))
	if err != nil {
		t.Fatal(err)
	}
	result, err := ProviderASR(cfg, "clip.wav", audio)
	if err != nil {
		t.Fatal(err)
	}
	if result["text"] != "你好" || result["durationMs"] != int64(3200) || result["requestId"] != "asr-1" {
		t.Fatalf("ASR 结果 = %+v", result)
	}
}

func TestProviderHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":{"message":"invalid api key"}}`)
	}))
	defer server.Close()
	_, err := ProviderSearch(providerTestConfig(server.URL), "x", 1)
	if err == nil || !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "invalid api key") {
		t.Fatalf("错误透传不足：%v", err)
	}
}

func TestReadAudioDataURL(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.wav")
	if err := os.WriteFile(path, []byte("RIFF"), 0o644); err != nil {
		t.Fatal(err)
	}
	url, err := ReadAudioDataURL(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "data:audio/wav;base64,") {
		t.Fatalf("data URL = %q", url)
	}
	txt := filepath.Join(dir, "a.txt")
	_ = os.WriteFile(txt, []byte("x"), 0o644)
	if _, err := ReadAudioDataURL(txt); err == nil {
		t.Fatal("非音频扩展名应被拒绝")
	}
}
