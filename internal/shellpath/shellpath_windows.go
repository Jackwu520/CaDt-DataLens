//go:build windows

// Package shellpath 定位 Git Bash 与 PowerShell 7；运行通道、命令桥与终端共用。
package shellpath

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// FindPwsh 定位 PowerShell 7+；找不到返回空串。
func FindPwsh() string {
	if path, err := exec.LookPath("pwsh"); err == nil {
		return path
	}
	for _, candidate := range []string{
		`C:\Program Files\PowerShell\7\pwsh.exe`,
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Microsoft", "WindowsApps", "pwsh.exe"),
	} {
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate
		}
	}
	return ""
}

// FindGitBash 定位 Git for Windows 自带的 bash.exe（排除 WSL 的 System32\bash.exe）；
// 找不到返回空串。
func FindGitBash() string {
	var candidates []string
	if gitPath, err := exec.LookPath("git"); err == nil {
		// git.exe 通常在 <Git>\cmd\ 或 <Git>\bin\ 下，回退两级得到安装根目录
		root := filepath.Dir(filepath.Dir(gitPath))
		candidates = append(candidates,
			filepath.Join(root, "bin", "bash.exe"),
			filepath.Join(root, "usr", "bin", "bash.exe"),
		)
	}
	for _, root := range []string{
		`C:\Program Files\Git`,
		`C:\Program Files (x86)\Git`,
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Git"),
	} {
		candidates = append(candidates,
			filepath.Join(root, "bin", "bash.exe"),
			filepath.Join(root, "usr", "bin", "bash.exe"),
		)
	}
	for _, c := range candidates {
		if !strings.Contains(strings.ToLower(c), "git") {
			continue // 防止误认 WSL/System32 的 bash.exe
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}
