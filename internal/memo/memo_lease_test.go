package memo

import (
	"os"
	"path/filepath"
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

func TestLeaseRefcountAndClearGuard(t *testing.T) {
	base := t.TempDir()
	withDeps(t, base)
	ws := t.TempDir()

	first, err := AcquireLease("workspace", ws, "窗口 A")
	if err != nil || !first.Acquired {
		t.Fatalf("首次 AcquireLease 失败：%+v %v", first, err)
	}
	second, err := AcquireLease("workspace", ws, "窗口 A")
	if err != nil || !second.Acquired {
		t.Fatalf("第二次 AcquireLease 应走 refcount：%+v %v", second, err)
	}
	if _, err := LockForClear("workspace", ws); err == nil {
		t.Fatal("本窗口持锁时 LockForClear 应报忙")
	}
	if err := ReleaseLease("workspace", ws); err != nil {
		t.Fatal(err)
	}
	status, err := LeaseStatusFor("workspace", ws)
	if err != nil || !status.Acquired {
		t.Fatalf("释放一个 ref 后仍应持有：%+v %v", status, err)
	}
	if err := ReleaseLease("workspace", ws); err != nil {
		t.Fatal(err)
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
