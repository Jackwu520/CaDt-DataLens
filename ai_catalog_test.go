package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleCatalog = `{"version":"2026.11.15","models":[{"id":"deepseek-chat","contextWindow":131072}]}`

func TestModelCatalogFileRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "model-catalog.json")
	blob, err := readModelCatalogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if blob.Text != "" || blob.FetchedAt != 0 {
		t.Fatalf("缺失文件应返回空 blob，得到 %+v", blob)
	}
	written, err := writeModelCatalogFile(path, sampleCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if written.Text != sampleCatalog {
		t.Fatalf("写入回读不一致：%q", written.Text)
	}
	if written.FetchedAt <= 0 {
		t.Fatalf("FetchedAt 应为正数，得到 %d", written.FetchedAt)
	}
	again, err := readModelCatalogFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if again.Text != sampleCatalog || again.FetchedAt != written.FetchedAt {
		t.Fatalf("缓存回读不一致：%+v", again)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("临时文件未清理：%s", entry.Name())
		}
	}
}

func TestFetchModelCatalogRejectsBadInput(t *testing.T) {
	// 非 http(s) 一律拒绝：本地文件不该被当成「配置表」
	if _, err := fetchModelCatalog(context.Background(), "file:///C:/windows/win.ini"); err == nil {
		t.Fatal("file:// 应被拒绝")
	}
	if _, err := fetchModelCatalog(context.Background(), "  "); err == nil {
		t.Fatal("空地址应被拒绝")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			_, _ = w.Write([]byte(sampleCatalog))
		case "/html":
			_, _ = w.Write([]byte("<html>not json</html>"))
		case "/empty":
			_, _ = w.Write([]byte(`{"version":"x","models":[]}`))
		case "/noid":
			_, _ = w.Write([]byte(`{"models":[{"contextWindow":1}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	text, err := fetchModelCatalog(context.Background(), server.URL+"/ok")
	if err != nil {
		t.Fatalf("合法响应应通过：%v", err)
	}
	if text != sampleCatalog {
		t.Fatalf("原文应原样返回，得到 %q", text)
	}
	for _, path := range []string{"/html", "/empty", "/noid", "/missing"} {
		if _, err := fetchModelCatalog(context.Background(), server.URL+path); err == nil {
			t.Fatalf("%s 应被拒绝", path)
		}
	}
}

func TestValidateModelCatalog(t *testing.T) {
	if err := validateModelCatalog(sampleCatalog); err != nil {
		t.Fatalf("合法表被拒：%v", err)
	}
	// 没有 version 也允许（远端表可以不标版本），但没有 models 或没有 id 不行
	if err := validateModelCatalog(`{"models":[{"id":"a"}]}`); err != nil {
		t.Fatalf("缺 version 应允许：%v", err)
	}
	if err := validateModelCatalog(`{"models":[]}`); err == nil {
		t.Fatal("空 models 应被拒")
	}
	if err := validateModelCatalog(`[]`); err == nil {
		t.Fatal("顶层不是对象应被拒")
	}
}
