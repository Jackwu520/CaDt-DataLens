package search

import (
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// 高级检索（AI search_text 一期 + 二期）的双路径护栏。
// 两条路径必须行为一致：rg 路径仅在用户机器装了 rg 时才跑，内置路径永远跑。
// 差异只比较「命中的文件 / 行 / 匹配文本 / 前后文」，不比较内部路径前缀与截断标记。

type advancedHitKey struct {
	name   string
	line   int
	match  string
	before string
	after  string
}

func normalizeAdvancedHits(hits []SearchHit) []advancedHitKey {
	out := make([]advancedHitKey, 0, len(hits))
	for _, h := range hits {
		key := advancedHitKey{
			name:  h.Name,
			line:  h.Line,
			match: previewMatch(h),
		}
		for _, c := range h.Before {
			key.before += c.Text + "|"
		}
		for _, c := range h.After {
			key.after += c.Text + "|"
		}
		out = append(out, key)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].name != out[j].name {
			return out[i].name < out[j].name
		}
		return out[i].line < out[j].line
	})
	return out
}

// dualPathSearch 依次用内置路径与（若可用）rg 路径跑同一组参数。
func dualPathSearch(t *testing.T, root, query string, opts SearchOptions, want []advancedHitKey) {
	t.Helper()
	t.Run("builtin", func(t *testing.T) {
		t.Setenv("DATALENS_NO_RG", "1")
		res, err := (&Searcher{}).SearchWorkspaceAdvanced(root, query, opts)
		if err != nil {
			t.Fatal(err)
		}
		got := normalizeAdvancedHits(res.Hits)
		assertAdvancedHits(t, got, want)
	})
	t.Run("rg", func(t *testing.T) {
		if _, err := exec.LookPath("rg"); err != nil {
			t.Skip("未安装 rg，跳过双路径对拍")
		}
		t.Setenv("DATALENS_NO_RG", "")
		res, err := (&Searcher{}).SearchWorkspaceAdvanced(root, query, opts)
		if err != nil {
			t.Fatal(err)
		}
		got := normalizeAdvancedHits(res.Hits)
		assertAdvancedHits(t, got, want)
	})
}

func assertAdvancedHits(t *testing.T, got, want []advancedHitKey) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("命中数 = %d，期望 %d：%+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 条命中 = %+v，期望 %+v", i, got[i], want[i])
		}
	}
}

func advancedFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.go"), "line before\nfoo(bar) and foo\nline after\n")
	writeSearchFile(t, filepath.Join(dir, "b.go"), "foobar foobar\nneedle\n")
	writeSearchFile(t, filepath.Join(dir, "tests", "a.test.go"), "foo(bar) in test\n")
	writeSearchFile(t, filepath.Join(dir, "notes.md"), "foo foo\n")
	return dir
}

func TestAdvancedRegex(t *testing.T) {
	dir := advancedFixture(t)
	dualPathSearch(t, dir, `foo\(bar\)`, SearchOptions{Regex: true}, []advancedHitKey{
		{name: "a.go", line: 2, match: "foo(bar)"},
		{name: "a.test.go", line: 1, match: "foo(bar)"},
	})
	// 字面量模式下同样的 pattern 一条都不该命中
	t.Setenv("DATALENS_NO_RG", "1")
	res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, `foo\(bar\)`, SearchOptions{})
	if err != nil || len(res.Hits) != 0 {
		t.Fatalf("字面量模式不应命中正则 pattern：%+v err=%v", res, err)
	}
}

func TestAdvancedWholeWord(t *testing.T) {
	dir := advancedFixture(t)
	dualPathSearch(t, dir, "foo", SearchOptions{WholeWord: true}, []advancedHitKey{
		{name: "a.go", line: 2, match: "foo"},
		{name: "a.go", line: 2, match: "foo"}, // "foo(bar) and foo"
		{name: "a.test.go", line: 1, match: "foo"},
		{name: "notes.md", line: 1, match: "foo"},
		{name: "notes.md", line: 1, match: "foo"},
	})
}

func TestAdvancedExcludePattern(t *testing.T) {
	dir := advancedFixture(t)
	dualPathSearch(t, dir, "foo", SearchOptions{ExcludePattern: "*.test.go"}, []advancedHitKey{
		{name: "a.go", line: 2, match: "foo"},
		{name: "a.go", line: 2, match: "foo"},
		{name: "b.go", line: 1, match: "foo"},
		{name: "b.go", line: 1, match: "foo"},
		{name: "notes.md", line: 1, match: "foo"},
		{name: "notes.md", line: 1, match: "foo"},
	})
}

func TestAdvancedRegexPlusWholeWord(t *testing.T) {
	dir := advancedFixture(t)
	dualPathSearch(t, dir, "foo|needle", SearchOptions{Regex: true, WholeWord: true}, []advancedHitKey{
		{name: "a.go", line: 2, match: "foo"},
		{name: "a.go", line: 2, match: "foo"},
		{name: "a.test.go", line: 1, match: "foo"},
		{name: "b.go", line: 2, match: "needle"},
		{name: "notes.md", line: 1, match: "foo"},
		{name: "notes.md", line: 1, match: "foo"},
	})
}

