package search

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func writeSearchFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func previewMatch(h SearchHit) string {
	units := utf16.Encode([]rune(h.Preview))
	if h.MatchStart < 0 || h.MatchEnd > len(units) || h.MatchStart > h.MatchEnd {
		return ""
	}
	return string(utf16.Decode(units[h.MatchStart:h.MatchEnd]))
}

func TestSearchWorkspace(t *testing.T) {
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "hello world\nHello TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, "sub", "b.go"), "x = TrimSpace(y) // TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, "node_modules", "ignored.js"), "TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, ".git", "config"), "TrimSpace\n")
	writeSearchFile(t, filepath.Join(dir, "image.dat"), "TrimSpace\x00binary\n")

	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "trimsPACE", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 3 {
		t.Fatalf("expected 3 hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	if res.Files != 2 {
		t.Fatalf("expected 2 scanned files, got %d", res.Files)
	}
	first := res.Hits[0]
	if first.Name != "a.txt" || first.Line != 2 || first.Column != 7 || first.Length != 9 {
		t.Fatalf("unexpected first hit: %+v", first)
	}
	if first.Dir != filepath.Base(dir) {
		t.Fatalf("unexpected root dir label: %q", first.Dir)
	}
	if got := previewMatch(first); got != "TrimSpace" {
		t.Fatalf("preview match slice = %q (preview %q)", got, first.Preview)
	}
	for _, hit := range res.Hits[1:] {
		if hit.Name != "b.go" || hit.Dir != "sub" || previewMatch(hit) != "TrimSpace" {
			t.Fatalf("unexpected nested hit: %+v", hit)
		}
	}

	sensitive, err := app.SearchWorkspace(dir, "trimsPACE", true, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sensitive.Hits) != 0 {
		t.Fatalf("expected no case-sensitive hits, got %d", len(sensitive.Hits))
	}
}

func TestSearchWorkspaceLimitAndUnicode(t *testing.T) {
	dir := t.TempDir()
	content := "中文TrimSpace结束\n"
	writeSearchFile(t, filepath.Join(dir, "zh.txt"), content)
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "TrimSpace", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", len(res.Hits))
	}
	hit := res.Hits[0]
	if hit.Column != 3 || hit.Length != 9 {
		t.Fatalf("unexpected column/length: %+v", hit)
	}
	if got := previewMatch(hit); got != "TrimSpace" {
		t.Fatalf("preview match slice = %q", got)
	}

	many := ""
	for i := 0; i < 50; i++ {
		many += "TrimSpace\n"
	}
	writeSearchFile(t, filepath.Join(dir, "many.txt"), many)
	limited, err := app.SearchWorkspace(dir, "TrimSpace", false, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited.Hits) != 5 || !limited.Truncated {
		t.Fatalf("expected 5 truncated hits, got %d truncated=%v", len(limited.Hits), limited.Truncated)
	}
}

func TestSearchWorkspaceLongPreview(t *testing.T) {
	dir := t.TempDir()
	long := ""
	for i := 0; i < 400; i++ {
		long += "x"
	}
	long += "Needle" + long
	writeSearchFile(t, filepath.Join(dir, "long.txt"), long+"\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "Needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("expected 1 hit, got %d", len(res.Hits))
	}
	hit := res.Hits[0]
	if got := previewMatch(hit); got != "Needle" {
		t.Fatalf("preview match slice = %q", got)
	}
	if hit.MatchStart == 0 || hit.MatchEnd >= len([]rune(hit.Preview)) {
		t.Fatalf("expected clipped preview with ellipsis, got %q", hit.Preview)
	}
}

func TestSearchWorkspaceParallelDeterministic(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 40; i++ {
		name := filepath.Join(dir, "f"+string(rune('a'+i%26))+string(rune('0'+i/26))+".txt")
		writeSearchFile(t, name, "tick\nTick\ntick\n")
	}
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "tick", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 120 {
		t.Fatalf("expected 120 hits, got %d", len(res.Hits))
	}
	if res.Files != 40 {
		t.Fatalf("expected 40 scanned files, got %d", res.Files)
	}
	for i := 1; i < len(res.Hits); i++ {
		prev, cur := res.Hits[i-1], res.Hits[i]
		if cur.Path < prev.Path || (cur.Path == prev.Path && cur.Line < prev.Line) {
			t.Fatalf("hits not ordered at %d: %+v then %+v", i, prev, cur)
		}
	}
}

