//go:build !windows

package watch

import "errors"

// Supported 报告当前平台没有可用的目录监听实现（与 watch_windows.go 成对）。
func Supported() bool { return false }

func watchDirectory(root string, stop <-chan struct{}, emit func(events []watchEvent, overflow bool)) error {
	return errors.New("当前平台不支持文件系统通知")
}
