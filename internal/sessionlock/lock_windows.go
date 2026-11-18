//go:build windows

package sessionlock

import (
	"errors"
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// tryLockBudget 是 TryLockFile / TryLockFileShared 的竞态重试窗口。
//
// 多个进程 / 协程在同一瞬间抢建同一个锁文件时，CreateFile 可能返回
// ERROR_ACCESS_DENIED（文件正在被创建 / 正被其他句柄打开时的临时拒绝）
// 或 ERROR_SHARING_VIOLATION；这些都不是真错误，等一会重试即可。100ms
// 足以吸收这种瞬时竞态，又不会把“非阻塞获取”变成长时间等待。
const tryLockBudget = 100 * time.Millisecond

type lockMode int

const (
	lockExclusive lockMode = iota
	lockShared
)

// lockOpenRace 判断打开锁文件时遇到的是不是瞬时竞态。
func lockOpenRace(err error) bool {
	return errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_SHARING_VIOLATION)
}

// LockFile 用 LockFileEx 对锁文件首字节加独占锁；进程退出时内核自动释放。
// 锁文件以 FILE_SHARE_DELETE 打开，删除会话目录不会被阻塞。
func LockFile(path string, timeout time.Duration) (*FileLock, error) {
	return lockFile(path, lockExclusive, timeout)
}

// LockFileShared 加共享锁：多个句柄可同时持有，独占请求会被挡。
func LockFileShared(path string, timeout time.Duration) (*FileLock, error) {
	return lockFile(path, lockShared, timeout)
}

// TryLockFile 非阻塞抢独占锁：锁被占返回 ErrLocked（可 errors.Is），
// 其它错误原样返回。内部允许一个很短的 CreateFile 竞态重试。
func TryLockFile(path string) (*FileLock, error) {
	return lockFile(path, lockExclusive, tryLockBudget)
}

// TryLockFileShared 非阻塞抢共享锁：语义同 TryLockFile。
func TryLockFileShared(path string) (*FileLock, error) {
	return lockFile(path, lockShared, tryLockBudget)
}

// lockFile 是两种模式的共同实现：CreateFile 与 LockFileEx 都在重试循环内。
//
// 并发抢同一把锁时，CreateFile 会瞬时返回 ERROR_ACCESS_DENIED /
// ERROR_SHARING_VIOLATION，LockFileEx 返回 ERROR_LOCK_VIOLATION；三种都等到
// deadline 再放弃，而不是首次失败就报错（否则多窗口同时写操作记录 / 会话会
// 偶发「正被其他窗口写入：Access is denied」）。
func lockFile(path string, mode lockMode, timeout time.Duration) (*FileLock, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		handle, openErr := windows.CreateFile(
			name,
			windows.GENERIC_READ|windows.GENERIC_WRITE,
			windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil,
			windows.OPEN_ALWAYS,
			windows.FILE_ATTRIBUTE_NORMAL,
			0,
		)
		if openErr == nil {
			overlapped := new(windows.Overlapped)
			flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
			if mode == lockExclusive {
				flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
			}
			err = windows.LockFileEx(handle, flags, 0, 1, 0, overlapped)
			if err == nil {
				return &FileLock{release: func() {
					_ = windows.UnlockFileEx(handle, 0, 1, 0, overlapped)
					_ = windows.CloseHandle(handle)
				}}, nil
			}
			_ = windows.CloseHandle(handle)
			if err != windows.ERROR_LOCK_VIOLATION && !lockOpenRace(err) {
				return nil, err
			}
		} else if !lockOpenRace(openErr) {
			return nil, openErr
		}
		if !time.Now().Before(deadline) {
			return nil, fmt.Errorf("%w：等待会话写锁超时", ErrLocked)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
