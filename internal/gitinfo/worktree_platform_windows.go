//go:build windows

package gitinfo

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// junctionSupported Windows 有目录联接（junction），依赖共享可用。
const junctionSupported = true

// fileAttributeTagInfo 是 FILE_INFO_BY_HANDLE_CLASS.FileAttributeTagInfo 的输出布局。
type fileAttributeTagInfo struct {
	FileAttributes uint32
	ReparseTag     uint32
}

// isReparsePoint 判断路径是否为 junction / 符号链接（只认「名称代理」两类重解析点）。
// 实测（Go 1.27 Windows）：os.Lstat 对 junction 不报 ModeSymlink 也不报 dir（mode 显示
// ?---------），必须查文件属性里的 FILE_ATTRIBUTE_REPARSE_POINT；但该属性也覆盖 OneDrive
// 云占位符、去重（DEDUP）、ProjFS/GVFS 等——它们不是链接，git 递归删除不会跟进，当成链接
// 会在 sweep 里误删草稿文件、甚至让每次 discard 都 fail-closed 中止。因此按 ReparseTag 精确判定。
// ReadDir/WalkDir 把 junction 当非目录条目（不会下钻，遍历安全）；os.Stat/ReadFile 正常跟随。
func isReparsePoint(path string) bool {
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	h, err := windows.CreateFile(
		p16,
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false
		}
		// 读不到属性（ACL / 共享冲突）：保守当成链接，让清理侧 fail-closed，
		// 绝不能把「可能有链接」的目录交给 git 递归删除。
		return true
	}
	defer windows.CloseHandle(h)
	var info fileAttributeTagInfo
	if err := windows.GetFileInformationByHandleEx(
		h,
		windows.FileAttributeTagInfo,
		(*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		return true
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return false
	}
	return info.ReparseTag == windows.IO_REPARSE_TAG_MOUNT_POINT ||
		info.ReparseTag == windows.IO_REPARSE_TAG_SYMLINK
}

// createJunction 用 FSCTL_SET_REPARSE_POINT 原生建目录联接（免管理员权限）。
// 不走 cmd.exe / mklink：路径里的 & ^ % ( ) 会被 cmd 当命令分隔符/变量展开——
// 2026-11-17 复查实测 `x&echo` 会让 mklink 打印用法后把后半段当第二条命令执行，
// 且 CombinedOutput 返回 err=nil（假成功）。
func createJunction(link, target string) error {
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return err
	}
	absLink, err := filepath.Abs(link)
	if err != nil {
		return err
	}
	if err := os.Mkdir(absLink, 0o755); err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(absLink)
		}
	}()
	link16, err := windows.UTF16PtrFromString(absLink)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(
		link16,
		windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)

	// SubstituteName 用 NT 路径前缀 \??\；PrintName 用普通绝对路径（资源管理器显示用）。
	sub16, err := windows.UTF16FromString(`\??\` + absTarget)
	if err != nil {
		return err
	}
	print16, err := windows.UTF16FromString(absTarget)
	if err != nil {
		return err
	}
	pathBuf := make([]byte, 0, (len(sub16)+len(print16))*2)
	for _, units := range [][]uint16{sub16, print16} {
		for _, u := range units {
			pathBuf = append(pathBuf, byte(u), byte(u>>8))
		}
	}
	// REPARSE_DATA_BUFFER（mount point 变体）：8 字节公共头 + 8 字节 union 头 + PathBuffer。
	// 注意 MountPointReparseBuffer 没有 Flags 字段（SymbolicLink 变体才有）。
	buf := make([]byte, 16+len(pathBuf))
	binary.LittleEndian.PutUint32(buf[0:], windows.IO_REPARSE_TAG_MOUNT_POINT)
	binary.LittleEndian.PutUint16(buf[4:], uint16(8+len(pathBuf)))
	binary.LittleEndian.PutUint16(buf[8:], 0) // SubstituteNameOffset
	binary.LittleEndian.PutUint16(buf[10:], uint16((len(sub16)-1)*2))
	// PrintName 紧跟在 SubstituteName 的 NUL 之后：偏移按「含 NUL 的字节数」算
	binary.LittleEndian.PutUint16(buf[12:], uint16(len(sub16)*2))
	binary.LittleEndian.PutUint16(buf[14:], uint16((len(print16)-1)*2))
	copy(buf[16:], pathBuf)
	var returned uint32
	if err := windows.DeviceIoControl(
		h,
		windows.FSCTL_SET_REPARSE_POINT,
		&buf[0],
		uint32(len(buf)),
		nil,
		0,
		&returned,
		nil,
	); err != nil {
		return fmt.Errorf("FSCTL_SET_REPARSE_POINT 失败：%w", err)
	}
	if !isReparsePoint(absLink) {
		return fmt.Errorf("junction 创建后未被识别为链接：%s", absLink)
	}
	ok = true
	return nil
}
