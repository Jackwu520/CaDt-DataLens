package fsops

// 文件属性：属性对话框与 AI 路径校验用的只读元信息。

import (
	"fmt"
	"os"
	"strings"
)

// PathInfo 是属性对话框与 AI 路径校验共用的只读元信息快照。
// Modified 用 Unix 毫秒（前端直接 new Date(ms)）；ReadOnly 由写位判断，不反映 ACL。
type PathInfo struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	IsDir    bool   `json:"isDir"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
	ReadOnly bool   `json:"readOnly"`
}

// GetPathInfo 返回文件属性对话框需要的信息；修改时间为 Unix 毫秒。
func (f *FS) GetPathInfo(path string) (*PathInfo, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &PathInfo{
		Path:     path,
		Name:     info.Name(),
		IsDir:    info.IsDir(),
		Size:     info.Size(),
		Modified: info.ModTime().UnixMilli(),
		ReadOnly: info.Mode().Perm()&0o200 == 0,
	}, nil
}
