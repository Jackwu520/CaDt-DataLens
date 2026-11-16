package applog

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWritesAndPrunes(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 25; i++ {
		name := fmt.Sprintf("2020-01-01_00-00-%02d.txt", i)
		if err := os.WriteFile(filepath.Join(dir, name), []byte("old"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	path, err := OpenAt(dir)
	if err != nil {
		t.Fatalf("OpenAt: %v", err)
	}
	defer Close()

	Write("error", "测试错误 %d", 42)
	Write("warn", "第一行\n第二行")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取日志：%v", err)
	}
	text := string(raw)
	for _, want := range []string{"[ERROR] 测试错误 42", "[WARN] 第一行", "[WARN] 第二行"} {
		if !strings.Contains(text, want) {
			t.Fatalf("日志缺少 %q：\n%s", want, text)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".txt") {
			count++
		}
	}
	if count != keep {
		t.Fatalf("日志保留 %d 个，期望 %d", count, keep)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("本次日志被误删：%v", err)
	}
	if got := FilePath(); got != path {
		t.Fatalf("FilePath = %q, want %q", got, path)
	}
}

func TestDevModeToggle(t *testing.T) {
	SetDevMode(true)
	defer SetDevMode(false)
	if !DevMode() {
		t.Fatal("DevMode 应为 true")
	}
	if got := OnOff(false); got != "关闭" {
		t.Fatalf("OnOff(false) = %q", got)
	}
}
