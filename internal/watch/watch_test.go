package watch

import (
	"testing"
	"time"
)

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

// 静默门：应用自身批量目录操作期间（插件更新 / 卸载）不把删除事件交给破坏判定。
func TestQuietGate(t *testing.T) {
	old := quietGraceDuration
	quietGraceDuration = 0
	t.Cleanup(func() {
		quietGraceDuration = old
		quietDepth.Store(0)
		quietUntil.Store(0)
	})

	if quietActive() {
		t.Fatal("初始不应静默")
	}
	BeginQuiet()
	if !quietActive() {
		t.Fatal("BeginQuiet 后应静默")
	}
	// 嵌套：内层结束外层仍在
	BeginQuiet()
	EndQuiet()
	if !quietActive() {
		t.Fatal("嵌套未全部结束时应仍静默")
	}
	EndQuiet()
	if quietActive() {
		t.Fatal("全部结束后不应静默（宽限置 0）")
	}
	// 多调 End 不落到负数
	EndQuiet()
	if quietActive() {
		t.Fatal("多调 EndQuiet 不应进入负计数")
	}
	// 宽限期：结束后一段时间内仍抑制
	quietGraceDuration = time.Hour
	BeginQuiet()
	EndQuiet()
	if !quietActive() {
		t.Fatal("宽限期内应仍静默")
	}
	quietUntil.Store(0)
	if quietActive() {
		t.Fatal("宽限过期后应解除")
	}
}
