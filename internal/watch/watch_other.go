//go:build !windows

package watch

import "errors"

func watchDirectory(root string, stop <-chan struct{}, emit func(events []watchEvent, overflow bool)) error {
	return errors.New("当前平台不支持文件系统通知")
}
