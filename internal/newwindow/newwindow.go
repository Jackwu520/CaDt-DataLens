// Package newwindow：拉起新的应用实例（--new-window），用于一目录一窗口与多文件多窗口。
// 不带 --new-window 时单实例锁会把参数转发给现有窗口，所以这里必须显式带上。
package newwindow

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func start(exe string, args []string, dir string) error {
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func validateDir(dir string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("没有目录")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", dir)
	}
	return dir, nil
}

// Open 开一个空白新窗口。
func Open() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return start(exe, []string{"--new-window"}, filepath.Dir(exe))
}

// OpenDir 在独立新窗口打开目录（一目录一窗口）。
// 带 --new-window 参数让新实例拿到独立 SingleInstanceLock ID，从而真正开出新窗口；
// 不改动配置里的默认打开模式（文件仍按 openMode 走）。
func OpenDir(dir string) error {
	dir, err := validateDir(dir)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return start(exe, []string{"--new-window", dir}, dir)
}

// OpenWorkspaceConversation 软切换：当前窗口已有工作区时，另开窗口打开目标工作区，
// 并把目标 AI 会话 id 传给新窗口（新窗口启动后恢复工作区环境并选中该会话）。
func OpenWorkspaceConversation(dir, sessionID string) error {
	dir, err := validateDir(dir)
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{"--new-window", dir}
	if id := strings.TrimSpace(sessionID); id != "" {
		args = append(args, "--ai-session="+id)
	}
	return start(exe, args, dir)
}

// OpenFiles 每个文件各开一个新窗口，返回实际拉起的实例数。
func OpenFiles(paths []string) (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	started := 0
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		if err := start(exe, []string{path}, filepath.Dir(path)); err != nil {
			return started, err
		}
		started++
	}
	if started == 0 {
		return 0, fmt.Errorf("没有可打开的文件")
	}
	return started, nil
}
