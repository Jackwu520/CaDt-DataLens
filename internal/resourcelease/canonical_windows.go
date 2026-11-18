//go:build windows

package resourcelease

import (
	"errors"
	"path/filepath"
	"strings"
)

// canonicalKey 把锁路径规范成进程内 map 的 key。
// Windows 路径大小写不敏感，统一小写，避免 D:\ws 与 d:\ws 被当成两把锁。
func canonicalKey(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("锁路径为空")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return strings.ToLower(filepath.Clean(abs)), nil
}
