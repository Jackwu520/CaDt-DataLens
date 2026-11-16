package main

import (
	"os"
	"strings"
	"testing"

	"datalens/internal/applog"
)

func TestLogFrontendLevelGate(t *testing.T) {
	path, err := applog.OpenAt(t.TempDir())
	if err != nil {
		t.Fatalf("OpenAt: %v", err)
	}
	defer applog.Close()
	defer applog.SetDevMode(false)

	applog.SetDevMode(false)
	app := &App{}
	app.LogFrontend("info", "隐藏的 info")
	app.LogFrontend("debug", "隐藏的 debug")
	app.LogFrontend("warning", "保留的警告")
	app.LogFrontend("error", "保留的错误")
	raw, _ := os.ReadFile(path)
	text := string(raw)
	if strings.Contains(text, "隐藏的") {
		t.Fatalf("开发者模式关闭时不应记录 info/debug：\n%s", text)
	}
	if !strings.Contains(text, "[WARN] 保留的警告") || !strings.Contains(text, "[ERROR] 保留的错误") {
		t.Fatalf("警告/错误应始终记录：\n%s", text)
	}

	applog.SetDevMode(true)
	app.LogFrontend("info", "可见的 info")
	app.LogFrontend("debug", "可见的 debug")
	raw, _ = os.ReadFile(path)
	text = string(raw)
	if !strings.Contains(text, "[INFO] 可见的 info") || !strings.Contains(text, "[DEBUG] 可见的 debug") {
		t.Fatalf("开发者模式开启后应记录 info/debug：\n%s", text)
	}
	if got := app.GetDeveloperMode(); !got {
		t.Fatal("GetDeveloperMode 应返回 true")
	}
}
