package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeIgnore(t *testing.T, root, content string) {
	t.Helper()
	writeSearchFile(t, filepath.Join(root, ".cadt", "config", "search-ignore"), content)
}

func TestIgnoreRulesParseAndMatch(t *testing.T) {
	rules := &IgnoreRules{rules: []ignoreRule{
		{pattern: ".aoci", byName: true},              // 任意层级同名目录/文件
		{pattern: "*.bak", byName: true},              // 按名字通配
		{pattern: ".cadt/tmp", byName: false},         // 相对根路径
		{negate: true, pattern: "keep.bak", byName: true}, // 取反：重新包含
	}}
	cases := []struct {
		name, rel string
		want      bool
	}{
		{".aoci", ".aoci", true},
		{"x", ".aoci/baseline.json", true},            // 名字规则命中任意层级路径段
		{"x", "docs/.aoci/x.json", true},
		{"a.bak", "src/a.bak", true},
		{"keep.bak", "src/keep.bak", false},           // 取反覆盖 *.bak
		{"x", ".cadt/tmp/note.md", true},              // 路径规则
		{"x", ".cadt/tmp", true},
		{"x", "other/.cadt/tmp/x", false},             // 路径规则不匹配别处
		{"x", "src/main.go", false},
		{"x", "", false},                              // 根自身永不跳过
		{"x", ".", false},
	}
	for _, c := range cases {
		if got := rules.shouldSkip(c.name, c.rel); got != c.want {
			t.Errorf("shouldSkip(%q, %q) = %v, want %v", c.name, c.rel, got, c.want)
		}
	}
}

func TestLoadIgnoreRulesCommentsAndCache(t *testing.T) {
	dir := t.TempDir()
	writeIgnore(t, dir, "# 注释\n\n  # 缩进注释\n.aoci\n*.tmp\n!keep.tmp\n")
	rules := LoadIgnoreRules(dir)
	if rules == nil || len(rules.rules) != 3 {
		t.Fatalf("应解析出 3 条规则，got %+v", rules)
	}
	if !rules.shouldSkip("x", "a/.aoci/b.json") || !rules.shouldSkip("a.tmp", "a.tmp") {
		t.Error("注释不应影响规则命中")
	}
	if rules.shouldSkip("keep.tmp", "keep.tmp") {
		t.Error("!keep.tmp 应重新包含")
	}
	// 缓存命中：同一 path+mtime 返回同一实例
	if LoadIgnoreRules(dir) != rules {
		t.Error("mtime 未变时应命中缓存")
	}
}

func TestSearchWorkspaceRespectsIgnore(t *testing.T) {
	t.Setenv("DATALENS_NO_RG", "1") // 强制内置扫描路径
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.txt"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, ".aoci", "baseline.json"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "keep.bak"), "needle\n")
	writeSearchFile(t, filepath.Join(dir, "src", "drop.bak"), "needle\n")
	writeIgnore(t, dir, ".aoci\n*.bak\n!keep.bak\n")

	res, err := (&Searcher{}).SearchWorkspace(dir, "needle", false, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 {
		t.Fatalf("应只剩 a.txt 与 keep.bak 两处命中，got %d: %+v", len(res.Hits), res.Hits)
	}
	for _, h := range res.Hits {
		if strings.Contains(h.Path, ".aoci") || strings.HasSuffix(h.Path, "drop.bak") {
			t.Errorf("被排除的文件不该命中：%s", h.Path)
		}
	}
}

func TestFindFilesRespectsIgnore(t *testing.T) {
	dir := t.TempDir()
	writeSearchFile(t, filepath.Join(dir, "a.go"), "package main\n")
	writeSearchFile(t, filepath.Join(dir, ".aoci", "x.go"), "package x\n")
	writeSearchFile(t, filepath.Join(dir, "docs", "old.go.bak"), "package old\n")
	writeIgnore(t, dir, ".aoci\n*.bak\n")

	res, err := (&Searcher{}).FindFiles(dir, "*.go*", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Files) != 1 || res.Files[0].Path != "a.go" {
		t.Fatalf("FindFiles 应只返回 a.go，got %+v", res.Files)
	}
}

func TestSkipRgHitRespectsIgnore(t *testing.T) {
	dir := t.TempDir()
	rules := &IgnoreRules{rules: []ignoreRule{{pattern: ".aoci", byName: true}}}
	cache := map[string]bool{}
	if !skipRgHit(dir, filepath.Join(dir, ".aoci", "x.json"), rules, cache) {
		t.Error("rg 命中落在 .aoci 下应被二次过滤")
	}
	if skipRgHit(dir, filepath.Join(dir, "src", "a.go"), rules, cache) {
		t.Error("正常文件不该被过滤")
	}
}

func TestIgnoreNotAffectFingerprintSkipDir(t *testing.T) {
	// 硬编码表与用户配置互相独立：SkipDir 不含 .aoci（wipeguard 等不接入用户配置）
	if SkipDir(".aoci") {
		t.Error("SkipDir 不应包含用户配置里的目录名")
	}
}

func TestLoadIgnoreRulesAtArbitraryPath(t *testing.T) {
	// LoadIgnoreRulesAt：认知索引的 .cogignore 等任意路径排除文件复用同一解析/匹配机器。
	// 缓存键 = 文件路径 + mtime，与 search-ignore 互不串扰。
	dir := t.TempDir()
	if LoadIgnoreRulesAt(filepath.Join(dir, "missing.cogignore")) != nil {
		t.Fatal("不存在的文件应返回 nil")
	}
	// 是目录也应返回 nil（防呆）
	if err := os.MkdirAll(filepath.Join(dir, "cfg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if LoadIgnoreRulesAt(filepath.Join(dir, "cfg")) != nil {
		t.Fatal("目录应返回 nil")
	}
	path := filepath.Join(dir, ".cogignore")
	writeSearchFile(t, path, "*.log\n!keep.log\ndist/\n")
	rules := LoadIgnoreRulesAt(path)
	if rules == nil || len(rules.rules) != 3 {
		t.Fatalf("应解析出 3 条规则，got %+v", rules)
	}
	if !rules.shouldSkip("run.log", "a/b/run.log") || rules.shouldSkip("keep.log", "keep.log") {
		t.Error("通配与取反语义应与 search-ignore 一致")
	}
	if !rules.shouldSkip("x", "dist/bundle.js") {
		t.Error("目录规则应整树命中")
	}
	if LoadIgnoreRulesAt(path) != rules {
		t.Error("mtime 未变时应命中缓存")
	}
}
