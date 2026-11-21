// drift_test.go：§8 表驱动——四态各造一例 + 目录条目覆盖豁免 + 目录条目豁免 Stale +
// baseline 恢复 / Unbaselined + .cadt 不进清单 + 扫描截断。
package cognition

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestComputeDrift(t *testing.T) {
	entries := []Entry{
		{Path: "keep.go", F: "不变"},
		{Path: "changed.go", F: "文件被改"},
		{Path: "gone.go", F: "文件被删"},
		{Path: "fresh.go", F: "新条目未簿记"},
		{Path: "src/pkg/", F: "目录条目"},
		{Path: "src/lonely/", F: "空目录条目"},
		{Path: "src/pkg/inner.go", F: "目录覆盖后再单列（罕见）"},
	}
	files := []ScannedFile{
		{Path: "keep.go", Mtime: 100, Size: 10},
		{Path: "changed.go", Mtime: 200, Size: 10}, // baseline 记录 mtime=100
		{Path: "newfile.go", Mtime: 1, Size: 1},    // 无条目
		{Path: "src/pkg/a.go", Mtime: 1, Size: 1},  // 目录条目覆盖
		{Path: "src/pkg/inner.go", Mtime: 1, Size: 1},
	}
	baseline := &Baseline{Files: map[string]BaselineFile{
		"keep.go":    {Mtime: 100, Size: 10},
		"changed.go": {Mtime: 100, Size: 10},
		"gone.go":    {Mtime: 100, Size: 10},
		// fresh.go 不在 baseline → Unbaselined
		"src/pkg/inner.go": {Mtime: 1, Size: 1},
	}}

	drift := ComputeDrift(entries, files, baseline)

	if drift.Missing.Total != 1 || drift.Missing.Samples[0] != "newfile.go" {
		t.Fatalf("Missing 应为 newfile.go（目录条目覆盖的 a.go 不算）：%+v", drift.Missing)
	}
	if drift.Orphan.Total != 3 {
		t.Fatalf("Orphan 应为 gone.go + fresh.go（文件不存在也是 Orphan）+ 空目录条目 src/lonely/，实际 %+v", drift.Orphan)
	}
	if drift.Stale.Total != 1 || drift.Stale.Samples[0] != "changed.go" {
		t.Fatalf("Stale 应为 changed.go：%+v", drift.Stale)
	}
	if drift.Unbaselined.Total != 1 || drift.Unbaselined.Samples[0] != "fresh.go" {
		t.Fatalf("Unbaselined 应为 fresh.go：%+v", drift.Unbaselined)
	}
}

func TestComputeDriftCaseInsensitiveKeys(t *testing.T) {
	// 卷里写 Internal/x.go、fs 里是 internal/x.go：归一后不算 Missing/Orphan（§3.2 假阳性防线）
	entries := []Entry{{Path: "Internal/X.go", F: "x"}}
	files := []ScannedFile{{Path: "internal/x.go", Mtime: 1, Size: 1}}
	baseline := &Baseline{Files: map[string]BaselineFile{"internal/x.go": {Mtime: 1, Size: 1}}}
	drift := ComputeDrift(entries, files, baseline)
	if drift.Missing.Total != 0 || drift.Orphan.Total != 0 {
		t.Fatalf("大小写/分隔符差异不应产生假阳性：%+v", drift)
	}
}

func TestComputeDriftNoBaseline(t *testing.T) {
	// baseline 缺失（防御路径）：所有文件条目都算 Unbaselined——保守方向，宁可误报一次重读
	entries := []Entry{{Path: "a.go", F: "x"}}
	files := []ScannedFile{{Path: "a.go", Mtime: 1, Size: 1}}
	drift := ComputeDrift(entries, files, nil)
	if drift.Unbaselined.Total != 1 {
		t.Fatalf("baseline 缺失时条目应报 Unbaselined：%+v", drift.Unbaselined)
	}
}

func TestBuildBaselineSkipsDirsAndMissing(t *testing.T) {
	entries := []Entry{
		{Path: "a.go"},
		{Path: "src/pkg/", F: "目录"},
		{Path: "phantom.go"}, // 文件不存在：不写记录（留给 Orphan）
	}
	files := []ScannedFile{{Path: "a.go", Mtime: 7, Size: 3}}
	b := BuildBaseline(entries, files, "fp", 99)
	if b.Fingerprint != "fp" || len(b.Files) != 1 {
		t.Fatalf("baseline 应只含 a.go 一条：%+v", b)
	}
	if rec := b.Files["a.go"]; rec.Mtime != 7 || rec.Size != 3 || rec.At != 99 {
		t.Fatalf("a.go 记录不符：%+v", rec)
	}
}

