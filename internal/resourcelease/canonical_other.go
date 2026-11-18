//go:build !windows

package resourcelease

import (
	"errors"
	"path/filepath"
	"strings"
)

// canonicalKey 把锁路径规范成进程内 map 的 key。
// Unix 路径大小写敏感，不做小写归一。
func canonicalKey(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("锁路径为空")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}
