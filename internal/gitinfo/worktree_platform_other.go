//go:build !windows

package gitinfo

import (
	"fmt"
	"os"
)

// junctionSupported 非 Windows 没有目录联接：linkDepDirs 直接跳过（依赖共享是 Windows
// 专属增益，不是 worktree 的前提）。
const junctionSupported = false

// isReparsePoint 非 Windows 的等价物是符号链接（没有 junction）。
func isReparsePoint(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

// createJunction 非 Windows 无 junction；调用方已在 junctionSupported=false 时跳过，
// 这里只作为编译期符号存在，被调用视为契约错误。
func createJunction(link, target string) error {
	return fmt.Errorf("当前平台不支持目录联接（junction）：%s -> %s", link, target)
}
