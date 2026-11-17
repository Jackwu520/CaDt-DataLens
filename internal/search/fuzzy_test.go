package search

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestFuzzyFind(t *testing.T) {
	cases := []struct {
		name          string
		line          string
		needle        string
		caseSensitive bool
		wantStart     int
		wantEnd       int
		wantOK        bool
	}{
		{name: "连续命中", line: "hello needle world", needle: "needle", wantStart: 6, wantEnd: 12, wantOK: true},
		{name: "反向收紧起点", line: "aaab", needle: "ab", wantStart: 2, wantEnd: 4, wantOK: true},
		{name: "跨字符命中", line: "axxxb", needle: "ab", wantStart: 0, wantEnd: 5, wantOK: true},
		{name: "大小写不敏感", line: "GlobalSearch", needle: "gsearch", wantStart: 0, wantEnd: 12, wantOK: true},
		{name: "大小写敏感不命中", line: "GlobalSearch", needle: "gsearch", caseSensitive: true},
		{name: "无匹配", line: "abcdef", needle: "xyz"},
		{name: "中文子序列", line: "中文模糊匹配示例", needle: "模糊示例", wantStart: 6, wantEnd: 24, wantOK: true},
		{name: "单字符", line: "abc", needle: "c", wantStart: 2, wantEnd: 3, wantOK: true},
		{name: "空查询", line: "abc", needle: ""},
		{name: "空行", line: "", needle: "a"},
		{name: "窗口超限", line: "a" + strings.Repeat(".", 300) + "b", needle: "ab"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			start, end, ok := fuzzyFind(tc.line, tc.needle, tc.caseSensitive)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (window [%d,%d))", ok, tc.wantOK, start, end)
			}
			if !ok {
				return
			}
			if start != tc.wantStart || end != tc.wantEnd {
				t.Fatalf("window = [%d,%d), want [%d,%d)", start, end, tc.wantStart, tc.wantEnd)
			}
		})
	}
}

func TestFuzzySubsequence(t *testing.T) {
	if !fuzzySubsequence("hello world", "hwd", false) {
		t.Fatal("expected subsequence match for hwd")
	}
	if fuzzySubsequence("hello world", "dwh", false) {
		t.Fatal("out-of-order needle must not match")
	}
	if !fuzzySubsequence("GlobalSearch", "gsrch", false) {
		t.Fatal("expected case-insensitive subsequence match")
	}
	if fuzzySubsequence("GlobalSearch", "gsrch", true) {
		t.Fatal("case-sensitive subsequence must not match")
	}
	if fuzzySubsequence("abc", "", false) {
		t.Fatal("empty needle must not match")
	}
}

func TestSearchWorkspaceFuzzyAddsSplitHits(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "literal.txt"), "use needle here\n")
	writeSearchFile(t, filepath.Join(dir, "split.txt"), "n e e d l e apart\n")

	app := &Searcher{}
	plain, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(plain.Hits) != 1 || plain.Hits[0].Name != "literal.txt" {
		t.Fatalf("literal search must only hit literal file, got %+v", plain.Hits)
	}

	res, err := app.SearchWorkspaceFuzzy(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 fuzzy hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	// 字面命中的文件排在子序列命中的文件之前（与路径字典序无关）
	if res.Hits[0].Name != "literal.txt" || res.Hits[0].fuzzySplit {
		t.Fatalf("literal hit must rank first and not be marked split: %+v", res.Hits[0])
	}
	split := res.Hits[1]
	if split.Name != "split.txt" || !split.fuzzySplit {
		t.Fatalf("expected split hit for split.txt: %+v", split)
	}
	if got := previewMatch(split); got != "n e e d l e" {
		t.Fatalf("split window = %q (preview %q)", got, split.Preview)
	}
	if split.Column != 1 || split.Length != len("n e e d l e") {
		t.Fatalf("unexpected split column/length: %+v", split)
	}
}

func TestSearchWorkspaceFuzzyLinePrefersLiteral(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	// 同一行既有字面命中、也能被当作子序列命中：只保留字面命中，不重复出子序列命中
	writeSearchFile(t, filepath.Join(dir, "both.txt"), "needle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspaceFuzzy(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 1 {
		t.Fatalf("expected 1 hit, got %d: %+v", len(res.Hits), res.Hits)
	}
	if res.Hits[0].fuzzySplit {
		t.Fatalf("literal match must not be marked as split: %+v", res.Hits[0])
	}
}

func TestSearchWorkspaceFuzzyWindowCap(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	// 首尾字符相隔超过 fuzzyMaxWindow 的「命中」视为无意义，直接丢弃
	writeSearchFile(t, filepath.Join(dir, "long.txt"), "n"+strings.Repeat(".", 300)+"eedle\n")
	app := &Searcher{}
	res, err := app.SearchWorkspaceFuzzy(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 0 {
		t.Fatalf("expected no hits for over-wide window, got %+v", res.Hits)
	}
}

func TestSearchWorkspaceFuzzyNameTier(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "zzz.txt"), "g s r c h\n")
	writeSearchFile(t, filepath.Join(dir, "gsrch.txt"), "x g s r c h y\n")
	app := &Searcher{}
	res, err := app.SearchWorkspaceFuzzy(dir, "gsrch", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("expected 2 hits, got %d: %+v", len(res.Hits), res.Hits)
	}
	// 文件名子序列命中的文件排在只有内容命中的文件之前
	if res.Hits[0].Name != "gsrch.txt" {
		t.Fatalf("expected name-hit file first, got %+v", res.Hits)
	}
}

func TestSearchWorkspaceNonFuzzyUnchanged(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1")
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "split.txt"), "n e e d l e apart\n")
	app := &Searcher{}
	res, err := app.SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 0 {
		t.Fatalf("plain search must not do subsequence matching, got %+v", res.Hits)
	}
}