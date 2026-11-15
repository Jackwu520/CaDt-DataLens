// ai_gen_test.go：生图/视频执行通道测试——目录解析与越界拒绝、mime/扩展名、
// b64 解码嗅探、HTTP 规格请求（httptest 回环）、落盘流程与上限。
package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestAiGenResolveDir(t *testing.T) {
	ws := `D:\proj`
	// 缺省：.cadt/gen/{kind}/YYYY-MM
	dir, err := aiGenResolveDir(ws, "", "image")
	if err != nil {
		t.Fatalf("缺省目录解析失败：%v", err)
	}
	if !strings.Contains(dir, `.cadt`) || !strings.Contains(dir, `gen`) || !strings.Contains(dir, `image`) {
		t.Fatalf("缺省目录不含 .cadt/gen/image：%s", dir)
	}
	// output_path 覆盖（工作区相对）
	dir, err = aiGenResolveDir(ws, `assets\renders`, "video")
	if err != nil {
		t.Fatalf("output_path 解析失败：%v", err)
	}
	if !strings.HasSuffix(dir, `assets\renders`) {
		t.Fatalf("output_path 未生效：%s", dir)
	}
	// 绝对路径拒绝
	if _, err = aiGenResolveDir(ws, `D:\elsewhere`, "image"); err == nil {
		t.Fatal("绝对 output_path 应被拒绝")
	}
	// .. 逃逸拒绝
	if _, err = aiGenResolveDir(ws, `..\outside`, "image"); err == nil {
		t.Fatal(".. 逃逸 output_path 应被拒绝")
	}
	if _, err = aiGenResolveDir(ws, `a\..\..\..\outside`, "image"); err == nil {
		t.Fatal("Clean 后越出工作区应被拒绝")
	}
	// 空工作区拒绝
	if _, err = aiGenResolveDir("", "", "image"); err == nil {
		t.Fatal("空工作区应被拒绝")
	}
}

func TestAiGenExtForAndMIME(t *testing.T) {
	cases := []struct {
		mime, kind, want string
	}{
		{"image/png", "image", "png"},
		{"image/jpeg", "image", "jpg"},
		{"video/mp4", "video", "mp4"},
		{"video/x-msvideo", "video", "avi"},
		{"application/octet-stream", "image", "png"},
		{"application/octet-stream", "video", "mp4"},
		{"image/whatever", "video", "png"},
	}
	for _, c := range cases {
		if got := aiGenExtFor(c.mime, c.kind); got != c.want {
			t.Fatalf("aiGenExtFor(%q,%q)=%q，期望 %q", c.mime, c.kind, got, c.want)
		}
	}
	if got := aiGenNormalizeMIME("image/png; charset=binary"); got != "image/png" {
		t.Fatalf("mime 参数段未剥离：%q", got)
	}
	if got := aiGenNormalizeMIME(" IMAGE/PNG "); got != "image/png" {
		t.Fatalf("mime 未归一小写：%q", got)
	}
}

func TestAiGenClampTimeoutAndLimit(t *testing.T) {
	if aiGenClampTimeout(0) != aiGenMinTimeout || aiGenClampTimeout(99999) != aiGenMaxTimeout || aiGenClampTimeout(60) != 60 {
		t.Fatal("timeout clamp 不符")
	}
	if aiGenItemLimit("image") != aiGenImageLimit || aiGenItemLimit("video") != aiGenVideoLimit {
		t.Fatal("产物大小上限不符")
	}
	if aiGenItemLimit("weird") != aiGenImageLimit {
		t.Fatal("未知 kind 应回落 image 上限")
	}
}

func TestAiGenDecodeB64(t *testing.T) {
	// 1x1 PNG（8 字节签名字头可被 DetectContentType 识别）
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00}
	raw, productMIME, err := aiGenDecodeB64(AIGenProductItem{Type: "b64", Data: base64.StdEncoding.EncodeToString(png)})
	if err != nil || len(raw) != len(png) {
		t.Fatalf("纯 b64 解码失败：%v", err)
	}
	if productMIME != "image/png" {
		t.Fatalf("嗅探 mime 不符：%q", productMIME)
	}
	// data URL 前缀容忍 + 显式 mime 优先
	raw2, productMIME2, err := aiGenDecodeB64(AIGenProductItem{
		Type: "b64", MIME: "image/webp",
		Data: "data:image/webp;base64," + base64.StdEncoding.EncodeToString(png)})
	if err != nil || productMIME2 != "image/webp" {
		t.Fatalf("data URL 解码失败：mime=%q err=%v", productMIME2, err)
	}
	_ = raw2
	if _, _, err = aiGenDecodeB64(AIGenProductItem{Type: "b64", Data: ""}); err == nil {
		t.Fatal("空 b64 应报错")
	}
	if _, _, err = aiGenDecodeB64(AIGenProductItem{Type: "b64", Data: "!!not-b64!!"}); err == nil {
		t.Fatal("非法 b64 应报错")
	}
}