func TestScanWorkspaceExcludesCadtAndIgnoreDirs(t *testing.T) {
	root := t.TempDir()
	must := func(rel string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must("keep.go")
	must("src/a.js")
	must(".cadt/cognition/code.txt")     // 卷文件绝不进清单（防 phantom Missing，§4.1）
	must(".cadt/tmp/note.md")
	must(".cadt/cognition.lock")         // 锁文件在 .cadt/ 内、卷目录之外，同样被整树排除
	must("node_modules/pkg/index.js")

	files, truncated, err := ScanWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	if truncated {
		t.Fatal("小目录不应截断")
	}
	var got []string
	for _, f := range files {
		got = append(got, f.Path)
	}
	if len(got) != 2 || got[0] != "keep.go" || got[1] != "src/a.js" {
		t.Fatalf("清单应只有 keep.go 与 src/a.js（.cadt 与 node_modules 整树排除，正斜杠输出）：%v", got)
	}
}

func TestScanWorkspaceTruncates(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < maxScanFiles+50; i++ {
		p := filepath.Join(root, fmt.Sprintf("f%05d.txt", i))
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	_, truncated, err := ScanWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	if !truncated {
		t.Fatal("超预算扫描应标记截断")
	}
}

func TestScanWorkspaceRespectsIgnoreList(t *testing.T) {
	// 作用域排除文件 .cadt/cognition/ignore.txt 收窄索引作用域（2026-11-22 用户反馈：不是所有
	// 文件都该建条目，Missing 不该把生成物/产物都算进来）。每例独立 TempDir——规则按
	// 「路径 + mtime」缓存，同目录内改写可能撞上 mtime 粒度，分目录彻底避开。
	cases := []struct {
		name    string
		ignore  string // ignore.txt 内容；空串 = 不写该文件
		write   []string
		want    []string
	}{
		{
			name:   "无排除文件行为不变",
			ignore: "",
			write:  []string{"keep.go", "gen/out.md"},
			want:   []string{"gen/out.md", "keep.go"},
		},
		{
			name:   "目录整树排除",
			ignore: "dist/\n",
			write:  []string{"keep.go", "dist/bundle.js", "dist/sub/deep.js"},
			want:   []string{"keep.go"},
		},
		{
			name:   "按名字排除任意层级",
			ignore: "*.min.js\n",
			write:  []string{"app.js", "dist/app.min.js", "vendor/x/y.min.js"},
			want:   []string{"app.js"},
		},
		{
			name:   "路径 glob 排除",
			ignore: "gen/**\n",
			write:  []string{"keep.go", "gen/a.md", "gen/sub/b.md", "regen/a.md"},
			want:   []string{"keep.go", "regen/a.md"},
		},
		{
			name:   "取反重新包含",
			ignore: "*.log\n!keep.log\n",
			write:  []string{"run.log", "keep.log", "keep.go"},
			want:   []string{"keep.go", "keep.log"},
		},
		{
			name:   "注释与空行",
			ignore: "# 生成物\ndist/\n\n*.tmp\n",
			write:  []string{"keep.go", "dist/x.js", "cache.tmp"},
			want:   []string{"keep.go"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			must := func(rel string) {
				p := filepath.Join(root, filepath.FromSlash(rel))
				if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if tc.ignore != "" {
				must(".cadt/cognition/ignore.txt")
				if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(DirName), IgnoreName), []byte(tc.ignore), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			for _, rel := range tc.write {
				must(rel)
			}
			files, truncated, err := ScanWorkspace(root)
			if err != nil {
				t.Fatal(err)
			}
			if truncated {
				t.Fatal("小目录不应截断")
			}
			var got []string
			for _, f := range files {
				got = append(got, f.Path)
			}
			sort.Strings(got)
			want := append([]string(nil), tc.want...)
			sort.Strings(want)
			if len(got) != len(want) {
				t.Fatalf("清单不符：got %v want %v", got, want)
			}
			for i := range got {
				if got[i] != want[i] {
					t.Fatalf("清单不符：got %v want %v", got, want)
				}
			}
		})
	}
}

func TestIgnoreListSelfHidden(t *testing.T) {
	// 排除文件自身在 .cadt 整树排除之下，永不进清单（无自指 Missing）；其规则照常生效。
	root := t.TempDir()
	write := func(rel string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".cadt/cognition/ignore.txt") // 内容 "x" 也是合法规则（按名匹配，不命中任何文件）
	write("keep.go")

	files, _, err := ScanWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Path != "keep.go" {
		t.Fatalf("清单应只有 keep.go（排除文件自身在 .cadt 下不进清单）：%+v", files)
	}
}

func TestIgnoreListPrunesOrphansIgnoredEntries(t *testing.T) {
	// 语义闭环：被排除的文件不进清单——Missing 不再报它；已有条目指向被排除
	// 文件时按 Orphan 收敛（模型维护轮应删条目或调整排除表，而不是永远 Missing 噪音）。
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".cadt/cognition/ignore.txt", "gen/\n")
	write("keep.go", "x")
	write("gen/out.js", "x")

	files, _, err := ScanWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	entries := []Entry{
		{Path: "keep.go", F: "主入口"},
		{Path: "gen/out.js", F: "被排除文件的条目"},
	}
	drift := ComputeDrift(entries, files, BuildBaseline(entries, files, "fp", 1))
	if drift.Missing.Total != 0 {
		t.Fatalf("gen/ 已排除，不应有 Missing：%+v", drift.Missing)
	}
	if drift.Orphan.Total != 1 || drift.Orphan.Samples[0] != "gen/out.js" {
		t.Fatalf("指向被排除文件的条目应报 Orphan（提示收敛），实际 %+v", drift.Orphan)
	}
}
