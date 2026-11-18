//go:build !windows

package sessionlock

import (
	"fmt"
	"os"
	"syscall"
	"time"
)

// tryLockBudget 是 TryLockFile / TryLockFileShared 的竞态重试窗口（与 Windows 对齐）。
const tryLockBudget = 100 * time.Millisecond

type lockMode int

const (
	lockExclusive lockMode = iota
	lockShared
)

func LockFile(path string, timeout time.Duration) (*FileLock, error) {
	return lockFile(path, lockExclusive, timeout)
}

func LockFileShared(path string, timeout time.Duration) (*FileLock, error) {
	return lockFile(path, lockShared, timeout)
}

func TryLockFile(path string) (*FileLock, error) {
	return lockFile(path, lockExclusive, tryLockBudget)
}

func TryLockFileShared(path string) (*FileLock, error) {
	return lockFile(path, lockShared, tryLockBudget)
}

// lockFile 用 flock(2) 加锁；进程退出时内核自动释放。
func lockFile(path string, mode lockMode, timeout time.Duration) (*FileLock, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	fd := int(f.Fd())
	how := syscall.LOCK_EX
	if mode == lockShared {
		how = syscall.LOCK_SH
	}
	deadline := time.Now().Add(timeout)
	for {
		err = syscall.Flock(fd, how|syscall.LOCK_NB)
		if err == nil {
			return &FileLock{release: func() {
				_ = syscall.Flock(fd, syscall.LOCK_UN)
				_ = f.Close()
			}}, nil
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			_ = f.Close()
			return nil, err
		}
		if !time.Now().Before(deadline) {
			_ = f.Close()
			return nil, fmt.Errorf("%w：等待会话写锁超时", ErrLocked)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
