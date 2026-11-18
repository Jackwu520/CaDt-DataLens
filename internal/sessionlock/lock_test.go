package sessionlock

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestTryLockFileBusyAndRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.test")
	first, err := TryLockFile(path)
	if err != nil {
		t.Fatalf("首次 TryLockFile 失败：%v", err)
	}
	if _, err := TryLockFile(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("第二个句柄应返回 ErrLocked，得到 %v", err)
	}
	first.Release()
	second, err := TryLockFile(path)
	if err != nil {
		t.Fatalf("释放后 TryLockFile 失败：%v", err)
	}
	second.Release()
}

func TestSharedLocksCoexistAndBlockExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.test")
	first, err := TryLockFileShared(path)
	if err != nil {
		t.Fatalf("首个共享锁失败：%v", err)
	}
	second, err := TryLockFileShared(path)
	if err != nil {
		first.Release()
		t.Fatalf("第二个共享锁应可共存：%v", err)
	}
	if _, err := TryLockFile(path); !errors.Is(err, ErrLocked) {
		first.Release()
		second.Release()
		t.Fatalf("共享锁存在时独占锁应返回 ErrLocked，得到 %v", err)
	}
	first.Release()
	second.Release()
	exclusive, err := TryLockFile(path)
	if err != nil {
		t.Fatalf("共享锁释放后独占锁失败：%v", err)
	}
	exclusive.Release()
}

func TestExclusiveBlocksShared(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock.test")
	exclusive, err := TryLockFile(path)
	if err != nil {
		t.Fatalf("独占锁失败：%v", err)
	}
	defer exclusive.Release()
	if _, err := TryLockFileShared(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("独占锁存在时共享锁应返回 ErrLocked，得到 %v", err)
	}
}
