//go:build !windows

package recycle

import (
	"fmt"
	"os"
)

// 非 Windows 平台没有回收站，直接删除。
func Move(path string) error {
	return os.RemoveAll(path)
}

// Restore 在非 Windows 平台没有回收站可还原。
func Restore(path string) error {
	return fmt.Errorf("当前平台不支持从回收站还原")
}
