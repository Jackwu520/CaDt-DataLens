package plugins

// copyEntry 复制文件或目录树（插件安装/替换用；与 main/app_fs.go 的同名助手行为一致）。

import (
	"io"
	"os"
	"path/filepath"
)

func copyEntry(src, dst string, info os.FileInfo) error {
	if info.IsDir() {
		if err := os.Mkdir(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			childSrc := filepath.Join(src, entry.Name())
			childDst := filepath.Join(dst, entry.Name())
			childInfo, err := os.Stat(childSrc)
			if err != nil {
				return err
			}
			if err := copyEntry(childSrc, childDst, childInfo); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}
