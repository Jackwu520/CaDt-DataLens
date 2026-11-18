// Package sessionlock 跨进程独占写锁：Windows 走 LockFileEx，其它平台走 flock。
//
// 用于 sessionstore / activity / ai_worklog 这类追加式文件——多窗口即多进程，
// 写入前必须拿锁、写完释放；锁粒度是一个文件一个句柄，不做读锁共享。
package sessionlock

import "errors"

// ErrLocked 表示锁已被其它句柄/进程占用。
//
// LockFile / LockFileShared 超时会返回包装了该哨兵的错误；TryLockFile /
// TryLockFileShared 失败时也用它，调用方可以统一用 errors.Is 判断“忙”而不是
// “IO 错误”。资源租约层依赖这个区分做 fail-closed 与只读降级。
var ErrLocked = errors.New("资源写锁已被占用")

// FileLock 是跨进程写锁的句柄：平台实现在 lock_windows.go / lock_other.go。
type FileLock struct {
	release func()
}

// Release 释放锁并关闭句柄。只应调用一次（调用方用 defer 释放）。
func (l *FileLock) Release() {
	if l != nil && l.release != nil {
		l.release()
	}
}