func TestIndexFoldASCII(t *testing.T) {
	cases := []struct {
		haystack string
		needle   string
		want     int
	}{
		{"Hello World", "hello", 0},
		{"xxHELLOyy", "hello", 2},
		{"abc", "abd", -1},
		{"中文TrimSpace", "trimspace", 6},
	}
	for _, tc := range cases {
		if got := indexFoldASCII(tc.haystack, tc.needle); got != tc.want {
			t.Fatalf("indexFoldASCII(%q, %q) = %d, want %d", tc.haystack, tc.needle, got, tc.want)
		}
	}
}

func TestSearchWorkspaceBuiltinFallback(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "fallback.txt"), "alphaNeedle\nbetaNeedle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 builtin hits, got %d", len(res.Hits))
	}
	for _, hit := range res.Hits {
		if hit.Name != "fallback.txt" || previewMatch(hit) != "Needle" {
			t.Fatalf("unexpected hit: %+v", hit)
		}
	}
}

func TestSearchFileOnly(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target.go")
	writeSearchFile(t, target, "needle one\nneedle two\n")
	writeSearchFile(t, filepath.Join(dir, "sibling.go"), "needle sibling\n")
	writeSearchFile(t, filepath.Join(dir, "sub", "deep.go"), "needle deep\n")

	app := &Searcher{}
	// 文件根 + FileOnly：只扫该文件（rg 路径与内置路径同语义）
	checkFileOnly := func(label string) {
		t.Helper()
		res, err := app.SearchWorkspaceAdvanced(target, "needle", SearchOptions{FileOnly: true})
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		if len(res.Hits) != 2 {
			t.Fatalf("%s: expected 2 hits, got %d: %+v", label, len(res.Hits), res.Hits)
		}
		for _, hit := range res.Hits {
			if !strings.EqualFold(hit.Path, target) {
				t.Fatalf("%s: hit from another file: %+v", label, hit)
			}
			if hit.Dir != filepath.Base(dir) {
				t.Fatalf("%s: unexpected Dir %q", label, hit.Dir)
			}
		}
	}
	checkFileOnly("rg-or-builtin")
	t.Setenv("DATALENS_NO_RG", "1")
	checkFileOnly("builtin")

	// FileOnly=false 保留历史语义：文件根扩散到父目录
	res, err := app.SearchWorkspaceAdvanced(target, "needle", SearchOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 4 {
		t.Fatalf("legacy file root should scan parent, got %d hits: %+v", len(res.Hits), res.Hits)
	}

	// FileOnly 对目录根无意义：按普通目录扫描
	res, err = app.SearchWorkspaceAdvanced(dir, "needle", SearchOptions{FileOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 4 {
		t.Fatalf("FileOnly with dir root should behave as normal, got %d hits", len(res.Hits))
	}
}

func TestSearchArtifactPathClassifier(t *testing.T) {
	cases := []struct {
		rel  string
		want bool
	}{
		{"src/main.go", false},
		{"README.md", false},
		{"distributions/app.js", false},
		{"notes.mapping", false},
		{"frontend/dist/assets/index-DuKKsrlq.js", true},
		{"build/out.txt", true},
		{"src/vendor/lib.go", true},
		{"a/b/index.min.css", true},
		{".next/server/chunk.js", true},
		{"maps/app.js.map", true},
		{`frontend\dist\assets\index.js`, true},
	}
	for _, tc := range cases {
		if got := searchIsArtifactPath(tc.rel); got != tc.want {
			t.Fatalf("searchIsArtifactPath(%q) = %v, want %v", tc.rel, got, tc.want)
		}
	}
}

func TestSearchArtifactTierAfterSource(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	// dist 字典序在 src 之前；分档后产物命中必须仍排在源码命中之后，
	// 且产物文件名命中也不能越过源码档。
	writeSearchFile(t, filepath.Join(dir, "dist", "needle-bundle.js"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "main.go"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	if res.Hits[0].Name != "main.go" {
		t.Fatalf("expected source hit first, got %+v", res.Hits)
	}
	if res.Hits[1].Name != "needle-bundle.js" {
		t.Fatalf("expected artifact hit last, got %+v", res.Hits)
	}
	if res.ArtifactSkipped {
		t.Fatalf("artifact pass ran, ArtifactSkipped must stay false")
	}
}

func TestSearchNameHitSortsFirstInTier(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a-notes.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "z-needle.txt"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 hits, got %d", len(res.Hits))
	}
	if res.Hits[0].Name != "z-needle.txt" {
		t.Fatalf("expected name-hit file first, got %+v", res.Hits)
	}
}

func TestSearchSourceTierFillsCapFirst(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "b.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "dist", "bundle.js"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 || !res.Truncated {
		t.Fatalf("expected 2 truncated hits, got %d truncated=%v", len(res.Hits), res.Truncated)
	}
	if !res.ArtifactSkipped {
		t.Fatalf("source tier filled the cap, ArtifactSkipped must be true")
	}
	for _, hit := range res.Hits {
		if searchIsArtifactPath(hit.Dir) {
			t.Fatalf("artifact hit must not crowd out source tier: %+v", res.Hits)
		}
	}
}

func TestSearchRgArtifactSkippedFlag(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 ripgrep，跳过 rg 路径")
	}
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "b.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "dist", "bundle.js"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 || !res.Truncated || !res.ArtifactSkipped {
		t.Fatalf("expected 2 truncated source hits with ArtifactSkipped, got %+v", res)
	}
}

func TestSearchRgArtifactTierAndNameHit(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 ripgrep，跳过 rg 路径")
	}
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "dist", "bundle.js"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "main.go"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "a-notes.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "z-needle.txt"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 4 {
		t.Fatalf("expected 4 rg hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	if res.Hits[0].Name != "z-needle.txt" {
		t.Fatalf("expected name-hit file first, got %+v", res.Hits)
	}
	if last := res.Hits[3]; !searchIsArtifactPath(last.Dir) {
		t.Fatalf("expected artifact hit last, got %+v", res.Hits)
	}
}

