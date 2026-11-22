//go:build !windows

// process_other.go：进程存活探针的非 Windows 桩（交叉编译必须能编）。
package crashrecovery

import (
	"os"
	"syscall"
)

// processAlive unix 用信号 0 探活；当前产品只在 Windows 发布，此桩只为跨平台编译通过。
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}
