package previewassets

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewAssetMiddleware(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "assets")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "page.html"), []byte("<h1>ok</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "app.css"), []byte("body{color:red}"), 0o644); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(filepath.Dir(root), "secret-preview.txt")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(secret)

	token, err := Register(root)
	if err != nil || token == "" {
		t.Fatalf("register: token=%q err=%v", token, err)
	}
	if again, err := Register(root); err != nil || again != token {
		t.Fatalf("same dir should reuse token: %q vs %q err=%v", again, token, err)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})
	handler := Middleware(next)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	if rec := get("/__local/" + token + "/page.html"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<h1>ok</h1>") {
		t.Fatalf("serve index: code=%d body=%q", rec.Code, rec.Body.String())
	}
	if rec := get("/__local/" + token + "/assets/app.css"); rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("serve css: code=%d headers=%v", rec.Code, rec.Header())
	}
	if rec := get("/__local/" + token + "/../secret-preview.txt"); rec.Code == http.StatusOK {
		t.Fatalf("traversal should be blocked, got %d", rec.Code)
	}
	if rec := get("/__local/badtoken/page.html"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown token: code=%d", rec.Code)
	}
	if rec := get("/app.css"); rec.Code != http.StatusTeapot {
		t.Fatalf("non-preview path should fall through: code=%d", rec.Code)
	}
}

// 视频视图靠这条通道播放：拖进度条时前端发 Range，必须拿到 206 + Content-Range
// （全靠 http.ServeFile 的实现，换成自己读文件就会退化成「只能从头播」）。
func TestPreviewAssetRangeRequest(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clip.mp4"), []byte("0123456789abcdef"), 0o644); err != nil {
		t.Fatal(err)
	}
	token, err := Register(root)
	if err != nil || token == "" {
		t.Fatalf("register: token=%q err=%v", token, err)
	}
	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	req := httptest.NewRequest(http.MethodGet, "/__local/"+token+"/clip.mp4", nil)
	req.Header.Set("Range", "bytes=4-7")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("range 请求应回 206，got %d", rec.Code)
	}
	if body := rec.Body.String(); body != "4567" {
		t.Fatalf("range 正文 = %q", body)
	}
	if cr := rec.Header().Get("Content-Range"); !strings.Contains(cr, "bytes 4-7/16") {
		t.Fatalf("Content-Range = %q", cr)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "video/mp4") {
		t.Fatalf("Content-Type = %q", ct)
	}

	// <video> 打开时先探测元数据：HEAD 同样要通
	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/__local/"+token+"/clip.mp4", nil))
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD 应回 200，got %d", head.Code)
	}
	if n := head.Header().Get("Content-Length"); n != "16" {
		t.Fatalf("HEAD Content-Length = %q", n)
	}
}