// ---------- AI 隔离 worktree 跳过（SkipPath） ----------

func TestSkipPath(t *testing.T) {
	cases := []struct {
		rel  string
		want bool
	}{
		{".cadt/worktree", true},
		{".cadt/worktree/x", true},
		{".cadt/worktree/x/src/a.js", true},
		{".CADT/WORKTREE/X/a.js", true},    // Windows 语义大小写不敏感
		{".cadt\\worktree\\x\\a.js", true}, // 反斜杠归一
		{".cadt/worktree-x/a.js", false},   // 不误伤同名前缀目录
		{".cadtworktree/x", false},         // 不误伤无分隔前缀
		{".cadt/tmp/a.md", false},          // AI 中间产物保持可搜
		{".cadt/logs/2026/11/INDEX.md", false},
		{".cadt/memory", false},
		{"src/main.go", false},
		{"", false},  // 根自身（从 worktree 内发起检索）
		{".", false}, // 根自身
	}
	for _, c := range cases {
		if got := SkipPath(c.rel); got != c.want {
			t.Fatalf("SkipPath(%q) = %v, want %v", c.rel, got, c.want)
		}
	}
}

// worktree 检出副本不进检索结果；从 worktree 自身发起的检索照常工作。
// 内置扫描路径（DATALENS_NO_RG=1）。
func TestSearchWorkspaceSkipsWorktreeBuiltin(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "worktree", "x", "a.js"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "tmp", "note.md"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("worktree 副本应被跳过（tmp 保留），got %d: %+v", len(res.Hits), res.Hits)
	}
	for _, hit := range res.Hits {
		if strings.Contains(hit.Path, "worktree") {
			t.Fatalf("worktree 命中泄漏：%+v", hit)
		}
	}
	// 从 worktree 内发起：rel 不命中，照常搜索
	res, err = app.SearchWorkspace(filepath.Join(dir, ".cadt", "worktree", "x"), "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("worktree 内检索应正常工作，got %d", len(res.Hits))
	}
}

func TestSearchWorkspaceSkipsWorktreeRg(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("未安装 ripgrep，跳过 rg 路径")
	}
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "worktree", "x", "a.js"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 || strings.Contains(res.Hits[0].Path, "worktree") {
		t.Fatalf("rg 路径应跳过 worktree 副本：%+v", res.Hits)
	}
}

func TestFindFilesSkipsWorktree(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.go"), "package main\n")
	writeSearchFile(t, filepath.Join(dir, ".cadt", "worktree", "x", "b.go"), "package wt\n")
	app := &Searcher{}
	res, err := app.FindFiles(dir, "*.go", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Path != "a.go" {
		t.Fatalf("glob 应跳过 worktree：%+v", res.Files)
	}
	res, err = app.FindFiles(filepath.Join(dir, ".cadt", "worktree", "x"), "*.go", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Name != "b.go" {
		t.Fatalf("worktree 内 glob 应正常工作：%+v", res.Files)
	}
}
