package sessionstore

// sessionstore_workspace_test.go：ResolveSessionWorkspace（会话 → 归属工作区）。
// CLI --ai-session 转发（根包 secondInstancePlan）的数据源：桶化按 id 扫桶定位、
// meta.workspace 为归属真源；meta 缺失时从正文 header 兜底。

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// seedHeaderBody 写只含 header 行的正文（AppendWithCreate 不写 meta.json）。
func seedHeaderBody(t *testing.T, store *Store, id, workspace string) {
	t.Helper()
	header := `{"v":1,"t":"header","id":"` + id + `","title":"T","createdAt":1,"workspace":"` + workspace + `"}`
	if err := store.AppendWithCreate(id, header+"\n", true); err != nil {
		t.Fatal(err)
	}
}

func TestResolveSessionWorkspaceFromMeta(t *testing.T) {
	store := NewBucketed(t.TempDir())
	seedHeaderBody(t, store, "ws-1", "D:/header-fallback")
	if err := store.WriteMeta("ws-1", `{"workspace":"D:/proj"}`); err != nil {
		t.Fatal(err)
	}
	ws, err := store.ResolveSessionWorkspace("ws-1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if ws != "D:/proj" {
		t.Fatalf("workspace = %q, want meta 真源 D:/proj", ws)
	}
}

func TestResolveSessionWorkspaceFallbackFromHeader(t *testing.T) {
	// meta.json 缺失：sessionMetaRaw 从正文 header 兜底拿 workspace。
	store := NewBucketed(t.TempDir())
	seedHeaderBody(t, store, "ws-2", "D:/only-header")
	if err := store.WriteMeta("ws-2", `{"workspace":"D:/to-be-removed"}`); err != nil {
		t.Fatal(err)
	}
	dir, err := store.resolveBucketedDir("ws-2")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, aiSessionMetaName)); err != nil {
		t.Fatal(err)
	}
	ws, err := store.ResolveSessionWorkspace("ws-2")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if ws != "D:/only-header" {
		t.Fatalf("workspace = %q, want header 兜底 D:/only-header", ws)
	}
}

func TestResolveSessionWorkspaceFlatLayout(t *testing.T) {
	store := New(t.TempDir())
	seedHeaderBody(t, store, "flat-1", "C:/flat")
	if err := store.WriteMeta("flat-1", `{"workspace":"C:/flat-meta"}`); err != nil {
		t.Fatal(err)
	}
	ws, err := store.ResolveSessionWorkspace("flat-1")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if ws != "C:/flat-meta" {
		t.Fatalf("workspace = %q, want C:/flat-meta", ws)
	}
}

func TestResolveSessionWorkspaceErrors(t *testing.T) {
	store := NewBucketed(t.TempDir())
	seedHeaderBody(t, store, "ws-3", "D:/proj")
	cases := []struct {
		name string
		id   string
	}{
		{"gone", "ws-404"},
		{"empty", ""},
		{"invalid-id", "../escape"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := store.ResolveSessionWorkspace(tc.id)
			if err == nil {
				t.Fatalf("ResolveSessionWorkspace(%q) 应报错", tc.id)
			}
			if !errors.Is(err, ErrSessionGone) && !strings.Contains(err.Error(), "会话") {
				t.Fatalf("错误应语义化为会话缺失/无工作区：%v", err)
			}
		})
	}
	// meta 与 header 都无 workspace：会话在、归属未知 → 明确报错（调用方回退前置）。
	seedHeaderBody(t, store, "ws-4", "")
	if err := store.WriteMeta("ws-4", `{"title":"无归属"}`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResolveSessionWorkspace("ws-4"); err == nil {
		t.Fatal("无 workspace 的会话应报错")
	}
	// 绝不建目录：解析不存在会话后根下不应出现新会话目录。
	entries, _ := os.ReadDir(store.Root)
	for _, entry := range entries {
		if entry.IsDir() && isBucketDirName(entry.Name()) {
			sessions, _ := os.ReadDir(filepath.Join(store.Root, entry.Name()))
			for _, s := range sessions {
				if s.Name() == "ws-404" {
					t.Fatal("解析失败路径不应创建会话目录")
				}
			}
		}
	}
}
