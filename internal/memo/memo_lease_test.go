package memo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLeasePathScopes(t *testing.T) {
	base := t.TempDir()
	withDeps(t, base)
	global, err := LeasePath("global", "")
	if err != nil {
		t.Fatal(err)
	}
	if global != filepath.Join(base, "memo.lock") {
		t.Fatalf("全局锁路径 = %q", global)
	}
	ws := t.TempDir()
	workspace, err := LeasePath("workspace", ws)
	if err != nil {
		t.Fatal(err)
	}
	if workspace != filepath.Join(ws, ".cadt", "memo.lock") {
		t.Fatalf("工作区锁路径 = %q", workspace)
	}
	if _, err := LeasePath("bogus", ws); err == nil {
		t.Fatal("非法作用域应报错")
	}
	if _, err := LeasePath("workspace", ""); err == nil {
		t.Fatal("工作区为空应报错")
	}
}

// TestLeaseOwnersAndClearGuard：同窗口重入走计数，跨窗口 Busy（v2 的「第二个
// 窗口只读 + 横幅」语义），最后持有者退出才解锁；按归属释放只摘自己的。
func TestLeaseOwnersAndClearGuard(t *testing.T) {
	base := t.TempDir()
	withDeps(t, base)
	ws := t.TempDir()

	first, err := AcquireLease("workspace", ws, "", "main")
	if err != nil || !first.Acquired {
		t.Fatalf("首次 AcquireLease 失败：%+v %v", first, err)
	}
	// 同窗口重入：计数 +1，仍 Acquired
	reentry, err := AcquireLease("workspace", ws, "", "main")
	if err != nil || !reentry.Acquired {
		t.Fatalf("同窗口重入应走计数：%+v %v", reentry, err)
	}
	// 跨窗口：Busy（不再双写）
	second, err := AcquireLease("workspace", ws, "", "main-2")
	if err != nil {
		t.Fatal(err)
	}
	if second.Acquired || !second.Busy {
		t.Fatalf("跨窗口 AcquireLease 应 Busy：%+v", second)
	}
	if !strings.Contains(second.Owner.Label, "main") {
		t.Fatalf("Busy Owner 应能看出持有窗口：%+v", second.Owner)
	}
	if _, err := LockForClear("workspace", ws); err == nil {
		t.Fatal("有窗口持锁时 LockForClear 应报忙")
	}
	// 释放一次（重入计数还在）：仍持有
	if err := ReleaseLease("workspace", ws, "main"); err != nil {
		t.Fatal(err)
	}
	status, err := LeaseStatusFor("workspace", ws)
	if err != nil || !status.Acquired {
		t.Fatalf("还剩一个持有者时应仍持有：%+v %v", status, err)
	}
	// main-2 关窗：只摘它自己——它本来就没持有，不影响 main
	if n := ReleaseLeaseByOwner("main-2"); n != 0 {
		t.Fatalf("未持锁窗口的按归属释放应触达 0 条：%d", n)
	}
	// main 关窗（重入已清 + 持有清掉）：解锁
	if n := ReleaseLeaseByOwner("main"); n != 1 {
		t.Fatalf("按归属释放应触达 1 条：%d", n)
	}
	status, err = LeaseStatusFor("workspace", ws)
	if err != nil || status.Acquired || status.Busy {
		t.Fatalf("全部释放后租约应为空：%+v %v", status, err)
	}
	release, err := LockForClear("workspace", ws)
	if err != nil {
		t.Fatalf("释放后 LockForClear 失败：%v", err)
	}
	if release != nil {
		release()
	}
	if _, err := os.Stat(filepath.Join(ws, ".cadt", "memo.lock")); err != nil {
		t.Fatalf("锁文件应在被保护的 memo 目录之外：%v", err)
	}
}
