// Package atomfile 原子写文件：同目录临时文件 + fsync + 平台替换
// （Windows 走 ReplaceFile，POSIX 走 rename），避免崩溃或断电留下半截目标文件。
//
// 只保证「目标要么是旧内容、要么是完整新内容」；临时文件名带 pid 与纳秒时间戳，
// 并发写同一目标不会互相踩；任何一步失败都会清掉临时文件。
package atomfile

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// WriteFileAtomic 先写同目录临时文件并落盘，再原子替换目标文件（0o644）。
func WriteFileAtomic(path string, data []byte) error {
	return WriteFileAtomicMode(path, data, 0o644)
}

// WriteFileAtomicMode 同 WriteFileAtomic，可指定权限位。
func WriteFileAtomicMode(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), time.Now().UnixNano())
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := Replace(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
