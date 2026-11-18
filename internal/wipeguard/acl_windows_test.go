//go:build windows

// acl_windows_test.go：deny-delete ACL 的 Windows 集成验证（方案 §9）。
// icacls 是真系统调用，跑得慢但只在本包测试里执行；short 模式跳过。
package wipeguard

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAclProtectDeniesDelete(t *testing.T) {
	if testing.Short() {
		t.Skip("short 模式跳过 icacls 集成")
	}
	if _, err := os.Stat(`C:\Windows\System32\icacls.exe`); err != nil {
		t.Skip("icacls 不在预期位置，跳过")
	}
	dir := t.TempDir()
	t.Cleanup(func() { _ = unprotectRoot(dir) })
	keepFile := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(keepFile, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "inner.txt"), []byte("inner"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := protectRoot(dir); err != nil {
		t.Fatalf("套保护失败：%v", err)
	}
	// ① 子进程视角同权限：当前进程删除应被拒（unlink 需要 DELETE 权限）
	if err := os.Remove(keepFile); err == nil {
		t.Fatal("deny-delete 后删除文件竟然成功")
	}
	// ② 目录树删除应被拒
	if err := os.RemoveAll(sub); err == nil {
		t.Fatal("deny-delete 后 RemoveAll 子树竟然成功")
	}
	if _, err := os.Stat(filepath.Join(sub, "inner.txt")); err != nil {
		t.Fatal("子树内容不应被删掉")
	}
	// ③ 写入 / 新建不受影响（备份流程必须还能写 blob）
	if err := os.WriteFile(filepath.Join(dir, "new-blob"), []byte("data"), 0o600); err != nil {
		t.Fatalf("保护目录内新建文件应不受影响：%v", err)
	}
	// ④ 摘保护后删除恢复
	if err := unprotectRoot(dir); err != nil {
		t.Fatalf("摘保护失败：%v", err)
	}
	if err := os.Remove(keepFile); err != nil {
		t.Fatalf("摘保护后删除仍失败：%v", err)
	}
	if err := os.RemoveAll(sub); err != nil {
		t.Fatalf("摘保护后子树删除仍失败：%v", err)
	}
}

// TestEnsureRootProtectsOnce ensureRoot 后目录有保护标记，重复调用不重跑 icacls。
func TestEnsureRootProtectsOnce(t *testing.T) {
	if testing.Short() {
		t.Skip("short 模式跳过 icacls 集成")
	}
	s := newTestService(t)
	root, err := s.ensureRoot()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, protectedMarker)); err != nil {
		t.Fatalf("保护标记未写入：%v", err)
	}
	// 第二次调用：走标记短路（不校验 icacls 没跑——只验证不报错且标记还在）
	if _, err := s.ensureRoot(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, protectedMarker)); err != nil {
		t.Fatalf("二次调用后标记丢失")
	}
}
