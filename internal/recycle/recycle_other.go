//go:build !windows

package recycle

import "os"

// 非 Windows 平台没有回收站，直接删除。
func Move(path string) error {
	return os.RemoveAll(path)
}
