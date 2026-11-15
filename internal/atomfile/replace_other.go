//go:build !windows

package atomfile

import "os"

// Replace 同目录 os.Rename 在 POSIX 上即原子替换。
func Replace(tmp, dst string) error {
	return os.Rename(tmp, dst)
}
