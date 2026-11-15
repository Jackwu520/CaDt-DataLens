package main

import (
	"os"
	"path/filepath"
	"testing"
)

// globMatchPath 的用例与前端 ai-file-tools.test.mjs 的 globMatchPath 对齐：
// 语义改动必须同时改两边（AI 的 glob 工具与 search_text 的 filePattern 共用这一套规则）。
func TestGlobMatchPath(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		rel     string
		file    string
		want    bool
	}{
		{"空模式全匹配", "", "src/main.js", "main.js", true},
		{"文件名通配", "*.go", "src/main.go", "main.go", true},
		{"文件名通配不跨类型", "*.go", "src/main.js", "main.js", false},
		{"单星不跨目录", "src/*.js", "src/a/b.js", "b.js", false},
		{"单星匹配一层", "src/*.js", "src/b.js", "b.js", true},
		{"双星跨目录", "src/**/*.js", "src/a/b/c.js", "c.js", true},
		{"双星段可为空", "src/**/*.js", "src/c.js", "c.js", true},
		{"问号单字符", "a?.go", "a1.go", "a1.go", true},
		{"问号不吃两字符", "a?.go", "a12.go", "a12.go", false},
		{"大小写不敏感", "README.MD", "readme.md", "readme.md", true},
		{"反斜杠路径归一", "src/*.go", "src\\main.go", "main.go", true},
		{"只给模式名匹配文件名", "main.js", "deep/dir/main.js", "main.js", true},
		{"含斜杠按相对路径", "dir/main.js", "other/dir/main.js", "main.js", false},
		{"点号不当正则元字符", "a.b", "axb", "axb", false},
		{"括号不当正则元字符", "a(1).go", "a(1).go", "a(1).go", true},
		{"尾部通配", "build*", "build-output.txt", "build-output.txt", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := globMatchPath(tc.pattern, tc.rel, tc.file); got != tc.want {
				t.Fatalf("globMatchPath(%q, %q, %q) = %v, want %v", tc.pattern, tc.rel, tc.file, got, tc.want)
			}
		})
	}
}

func TestFindFiles(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, body string) {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	write("a.go", "package a\n")
	write("src/b.go", "package b\n")
	write("src/c.js", "console.log(1)\n")
	write("node_modules/skip/d.go", "package d\n")
	write(".git/HEAD", "ref: refs/heads/main\n")

	app := &App{}
	res, err := app.FindFiles(dir, "*.go", 0)
	if err != nil {
		t.Fatalf("FindFiles: %v", err)
	}
	got := make([]string, 0, len(res.Files))
	for _, file := range res.Files {
		got = append(got, file.Path)
	}
	want := []string{"a.go", "src/b.go"}
	if len(got) != len(want) {
		t.Fatalf("命中文件 = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("命中文件 = %v, want %v（应按路径排序）", got, want)
		}
	}
	if res.Files[1].Dir != "src" {
		t.Fatalf("dir 字段应为相对父目录，实际 %q", res.Files[1].Dir)
	}
	if res.Files[0].Name != "a.go" || res.Files[0].Size == 0 {
		t.Fatalf("name/size 字段缺失：%+v", res.Files[0])
	}
	for _, file := range res.Files {
		if file.Path == "node_modules/skip/d.go" || file.Path == ".git/HEAD" {
			t.Fatalf("跳过目录不该被列出：%s", file.Path)
		}
	}
	if res.Truncated {
		t.Fatalf("未到上限不该标截断")
	}
}

func TestFindFilesLimitAndEmptyPattern(t *testing.T) {
	dir := t.TempDir()
	for _, rel := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(dir, rel), []byte("x"), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	app := &App{}
	limited, err := app.FindFiles(dir, "*.txt", 2)
	if err != nil {
		t.Fatalf("FindFiles: %v", err)
	}
	if len(limited.Files) != 2 || !limited.Truncated {
		t.Fatalf("limit=2 应只回 2 条且标截断，实际 %d 条 truncated=%v", len(limited.Files), limited.Truncated)
	}
	// 空模式等价 "*"：列全部文件
	all, err := app.FindFiles(dir, "", 0)
	if err != nil {
		t.Fatalf("FindFiles: %v", err)
	}
	if len(all.Files) != 3 {
		t.Fatalf("空模式应列出全部 3 个文件，实际 %d", len(all.Files))
	}
	if all.Scanned != 3 {
		t.Fatalf("Scanned 应统计遍历文件数，实际 %d", all.Scanned)
	}
}

func TestFindFilesRootErrors(t *testing.T) {
	app := &App{}
	if _, err := app.FindFiles("", "*", 0); err == nil {
		t.Fatal("空根目录应报错")
	}
	if _, err := app.FindFiles(filepath.Join(t.TempDir(), "missing"), "*", 0); err == nil {
		t.Fatal("不存在的目录应报错")
	}
}

func TestSearchWorkspaceFiltered(t *testing.T) {
	dir := t.TempDir()
	files := map[string]string{
		"keep.go":       "needle in go\n",
		"skip.js":       "needle in js\n",
		"src/inner.go":  "needle inner\n",
		"src/inner.txt": "needle text\n",
	}
	for rel, body := range files {
		path := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	app := &App{}
	res, err := app.SearchWorkspaceFiltered(dir, "needle", false, 0, "*.go")
	if err != nil {
		t.Fatalf("SearchWorkspaceFiltered: %v", err)
	}
	seen := map[string]bool{}
	for _, hit := range res.Hits {
		seen[filepath.Base(hit.Path)] = true
		if filepath.Ext(hit.Path) != ".go" {
			t.Fatalf("不该命中非 go 文件：%s", hit.Path)
		}
	}
	if !seen["keep.go"] || !seen["inner.go"] {
		t.Fatalf("应命中两个 go 文件，实际 %v", seen)
	}
	// 无 pattern 时行为不变（等价 SearchWorkspace）
	all, err := app.SearchWorkspaceFiltered(dir, "needle", false, 0, "")
	if err != nil {
		t.Fatalf("SearchWorkspaceFiltered: %v", err)
	}
	if len(all.Hits) != len(files) {
		t.Fatalf("无 pattern 应命中 %d 处，实际 %d", len(files), len(all.Hits))
	}
}
