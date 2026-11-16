package main

// 调试控制台窗口的绑定壳：导出日志、独立窗口判定与打开；
// 日志追加与增量读取在 internal/debugconsole。

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"datalens/internal/debugconsole"
)

// ExportDebugConsoleLog 弹出保存对话框并写出调试控制台日志文本；
// 用户取消时返回空路径且不写文件。
func (a *App) ExportDebugConsoleLog(defaultName, content string) (string, error) {
	name := strings.TrimSpace(defaultName)
	if name == "" {
		name = "debug-console.log"
	}
	path, err := a.ShowSaveFileDialog("导出调试控制台日志", name, "log")
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := a.SaveFile(path, content, "lf", false, "utf-8"); err != nil {
		return "", err
	}
	return path, nil
}

// IsDebugConsoleWindow 当前进程是否作为独立调试控制台窗口运行。
func (a *App) IsDebugConsoleWindow() bool {
	return debugconsole.HasArg("--debug-console")
}

// OpenDebugConsoleWindow 以独立进程方式打开调试控制台窗口。
// 带 --new-window 让新实例使用独立单实例锁，从而真正开出新窗口。
func (a *App) OpenDebugConsoleWindow() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--new-window", "--debug-console")
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