func TestAiGenRedactError(t *testing.T) {
	if got := aiGenRedactError("下载失败：GET https://x/api?api_key=sk-secret 失败"); !strings.Contains(got, "=***") || strings.Contains(got, "sk-secret") {
		t.Fatalf("密钥查询串未脱敏：%q", got)
	}
	if got := aiGenRedactError("普通错误"); got != "普通错误" {
		t.Fatalf("无 URL 错误被改动：%q", got)
	}
}

func TestAiGenHTTPRequestRoundtrip(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":{"message":"bad key"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"b64_json":"QQ=="}],"created":123}`))
	}))
	defer server.Close()

	spec := AIGenHTTPSpec{
		URL:    server.URL + "/v1/images/generations",
		Method: "POST",
		Headers: map[string]string{
			"Authorization": "Bearer sk-test",
			"Content-Type":  "application/json",
		},
		Body:       `{"prompt":"hi"}`,
		TimeoutSec: 10,
	}
	raw, _ := json.Marshal(spec)
	result := aiGenHTTPRequest(string(raw))
	if result.Error != "" {
		t.Fatalf("回环请求报错：%s", result.Error)
	}
	if result.Status != http.StatusOK || result.Truncated {
		t.Fatalf("状态不符：%+v", result)
	}
	var parsed struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal([]byte(result.Body), &parsed); err != nil || len(parsed.Data) != 1 {
		t.Fatalf("响应体解析失败：%v", err)
	}

	// 非 2xx 也回体（前端按 errorPath 提取）
	badSpec := spec
	badSpec.Headers = map[string]string{"Authorization": "Bearer wrong"}
	rawBad, _ := json.Marshal(badSpec)
	resultBad := aiGenHTTPRequest(string(rawBad))
	if resultBad.Status != http.StatusUnauthorized || !strings.Contains(resultBad.Body, "bad key") {
		t.Fatalf("非 2xx 应回状态与体：%+v", resultBad)
	}

	// 非法 scheme / 禁止头
	evil := aiGenHTTPRequest(`{"url":"file:///C:/Windows"}`)
	if evil.Error == "" {
		t.Fatal("file:// scheme 应被拒绝")
	}
	forbidden := AIGenHTTPSpec{URL: server.URL, Method: "GET", Headers: map[string]string{"Host": "evil"}}
	rawForbidden, _ := json.Marshal(forbidden)
	if got := aiGenHTTPRequest(string(rawForbidden)); !strings.Contains(got.Error, "不允许自定义请求头") {
		t.Fatalf("禁止头应被拒绝：%+v", got)
	}
}

func TestAiGenSaveProductsFlow(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0x00, 0x01, 0x02}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
	}))
	defer server.Close()

	workspace := t.TempDir()
	spec := AIGenSaveSpec{
		Workspace: workspace,
		Kind:      "image",
		Items: []AIGenProductItem{
			{Type: "b64", Data: base64.StdEncoding.EncodeToString(png)},
			{Type: "url", URL: server.URL + "/out.png"},
		},
	}
	raw, _ := json.Marshal(spec)
	result := aiGenSaveProducts(string(raw))
	if result.Error != "" {
		t.Fatalf("落盘失败：%s", result.Error)
	}
	if len(result.Files) != 2 {
		t.Fatalf("产物数量不符：%d", len(result.Files))
	}
	for _, file := range result.Files {
		if !strings.HasPrefix(strings.ToLower(file.Path), strings.ToLower(workspace)) {
			t.Fatalf("产物越出工作区：%s", file.Path)
		}
		if !strings.HasSuffix(file.Path, ".png") {
			t.Fatalf("扩展名不符：%s", file.Path)
		}
		if file.MIME != "image/png" || file.Bytes != int64(len(png)) {
			t.Fatalf("产物元数据不符：%+v", file)
		}
	}
	// output_path 覆盖目录
	spec2 := spec
	spec2.OutputPath = filepath.Join("assets", "renders")
	raw2, _ := json.Marshal(spec2)
	result2 := aiGenSaveProducts(string(raw2))
	if result2.Error != "" || !strings.Contains(result2.Files[0].Path, "assets") {
		t.Fatalf("output_path 覆盖失败：%+v", result2)
	}
	// 逃逸拒绝
	spec3 := spec
	spec3.OutputPath = "..\\escape"
	raw3, _ := json.Marshal(spec3)
	if got := aiGenSaveProducts(string(raw3)); got.Error == "" {
		t.Fatal(".. 逃逸 output_path 应被拒绝")
	}
	// 空产物 / 超量
	if got := aiGenSaveProducts(`{"workspace":"x","kind":"image","items":[]}`); got.Error == "" {
		t.Fatal("空产物清单应报错")
	}
	many := `{"workspace":"x","kind":"image","items":[`
	for i := 0; i < 20; i++ {
		if i > 0 {
			many += ","
		}
		many += `{"type":"b64","data":"QQ=="}`
	}
	many += `]}`
	if got := aiGenSaveProducts(many); got.Error == "" {
		t.Fatal("产物超量应报错")
	}
}
