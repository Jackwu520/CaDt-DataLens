//go:build windows

package gitinfo

import (
	"fmt"
	"os/exec"
	"strings"
	"syscall"

	"datalens/internal/executil"
)

// junctionSupported Windows 有目录联接（mklink /J），依赖共享可用。
const junctionSupported = true

// isReparsePoint 判断路径是否为 junction / 符号链接。实测（Go 1.27 Windows）：os.Lstat
// 对 junction 不报 ModeSymlink 也不报 dir（mode 显示 ?---------），必须查文件属性里的
// FILE_ATTRIBUTE_REPARSE_POINT 才可靠。ReadDir/WalkDir 同理把 junction 当非目录条目
// （不会下钻，遍历安全）；os.Stat/ReadFile 则正常跟随（AI 经 junction 读写依赖可用）。
func isReparsePoint(path string) bool {
	p16, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attrs, err := syscall.GetFileAttributes(p16)
	if err != nil {
		return false
	}
	return attrs&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// createJunction 用 mklink /J 建目录联接（Windows 免管理员权限）。路径含空格由 exec 引号处理。
func createJunction(link, target string) error {
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, target)
	executil.HideCommandWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mklink /J 失败：%v（%s）", err, strings.TrimSpace(string(out)))
	}
	return nil
}
