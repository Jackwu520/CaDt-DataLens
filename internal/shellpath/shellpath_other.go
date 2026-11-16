//go:build !windows

// Package shellpath 定位 Git Bash 与 PowerShell 7；非 Windows 平台没有对应解释器。
package shellpath

// FindPwsh 非 Windows 平台返回空。
func FindPwsh() string { return "" }

// FindGitBash 非 Windows 平台返回空。
func FindGitBash() string { return "" }
