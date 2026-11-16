package watch

import "testing"

// skipWorktreeEvent：AI 隔离 worktree 的事件不过推给前端（防事件洪峰冲 overflow）；
// .cadt 其余子目录与同名前缀目录不受影响。纯函数用例，平台无关。
func TestSkipWorktreeEvent(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{".cadt\\worktree", true},
		{".cadt\\worktree\\x\\src\\a.js", true},
		{".cadt/worktree/x/node_modules/p.json", true},
		{".CADT\\WORKTREE\\x\\A.TXT", true},     // 大小写不敏感
		{".cadt/worktree-x/a.js", false},        // 不误伤同名前缀目录
		{".cadtworktree\\x", false},             // 不误伤无分隔前缀
		{".cadt\\logs\\2026\\11\\INDEX.md", false},
		{".cadt\\patches\\p.patch", false},
		{".cadt\\gen\\img.png", false},
		{"src\\main.go", false},
		{".git\\index", false},
		{"", false},
	}
	for _, c := range cases {
		if got := skipWorktreeEvent(c.path); got != c.want {
			t.Fatalf("skipWorktreeEvent(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}