func TestAdvancedMaxResults(t *testing.T) {
	dir := advancedFixture(t)
	t.Setenv("DATALENS_NO_RG", "1")
	res, err := (&Searcher{}).SearchWorkspaceAdvanced(dir, "foo", SearchOptions{MaxResults: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 || !res.Truncated {
		t.Fatalf("maxResults=2 应得 2 条且截断，got %d truncated=%v", len(res.Hits), res.Truncated)
	}
	// 上界钳到 1000，不报错
	res, err = (&Searcher{}).SearchWorkspaceAdvanced(dir, "foo", SearchOptions{MaxResults: 5000})
	if err != nil || len(res.Hits) == 0 {
		t.Fatalf("maxResults 超上界应回落，got %d err=%v", len(res.Hits), err)
	}
}

// ---------- 二期：outputMode / context ----------

func TestAdvancedContext(t *testing.T) {
	dir := advancedFixture(t)
	dualPathSearch(t, dir, "foo", SearchOptions{Context: 1, ExcludePattern: "*.test.go", MaxResults: 100}, []advancedHitKey{
		{name: "a.go", line: 2, match: "foo", before: "line before|", after: "line after|"},
		{name: "a.go", line: 2, match: "foo", before: "line before|", after: "line after|"},
		{name: "b.go", line: 1, match: "foo", before: "", after: "needle|"},
		{name: "b.go", line: 1, match: "foo", before: "", after: "needle|"},
		{name: "notes.md", line: 1, match: "foo"},
		{name: "notes.md", line: 1, match: "foo"},
	})
}

func TestAdvancedOutputModeFilesAndCount(t *testing.T) {
	dir := advancedFixture(t)
	// 内置路径逐项断言（rg 路径同参数对拍在下面）
	t.Setenv("DATALENS_NO_RG", "1")
	app := &Searcher{}
	wantFiles := []string{
		filepath.Join(dir, "a.go"),
		filepath.Join(dir, "b.go"),
		filepath.Join(dir, "notes.md"),
		filepath.Join(dir, "tests", "a.test.go"),
	}
	sort.Strings(wantFiles)
	files, err := app.SearchWorkspaceAdvanced(dir, "foo", SearchOptions{OutputMode: "files", MaxResults: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(files.Hits) != 0 || len(files.FileList) != len(wantFiles) {
		t.Fatalf("files 模式应只有文件清单：hits=%d files=%v", len(files.Hits), files.FileList)
	}
	gotFiles := append([]string(nil), files.FileList...)
	sort.Strings(gotFiles)
	for i := range wantFiles {
		if gotFiles[i] != wantFiles[i] {
			t.Fatalf("files 清单 %d = %q，期望 %q", i, gotFiles[i], wantFiles[i])
		}
	}
	counts, err := app.SearchWorkspaceAdvanced(dir, "foo", SearchOptions{OutputMode: "count", MaxResults: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(counts.Hits) != 0 || len(counts.Counts) != len(wantFiles) {
		t.Fatalf("count 模式应只有计数：hits=%d counts=%+v", len(counts.Hits), counts.Counts)
	}
	byPath := map[string]int{}
	for _, c := range counts.Counts {
		byPath[c.Path] = c.Count
	}
	if byPath[filepath.Join(dir, "b.go")] != 2 || byPath[filepath.Join(dir, "notes.md")] != 2 {
		t.Fatalf("count 计数不对：%+v", byPath)
	}

	// rg 可用时，对拍 files/count 两种输出形态
	if _, err := exec.LookPath("rg"); err == nil {
		t.Setenv("DATALENS_NO_RG", "")
		rgFiles, err := app.SearchWorkspaceAdvanced(dir, "foo", SearchOptions{OutputMode: "files", MaxResults: 100})
		if err != nil || len(rgFiles.FileList) != len(wantFiles) {
			t.Fatalf("rg files 模式与内置路径漂移：%+v err=%v", rgFiles, err)
		}
		rgCounts, err := app.SearchWorkspaceAdvanced(dir, "foo", SearchOptions{OutputMode: "count", MaxResults: 100})
		if err != nil || len(rgCounts.Counts) != len(wantFiles) {
			t.Fatalf("rg count 模式与内置路径漂移：%+v err=%v", rgCounts, err)
		}
	}
}

func TestAdvancedOptionsClampAndErrors(t *testing.T) {
	dir := advancedFixture(t)
	t.Setenv("DATALENS_NO_RG", "1")
	app := &Searcher{}
	if _, err := app.SearchWorkspaceAdvanced(dir, "foo", SearchOptions{Regex: true, OutputMode: "bogus"}); err == nil {
		t.Fatal("非法 outputMode 应报错")
	}
	if _, err := app.SearchWorkspaceAdvanced(dir, "(", SearchOptions{Regex: true}); err == nil {
		t.Fatal("非法正则应报错")
	}
	// context 上界钳到 3，不报错
	res, err := app.SearchWorkspaceAdvanced(dir, "foo", SearchOptions{Context: 99, ExcludePattern: "*.test.go", MaxResults: 100})
	if err != nil || len(res.Hits) == 0 {
		t.Fatalf("context 超上界应回落：%+v err=%v", res, err)
	}
	for _, hit := range res.Hits {
		if len(hit.Before) > 3 || len(hit.After) > 3 {
			t.Fatalf("context 未被钳到 3：%+v", hit)
		}
	}
	// 旧入口零值兼容
	legacy, err := app.SearchWorkspaceAdvanced(dir, "needle", SearchOptions{})
	if err != nil || len(legacy.Hits) != 1 || strings.ToLower(legacy.Hits[0].Name) != "b.go" {
		t.Fatalf("零选项应与老入口一致：%+v err=%v", legacy, err)
	}
}
