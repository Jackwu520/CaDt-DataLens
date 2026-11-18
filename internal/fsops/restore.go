package fsops

// 从系统回收站还原条目（文件树撤销删除用）。

import (
	"fmt"
	"path/filepath"
	"strings"

	"datalens/internal/recycle"
)

// RestoreEntry 把回收站中原路径为 path 的条目还原到原位置。
// 拒绝空路径、含 NUL 的路径与盘符根目录（避免误把回收站条目还原成整个盘）；
// 真正与回收站交互的部分在 internal/recycle，这里只做参数校验与 Clean。
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
