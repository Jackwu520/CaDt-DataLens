package sessionlock

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
