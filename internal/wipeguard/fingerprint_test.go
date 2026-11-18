package wipeguard

import (
	"os"
	"path/filepath"
	"testing"
)

func mkFile(t *testing.T, root, rel string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mkDir(t *testing.T, root, rel string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(rel)), 0o755); err != nil {
		t.Fatal(err)
	}
}

// ShouldWarn 表驱动：方案 §5.4 的四个条件 + 保守门槛 + 无事情形。
func TestShouldWarn(t *testing.T) {
	mk := func(rootEntries, files int, markers ...string) Fingerprint {
		m := map[string]bool{}
		for _, name := range markers {
			m[name] = true
		}
		return Fingerprint{RootEntries: rootEntries, FileCount: files, Markers: m}
	}
	cases := []struct {
		name           string
		before, after  Fingerprint
		wantLevel      string
		wantReasonPart string // 子串断言，理由文案不锁死
	}{
		{
			name: "整仓清空（事故形态）→ critical",
			before: mk(98, 1611, ".git"),
			after:  mk(1, 0),
			wantLevel: "critical", wantReasonPart: "顶层条目被清空",
		},
		{
			name: "顶层条目太少不判清空（before<5，且文件数低于告警门槛）",
			before: mk(2, 4),
			after:  mk(1, 1),
			wantLevel: "",
		},
		{
			name: ".git 消失 → critical",
			before: mk(20, 500, ".git", "go.mod"),
			after:  mk(20, 500, "go.mod"),
			wantLevel: "critical", wantReasonPart: ".git",
		},
		{
			name: "package.json 消失 → critical",
			before: mk(20, 500, "package.json"),
			after:  mk(20, 500),
			wantLevel: "critical", wantReasonPart: "package.json",
		},
		{
			name: "顶层少了四成以上 → warn",
			before: mk(10, 500),
			after:  mk(5, 500),
			wantLevel: "warn", wantReasonPart: "顶层条目大幅减少",
		},
		{
			name: "顶层少两成不判",
			before: mk(10, 500),
			after:  mk(8, 500),
			wantLevel: "",
		},
		{
			name: "文件数腰斩 → warn",
			before: mk(10, 1000),
			after:  mk(10, 400),
			wantLevel: "warn", wantReasonPart: "腰斩",
		},
		{
			name: "文件数太少不判（before<10）",
			before: mk(10, 8),
			after:  mk(10, 2),
			wantLevel: "",
		},
		{
			name: "任一侧未测（FileCount=-1）跳过文件数条件",
			before: mk(10, -1),
			after:  mk(10, 2),
			wantLevel: "",
		},
		{
			name: "新增不算（文件翻倍）",
			before: mk(10, 100, ".git"),
			after:  mk(12, 300, ".git"),
			wantLevel: "",
		},
		{
			name: "无事",
			before: mk(20, 500, ".git"),
			after:  mk(19, 480, ".git"),
			wantLevel: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			level, reason := ShouldWarn(tc.before, tc.after)
			if level != tc.wantLevel {
				t.Fatalf("level = %q（reason=%q），期望 %q", level, reason, tc.wantLevel)
			}
			if tc.wantReasonPart != "" && !contains(reason, tc.wantReasonPart) {
				t.Fatalf("reason = %q，期望包含 %q", reason, tc.wantReasonPart)
			}
		})
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// Take 端到端：临时工作区上核对计数、标记、忽略目录。
func TestTake(t *testing.T) {
	root := t.TempDir()
	mkFile(t, root, "main.go")
	mkFile(t, root, "go.mod") // 标记之一
	mkFile(t, root, "docs/a.md")
	mkFile(t, root, "internal/x/y.go")
	mkFile(t, root, ".cadt/tmp/scratch.txt") // .cadt 跳过
	mkFile(t, root, "node_modules/pkg/i.js") // 忽略表跳过
	mkFile(t, root, ".git/HEAD")             // .git 跳过递归，但作为标记要能看见
	mkDir(t, root, "docs")
	mkDir(t, root, "internal")
	mkDir(t, root, "empty-dir")

	fp := Take(root)
	if fp.RootEntries != 8 { // main.go go.mod docs internal .cadt node_modules .git empty-dir
		t.Fatalf("RootEntries = %d，期望 8", fp.RootEntries)
	}
	// 一级目录：docs internal .cadt node_modules .git empty-dir = 6
	if fp.Depth1Dirs != 6 {
		t.Fatalf("Depth1Dirs = %d，期望 6", fp.Depth1Dirs)
	}
	if !fp.Markers[".git"] || !fp.Markers["go.mod"] {
		t.Fatalf("Markers 异常：%v", fp.Markers)
	}
	if fp.Markers["package.json"] {
		t.Fatalf("package.json 不应存在：%v", fp.Markers)
	}
	// FileCount 跳过 .git/.cadt/node_modules 后 = main.go + go.mod + docs/a.md + internal/x/y.go = 4
	if fp.FileCount != 4 {
		t.Fatalf("FileCount = %d，期望 4", fp.FileCount)
	}
	if fp.Sampled {
		t.Fatalf("小树不应降级")
	}

	// 清掉 .git 再取：标记应消失
	if err := os.RemoveAll(filepath.Join(root, ".git")); err != nil {
		t.Fatal(err)
	}
	fp2 := Take(root)
	if fp2.Markers[".git"] {
		t.Fatalf("删除 .git 后标记应消失：%v", fp2.Markers)
	}
	if _, reason := ShouldWarn(fp, fp2); reason == "" {
		t.Fatalf(".git 消失应触发告警")
	}
}

// Take 空目录 / 不存在的根：零值不炸。
func TestTakeDegenerate(t *testing.T) {
	empty := t.TempDir()
	fp := Take(empty)
	if fp.RootEntries != 0 || fp.FileCount != 0 {
		t.Fatalf("空目录指纹异常：%+v", fp)
	}
	fp = Take(filepath.Join(empty, "not-exist"))
	if fp.RootEntries != 0 || fp.FileCount != -1 {
		t.Fatalf("不存在根的指纹异常：%+v", fp)
	}
	level, _ := ShouldWarn(fp, fp)
	if level != "" {
		t.Fatalf("不存在根不应告警")
	}
}

// WorkspaceKey 与 session-workspace-buckets.md 同一约定：归一化（\→/、去尾斜杠、小写）后 sha256 前 8 hex。
// 这里钉死测试向量：前端 ai-wipeguard.test.mjs 断言同一输入得到同一输出，防两端漂移。
func TestWorkspaceKey(t *testing.T) {
	cases := []struct{ in, want string }{
		{"D:\\OraSkyC\\Project\\CandySweet\\CaDt-DataLens\\", "35dc7bd8"},
		{"d:/oraskyc/project/candysweet/cadt-datalens", "35dc7bd8"},
		{"", "e3b0c442"},
	}
	for _, tc := range cases {
		if got := WorkspaceKey(tc.in); got != tc.want {
			t.Fatalf("WorkspaceKey(%q) = %q，期望 %q", tc.in, got, tc.want)
		}
	}
	if WorkspaceKey("a") == WorkspaceKey("b") {
		t.Fatalf("不同 key 哈希相同")
	}
}
