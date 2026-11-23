package appdata

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
)

// RootAt 只拼路径、不碰磁盘；空 configDir 表示系统配置目录不可用 → 空。
func TestRootAt(t *testing.T) {
	if got := RootAt(""); got != "" {
		t.Fatalf("空 configDir 应返回空串，得到 %q", got)
	}
	cfg := filepath.Join("C:", "Users", "u", "AppData", "Roaming")
	want := filepath.Join(cfg, "CandySweet", "CaDt-DataLens")
	if got := RootAt(cfg); got != want {
		t.Fatalf("RootAt = %q，期望 %q", got, want)
	}
}

// ErrNoRoot 是对外契约：各包共用同一句文案，调用方还能 errors.Is 判定（包裹后仍命中）。
func TestErrNoRoot(t *testing.T) {
	if got := ErrNoRoot.Error(); got != "无法定位应用数据目录" {
		t.Fatalf("ErrNoRoot 文案变了（各包与文档都按这句对齐）：%q", got)
	}
	wrapped := fmt.Errorf("读取 mcp.json 失败：%w", ErrNoRoot)
	if !errors.Is(wrapped, ErrNoRoot) {
		t.Fatal("包裹后的错误应仍能 errors.Is 命中 ErrNoRoot")
	}
}
