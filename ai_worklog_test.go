package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readWorklogFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 %s 失败：%v", path, err)
	}
	return string(raw)
}

// 首条记录：自动建齐三层目录与两个索引，根索引补标题头。
func TestWorklogFirstEntryCreatesStructure(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 14, 9, 30, 5, 0, time.Local)
	dayPath, err := appendWorklogEntry(dir, now, "修复全局搜索", "跳转定位用 mid 匹配")
	if err != nil {
		t.Fatal(err)
	}
	wantDay := filepath.Join(dir, "2026", "11", "2026-11-14.md")
	if dayPath != wantDay {
		t.Fatalf("dayPath = %s, want %s", dayPath, wantDay)
	}
	day := readWorklogFile(t, wantDay)
	if !strings.Contains(day, "## 09:30:05 修复全局搜索") || !strings.Contains(day, "- 跳转定位用 mid 匹配") {
		t.Fatalf("正文缺少标题/摘要：%q", day)
	}
	month := readWorklogFile(t, filepath.Join(dir, "2026", "11", "INDEX.md"))
	if !strings.Contains(month, "- 11-14 09:30 修复全局搜索 — 跳转定位用 mid 匹配（./2026-11-14.md）") {
		t.Fatalf("月份索引一行一条不符：%q", month)
	}
	root := readWorklogFile(t, filepath.Join(dir, "INDEX.md"))
	if !strings.Contains(root, "# AI 工作日志") || !strings.Contains(root, "- 2026-11（./2026/11/INDEX.md）") {
		t.Fatalf("根索引缺少月份行：%q", root)
	}
}

// 同月同日多次追加：正文与月份索引各加一行，根索引月份行不重复。
func TestWorklogAppendSameMonth(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 11, 14, 8, 0, 0, 0, time.Local)
	if _, err := appendWorklogEntry(dir, base, "第一条", "摘要一"); err != nil {
		t.Fatal(err)
	}
	if _, err := appendWorklogEntry(dir, base.Add(2*time.Hour), "第二条", ""); err != nil {
		t.Fatal(err)
	}
	month := readWorklogFile(t, filepath.Join(dir, "2026", "11", "INDEX.md"))
	if strings.Count(month, "\n- ") != 1 && !strings.Contains(month, "第一条") || !strings.Contains(month, "第二条") {
		t.Fatalf("月份索引应有两行记录：%q", month)
	}
	root := readWorklogFile(t, filepath.Join(dir, "INDEX.md"))
	if got := strings.Count(root, "- 2026-11"); got != 1 {
		t.Fatalf("根索引月份行应恰好 1 行，实际 %d：%q", got, root)
	}
	day := readWorklogFile(t, filepath.Join(dir, "2026", "11", "2026-11-14.md"))
	if !strings.Contains(day, "## 08:00:00 第一条") || !strings.Contains(day, "## 10:00:00 第二条") {
		t.Fatalf("正文应按时间追加两条：%q", day)
	}
	// 无摘要的条目：月份索引不带「— 摘要」段
	lines := strings.Split(month, "\n")
	if !strings.HasSuffix(lines[1], "第二条（./2026-11-14.md）") {
		t.Fatalf("无摘要条目格式不符：%q", lines[1])
	}
}

// 跨月首条：新月份目录自动创建，根索引追加新月份行；旧月份索引不再被改动。
func TestWorklogCrossMonth(t *testing.T) {
	dir := t.TempDir()
	nov := time.Date(2026, 11, 30, 23, 0, 0, 0, time.Local)
	dec := time.Date(2026, 12, 1, 0, 30, 0, 0, time.Local)
	if _, err := appendWorklogEntry(dir, nov, "十一月收尾", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := appendWorklogEntry(dir, dec, "十二月开工", "跨月第一条"); err != nil {
		t.Fatal(err)
	}
	decMonth := readWorklogFile(t, filepath.Join(dir, "2026", "12", "INDEX.md"))
	if !strings.Contains(decMonth, "十二月开工") {
		t.Fatalf("十二月索引缺失：%q", decMonth)
	}
	decDay := readWorklogFile(t, filepath.Join(dir, "2026", "12", "2026-12-01.md"))
	if !strings.Contains(decDay, "## 00:30:00 十二月开工") {
		t.Fatalf("十二月正文缺失：%q", decDay)
	}
	root := readWorklogFile(t, filepath.Join(dir, "INDEX.md"))
	if !strings.Contains(root, "- 2026-11") || !strings.Contains(root, "- 2026-12") {
		t.Fatalf("根索引应同时有两个月份行：%q", root)
	}
	if got := strings.Count(root, "- 2026-1"); got != 2 {
		t.Fatalf("根索引月份行应恰好 2 行，实际 %d：%q", got, root)
	}
}

// 标题 / 摘要清洗：换行折叠成空格、超长截断（多字节安全）。
func TestWorklogSingleLine(t *testing.T) {
	cases := []struct {
		name string
		in   string
		max  int
		want string
	}{
		{"换行折叠", "第一行\n第二行\r\n第三行", 100, "第一行 第二行 第三行"},
		{"空白收敛", "  a \t b  ", 100, "a b"},
		{"按字符截断不断字", strings.Repeat("汉", worklogSummaryMax+50), worklogSummaryMax, strings.Repeat("汉", worklogSummaryMax)},
		{"空串", "", 10, ""},
	}
	for _, c := range cases {
		if got := worklogSingleLine(c.in, c.max); got != c.want {
			t.Fatalf("%s: worklogSingleLine(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

// 空标题拒绝；合法调用返回的路径可读回。
func TestWorklogRejectsEmptyTitle(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 14, 9, 0, 0, 0, time.Local)
	if _, err := appendWorklogEntry(dir, now, "   ", ""); err == nil {
		t.Fatal("空标题应报错")
	}
	// 标题超长被截断而不是报错
	long := strings.Repeat("标", worklogTitleMax+50)
	if _, err := appendWorklogEntry(dir, now, long, ""); err != nil {
		t.Fatal(err)
	}
	month := readWorklogFile(t, filepath.Join(dir, "2026", "11", "INDEX.md"))
	if !strings.Contains(month, strings.Repeat("标", worklogTitleMax)) {
		t.Fatal("标题截断后应写入")
	}
	if strings.Contains(month, strings.Repeat("标", worklogTitleMax+10)) {
		t.Fatal("标题超长应被截断")
	}
}
