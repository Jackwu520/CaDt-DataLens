//go:build windows

// Package recycle：把文件移入系统回收站（Windows Shell 删除接口），非 Windows 直接删除。
// 被 delete 域、补丁撤销与 AI 会话删除共用。
package recycle

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	foDelete          = 0x0003
	fofAllowUndo      = 0x0040 // 移到回收站
	fofNoConfirmation = 0x0010
	fofNoErrorUI      = 0x0400
)

// SHFILEOPSTRUCTW 的字段顺序和宽度与 Windows Shell API 保持一致。
type shFileOpStructW struct {
	hwnd                 uintptr
	funcCode             uint32
	from                 *uint16
	to                   *uint16
	flags                uint16
	anyOperationsAborted int32
	nameMappings         uintptr
	progressTitle        *uint16
}

var shFileOperationW = windows.NewLazySystemDLL("shell32.dll").NewProc("SHFileOperationW")

// Move 调用 Windows Shell 的删除接口，默认送回收站。
func Move(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	from, err := windows.UTF16FromString(abs)
	if err != nil {
		return err
	}
	// pFrom 必须以双 NUL 结尾
	from = append(from, 0)
	op := shFileOpStructW{
		funcCode: foDelete,
		from:     &from[0],
		flags:    fofAllowUndo | fofNoConfirmation | fofNoErrorUI,
	}
	ret, _, _ := shFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if ret != 0 {
		return fmt.Errorf("移到回收站失败（错误码 0x%X）", ret)
	}
	if op.anyOperationsAborted != 0 {
		return fmt.Errorf("删除已取消")
	}
	return nil
}

// Restore 把回收站中与 originalPath 对应的条目还原到原路径。
// 只还原"本应用刚删掉的那一条"：按 $I 元数据里的原始路径精确匹配（忽略大小写与尾部分隔符），
// 同名多次删除时取删除时间最近的一条。找不到就报错，不猜测、不覆盖目标位置的现有文件。
func Restore(originalPath string) error {
	abs, err := filepath.Abs(originalPath)
	if err != nil {
		return err
	}
	// 回收站按卷存放：$Recycle.Bin 位于原文件所在盘符根目录。只扫这一个卷。
	binRoot := filepath.Join(filepath.VolumeName(abs), "$Recycle.Bin")
	sidDirs, err := os.ReadDir(binRoot)
	if err != nil {
		return fmt.Errorf("读取回收站失败：%w", err)
	}
	type candidate struct {
		meta string
		at   uint64
	}
	var best *candidate
	for _, sid := range sidDirs {
		if !sid.IsDir() {
			continue
		}
		dir := filepath.Join(binRoot, sid.Name())
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasPrefix(name, "$I") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				continue
			}
			original, err := originalPathFromMeta(raw)
			if err != nil || !sameOriginalPath(original, abs) {
				continue
			}
			at := deletedAtFromMeta(raw)
			if best == nil || at >= best.at {
				best = &candidate{meta: filepath.Join(dir, name), at: at}
			}
		}
	}
	if best == nil {
		return fmt.Errorf("回收站中找不到该路径的删除记录：%s", abs)
	}
	dataName := dataNameFromMeta(filepath.Base(best.meta))
	if dataName == "" {
		return fmt.Errorf("无法定位回收站数据文件")
	}
	data := filepath.Join(filepath.Dir(best.meta), dataName)
	if _, err := os.Lstat(data); err != nil {
		return fmt.Errorf("回收站数据文件缺失：%w", err)
	}
	if _, err := os.Lstat(abs); err == nil {
		return fmt.Errorf("原位置已存在同名文件或目录，未覆盖：%s", abs)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return fmt.Errorf("创建原目录失败：%w", err)
	}
	if err := os.Rename(data, abs); err != nil {
		return fmt.Errorf("从回收站还原失败：%w", err)
	}
	// 数据已移回，元数据留着就成了指向空文件的幽灵记录，一并删掉
	if err := os.Remove(best.meta); err != nil {
		return fmt.Errorf("回收站元数据清理失败：%w", err)
	}
	return nil
}
