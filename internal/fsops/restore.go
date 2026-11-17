package fsops

// 从系统回收站还原条目（文件树撤销删除用）。

import (
	"fmt"
	"path/filepath"
	"strings"

	"datalens/internal/recycle"
)

// RestoreEntry 把回收站中原路径为 path 的条目还原到原位置。
func (f *FS) RestoreEntry(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return fmt.Errorf("没有文件路径")
	}
	if strings.ContainsRune(path, 0) {
		return fmt.Errorf("路径包含非法字符")
	}
	clean := filepath.Clean(path)
	if filepath.Dir(clean) == clean {
		return fmt.Errorf("不能还原到根目录：%s", clean)
	}
	return recycle.Restore(clean)
}
