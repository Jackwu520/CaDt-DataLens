package fsops

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ReadDirTree 对 AI 隔离 worktree（.cadt/worktree）整棵跳过；从 worktree 自身发起的
// 遍历 rel 不命中，照常列出（AI list_dir 隔离区仍可用）。
func TestReadDirTreeSkipsWorktree(t *testing.T) {
	root := t.TempDir()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(root, ".cadt", "worktree", "x", "src"), 0o755))
	must(os.MkdirAll(filepath.Join(root, ".cadt", "tmp"), 0o755))
	for _, p := range []string{
		filepath.Join(root, ".cadt", "memory", "note.md"),
		filepath.Join(root, ".cadt", "worktree", "x", "src", "a.js"),
		filepath.Join(root, ".cadt", "tmp", "scratch.md"),
		filepath.Join(root, "main.go"),
	} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		must(os.WriteFile(p, []byte("x"), 0o644))
	}
	fs := &FS{}
	listing, err := fs.ReadDirTree(root, 8)
	if err != nil {
		t.Fatal(err)
	}
	text := dirTreeDump(listing.Root)
	if strings.Contains(text, "worktree") {
		t.Fatalf("worktree 副本泄漏进 list_dir 树：\n%s", text)
	}
	if !strings.Contains(text, ".cadt") || !strings.Contains(text, "note.md") || !strings.Contains(text, "scratch.md") {
		t.Fatalf(".cadt 其余内容应保留：\n%s", text)
	}
	// 从 worktree 自身发起
	listing, err = fs.ReadDirTree(filepath.Join(root, ".cadt", "worktree", "x"), 4)
	if err != nil {
		t.Fatal(err)
	}
	text = dirTreeDump(listing.Root)
	if !strings.Contains(text, "src") || !strings.Contains(text, "a.js") {
		t.Fatalf("worktree 内遍历应正常：\n%s", text)
	}
}

func dirTreeDump(node *DirTreeNode) string {
	if node == nil {
		return ""
	}
	out := node.Name
	for _, child := range node.Children {
		out += "\n" + dirTreeDump(child)
	}
	return out
}
