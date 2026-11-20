package watch

// ownership_test.go：监听归属键控的纯簿记测试（2026-11-21 审查第 1/5 项回归护栏）。
// 规则：不同归属者各持各的槽位，后开窗口不顶掉先开窗口；按归属摘除只动自己的；
// 全量收口只在应用退出。不触发真实目录事件（时序敏感的部分由 watch_windows_test 覆盖）。

import (
	"strings"
	"testing"
)

func TestWorkspaceSlotsByOwner(t *testing.T) {
	w := &Watcher{}
	rootA := t.TempDir()
	rootB := t.TempDir()

	if err := w.WatchWorkspaceFor("main", rootA); err != nil {
		t.Fatal(err)
	}
	if err := w.WatchWorkspaceFor("main-2", rootB); err != nil {
		t.Fatal(err)
	}
	if n := len(w.slots); n != 2 {
		t.Fatalf("两个窗口应各持一个槽位：%d", n)
	}
	if got := w.slots["main"].root; got != rootA {
		t.Fatalf("main 槽位根 = %q, want %q", got, rootA)
	}

	// main 换根：只替换自己的槽，main-2 不受影响
	if err := w.WatchWorkspaceFor("main", rootB); err != nil {
		t.Fatal(err)
	}
	if got := w.slots["main"].root; got != rootB {
		t.Fatalf("main 换根失败：%q", got)
	}
	if got := w.slots["main-2"].root; got != rootB {
		t.Fatalf("main-2 槽位被顶掉：%q", got)
	}

	// main-2 关窗：只摘自己的
	w.UnwatchWorkspaceFor("main-2")
	if _, ok := w.slots["main-2"]; ok {
		t.Fatal("main-2 槽位应已摘除")
	}
	if _, ok := w.slots["main"]; !ok {
		t.Fatal("main 槽位不应被摘除")
	}
	w.UnwatchAll()
	if len(w.slots) != 0 {
		t.Fatalf("全量收口后应无槽位：%d", len(w.slots))
	}
	// 重复收口幂等
	w.UnwatchAll()
}

func TestResourceWatchesByOwner(t *testing.T) {
	w := NewResourceWatcher()
	dir := t.TempDir()

	// 两个窗口监听同一资源：各自持有一条（owner 前缀区分）
	if err := w.Watch("main", "memo", "global", dir); err != nil {
		t.Fatal(err)
	}
	if err := w.Watch("main-2", "memo", "global", dir); err != nil {
		t.Fatal(err)
	}
	if n := len(w.watches); n != 2 {
		t.Fatalf("同资源双窗口应各持一条：%d", n)
	}
	// 事件 key 保持裸值（OnEvent / 前端按它过滤），owner 只进内部 id
	if item := w.watches[resourceID("main", "memo", "global")]; item == nil || item.key != "global" {
		t.Fatal("登记应保留裸 key")
	}

	// main-2 关窗：只摘自己的，main 的推送链路完好
	if n := w.UnwatchByOwner("main-2"); n != 1 {
		t.Fatalf("按归属摘除应触达 1 条：%d", n)
	}
	if _, ok := w.watches[resourceID("main", "memo", "global")]; !ok {
		t.Fatal("main 的监听不应被摘除")
	}
	// main 自己 Unwatch：owner 隔离的 id 命中
	w.Unwatch("main", "memo", "global")
	if len(w.watches) != 0 {
		t.Fatalf("应全部摘除：%d", len(w.watches))
	}
	// 空归属者 = 旧格式单例语义（兼容测试）
	if err := w.Watch("", "ai-session", "s1", dir); err != nil {
		t.Fatal(err)
	}
	if _, ok := w.watches["ai-session|s1"]; !ok {
		t.Fatal("空归属者应落旧格式 id")
	}
	if !strings.Contains(resourceID("", "ai-session", "s1"), "s1") {
		t.Fatal("resourceID 应兼容旧格式")
	}
	w.StopAll()
}
