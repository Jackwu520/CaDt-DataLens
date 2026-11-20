package aigroups

// lease_service_test.go：群讨论租约按归属窗口分桶（multi-instance-sync P6 收尾）。
// 规则：同窗口重入计数，跨窗口 Busy（一个群同一时刻只有一个窗口主持）；
// 按归属释放只摘自己的，最后一个持有者退出才解锁。

import (
	"context"
	"testing"
)

func TestGroupLeaseOwners(t *testing.T) {
	base := t.TempDir()
	oldDir := AppDataDir
	AppDataDir = func() string { return base }
	defer func() { AppDataDir = oldDir }()
	st := New(t.TempDir())
	g := &GroupStore{}

	type ownerCtxKey struct{}
	OwnerForCall = func(ctx context.Context) string {
		if v, ok := ctx.Value(ownerCtxKey{}).(string); ok {
			return v
		}
		return ""
	}
	defer func() { OwnerForCall = nil }()
	winCtx := func(owner string) context.Context {
		return context.WithValue(context.Background(), ownerCtxKey{}, owner)
	}

	id := "group-lease-test"
	first, err := g.GroupLeaseAcquire(winCtx("main"), id, "")
	if err != nil || !first.Acquired {
		t.Fatalf("窗口 main 取群租约失败：%+v %v", first, err)
	}
	reentry, err := g.GroupLeaseAcquire(winCtx("main"), id, "")
	if err != nil || !reentry.Acquired {
		t.Fatalf("同窗口重入应计数：%+v %v", reentry, err)
	}
	second, err := g.GroupLeaseAcquire(winCtx("main-2"), id, "")
	if err != nil {
		t.Fatal(err)
	}
	if second.Acquired || !second.Busy {
		t.Fatalf("跨窗口取群租约应 Busy：%+v", second)
	}
	if n := g.GroupLeaseReleaseByOwner("main-2"); n != 0 {
		t.Fatalf("未持锁窗口按归属释放应触达 0：%d", n)
	}
	if err := g.GroupLeaseRelease(winCtx("main"), id); err != nil {
		t.Fatal(err)
	}
	status, err := g.GroupLeaseStatus(id)
	if err != nil || !status.Acquired {
		t.Fatalf("还剩一个持有者时应仍持有：%+v %v", status, err)
	}
	if n := g.GroupLeaseReleaseByOwner("main"); n != 1 {
		t.Fatalf("按归属释放应触达 1：%d", n)
	}
	status, err = g.GroupLeaseStatus(id)
	if err != nil || status.Acquired || status.Busy {
		t.Fatalf("全部释放后租约应为空：%+v %v", status, err)
	}
	// 锁文件在 .locks/（被保护目录之外），存在是预期的
	if _, err := st.GroupLeasePath(id); err != nil {
		t.Fatalf("GroupLeasePath 失败：%v", err)
	}
}
