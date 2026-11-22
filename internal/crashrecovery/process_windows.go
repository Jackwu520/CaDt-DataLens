// process_windows.go：进程存活探针（Windows）。
package crashrecovery

import "golang.org/x/sys/windows"

// processAlive 判断进程是否还活着。OpenProcess 只要查询权限就足以判定存在，
// 不需要句柄做别的事。
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}
