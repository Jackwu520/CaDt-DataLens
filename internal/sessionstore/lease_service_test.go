package sessionstore

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"datalens/internal/resourcelease"
)

// 同进程 refcount：两次 Acquire 后 release 一次仍持有，第二次才真正释放。
func TestServiceSessionLeaseRefcount(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	first, err := svc.AISessionLeaseAcquire("s1", "turn", "test", 0)
	if err != nil || !first.Acquired {
		t.Fatalf("首次租约失败：%+v %v", first, err)
	}
	second, err := svc.AISessionLeaseAcquire("s1", "turn", "test", 0)
	if err != nil || !second.Acquired {
		t.Fatalf("第二次租约应走 refcount：%+v %v", second, err)
	}
	if err := svc.AISessionLeaseRelease("s1"); err != nil {
		t.Fatal(err)
	}
	status, err := svc.AISessionLeaseStatus("s1")
	if err != nil || !status.Acquired {
		t.Fatalf("释放一个 ref 后仍应持有：%+v %v", status, err)
	}
	if err := svc.AISessionLeaseRelease("s1"); err != nil {
		t.Fatal(err)
	}
	status, err = svc.AISessionLeaseStatus("s1")
	if err != nil || status.Acquired || status.Busy {
		t.Fatalf("全部释放后租约应为空：%+v %v", status, err)
	}
}

// 回合租约与写路径同进程共享：Append/WriteMeta 不应被自己的回合锁挡住。
func TestSessionWriteSharesTurnLease(t *testing.T) {
	withServiceAppData(t)
	svc := &Service{}
	if _, err := svc.AISessionLeaseAcquire("s1", "turn", "test", 0); err != nil {
		t.Fatal(err)
	}
	defer svc.AISessionLeaseRelease("s1")
	if err := svc.AISessionAppend("s1", `{"t":"header"}`, true); err != nil {
		t.Fatalf("同进程 Append 应共享租约：%v", err)
	}
	if err := svc.AISessionWriteMeta("s1", `{"title":"x"}`); err != nil {
		t.Fatalf("同进程 WriteMeta 应共享租约：%v", err)
	}
}

// 根门闩共享存在时，RemoveAll 的独占请求必须失败。
func TestRemoveAllBlockedBySharedRootGate(t *testing.T) {
	store := New(t.TempDir())
	store.DeleteFn = os.RemoveAll
	if err := store.Append("s1", "{}\n"); err != nil {
		t.Fatal(err)
	}
	gate, err := resourcelease.AcquireShared(store.RootGatePath())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveAll(); !errors.Is(err, ErrSessionBusy) {
		gate.Release()
		t.Fatalf("共享门闩存在时 RemoveAll 应 busy，得到 %v", err)
	}
	gate.Release()
	if err := store.RemoveAll(); err != nil {
		t.Fatalf("释放后 RemoveAll 失败：%v", err)
	}
	if _, err := os.Stat(store.Root); !os.IsNotExist(err) {
		t.Fatalf("会话根目录未删除：%v", err)
	}
}

// 本进程持有会话锁时，Remove 的 NoShare 独占必须失败（不能 refcount 共享后删掉）。
func TestRemoveBlockedBySameProcessLease(t *testing.T) {
	store := New(t.TempDir())
	store.DeleteFn = os.RemoveAll
	if err := store.Append("s1", "{}\n"); err != nil {
		t.Fatal(err)
	}
	path, err := store.LeasePath("s1")
	if err != nil {
		t.Fatal(err)
	}
	lease, err := resourcelease.Acquire(path, resourcelease.Owner{Label: "turn"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("s1"); !errors.Is(err, ErrSessionBusy) {
		lease.Release()
		t.Fatalf("本进程持锁时 Remove 应 busy，得到 %v", err)
	}
	lease.Release()
	if err := store.Remove("s1"); err != nil {
		t.Fatalf("释放后 Remove 失败：%v", err)
	}
	if _, err := os.Stat(filepath.Join(store.Root, "s1")); !os.IsNotExist(err) {
		t.Fatalf("会话目录未删除：%v", err)
	}
}

// 根门闩被独占（清理）时，写路径的根共享必须失败。
func TestSessionWriteBlockedByRootGate(t *testing.T) {
	store := New(t.TempDir())
	if err := store.EnsureRoot(); err != nil {
		t.Fatal(err)
	}
	gate, err := resourcelease.AcquireNoShare(store.RootGatePath(), resourcelease.Owner{Label: "clear"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Append("s1", "x\n"); !errors.Is(err, ErrSessionBusy) {
		gate.Release()
		t.Fatalf("根门闩独占时 Append 应 busy，得到 %v", err)
	}
	gate.Release()
	if err := store.Append("s1", "x\n"); err != nil {
		t.Fatalf("释放后 Append 失败：%v", err)
	}
}
