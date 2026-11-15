//go:build windows

// Package atomfile：原子写盘助手（临时文件 + fsync + 原子替换），跨域共用。
package atomfile

import "golang.org/x/sys/windows"

// Replace 用 MoveFileExW 原子替换目标文件；不支持跨卷回退。
func Replace(tmp, dst string) error {
	from, err := windows.UTF16PtrFromString(tmp)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
