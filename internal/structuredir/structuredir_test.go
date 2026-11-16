package structuredir

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTestFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestStructureDirFormat(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"sub", "a2", "a10", "b", ".git", "__pycache__"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0755); err != nil {
			t.Fatal(err)
		}
	}
	writeTestFile(t, filepath.Join(root, "sub", "inner.txt"))
	writeTestFile(t, filepath.Join(root, "sub", "zz.txt"))
	writeTestFile(t, filepath.Join(root, "a1.txt"))
	writeTestFile(t, filepath.Join(root, "a10.txt"))
	writeTestFile(t, filepath.Join(root, "z.txt"))
	writeTestFile(t, filepath.Join(root, ".git", "ignored.txt"))
	writeTestFile(t, filepath.Join(root, "__pycache__", "cache.pyc"))

	out, err := Render(root)
	if err != nil {
		t.Fatalf("StructureDir: %v", err)
	}
	wantLines := []string{
		filepath.Base(filepath.Clean(root)),
		"├── a2",
		"├── a10",
		"├── b",
		"├── sub",
		"│   ├── inner.txt",
		"│   └── zz.txt",
		"├── a1.txt",
		"├── a10.txt",
		"└── z.txt",
	}
	got := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(got) != len(wantLines) {
		t.Fatalf("line count = %d, want %d\n%s", len(got), len(wantLines), out)
	}
	for i := range wantLines {
		if got[i] != wantLines[i] {
			t.Errorf("line %d = %q, want %q", i+1, got[i], wantLines[i])
		}
	}
	if !strings.HasSuffix(out, "\n") {
		t.Errorf("output should end with newline: %q", out)
	}
	for _, ignored := range []string{".git", "__pycache__", "ignored.txt", "cache.pyc"} {
		if strings.Contains(out, ignored) {
			t.Errorf("ignored entry %q leaked into output", ignored)
		}
	}
}

func TestStructureDirEmpty(t *testing.T) {
	root := t.TempDir()
	out, err := Render(root)
	if err != nil {
		t.Fatalf("StructureDir: %v", err)
	}
	if out != filepath.Base(filepath.Clean(root))+"\n" {
		t.Fatalf("empty dir output = %q", out)
	}
}

func TestStructureDirValidation(t *testing.T) {
	if _, err := Render(""); err == nil || !strings.Contains(err.Error(), "没有目录") {
		t.Fatalf("empty dir error = %v", err)
	}
	if _, err := Render(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing dir should error")
	}
	file := filepath.Join(t.TempDir(), "a.txt")
	writeTestFile(t, file)
	if _, err := Render(file); err == nil || !strings.Contains(err.Error(), "不是目录") {
		t.Fatalf("file path error = %v", err)
	}
}

func TestNaturalLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"a2", "a10", true},
		{"a10", "a2", false},
		{"file2.txt", "file10.txt", true},
		{"A.txt", "b.txt", true},
		{"a", "a1", true},
		{"a1", "a01", true},
		{"a01", "a1", false},
	}
	for _, c := range cases {
		if got := naturalLess(c.a, c.b); got != c.want {
			t.Errorf("naturalLess(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// AI 隔离 worktree（.cadt/worktree）整棵不进导出树（`.cadt/worktree` 目录名本身也不出现）；
// .cadt 其余子目录与从 worktree 自身发起的导出不受影响。
func TestStructureDirSkipsWorktree(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, ".cadt", "memory", "note.md"))
	writeTestFile(t, filepath.Join(root, ".cadt", "worktree", "x", "src", "a.js"))
	writeTestFile(t, filepath.Join(root, ".cadt", "worktree", "x", "b.txt"))
	writeTestFile(t, filepath.Join(root, "main.go"))

	out, err := Render(root)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "worktree") {
		t.Fatalf("worktree 副本泄漏进结构树：\n%s", out)
	}
	if !strings.Contains(out, ".cadt") || !strings.Contains(out, "note.md") || !strings.Contains(out, "main.go") {
		t.Fatalf(".cadt 其余内容应保留：\n%s", out)
	}
	// 从 worktree 自身发起：正常渲染其内容
	wtOut, err := Render(filepath.Join(root, ".cadt", "worktree", "x"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(wtOut, "a.js") || !strings.Contains(wtOut, "b.txt") {
		t.Fatalf("worktree 内导出应正常：\n%s", wtOut)
	}
}
