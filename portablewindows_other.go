//go:build !windows

package main

// countOtherPortableWindows 是「同 exe 还有没有别的应用窗口」的 Windows 侧判定
// （portablewindows_windows.go）；非 Windows 平台没有对应的托盘/多窗口语义，恒为 0。
func countOtherPortableWindows() int { return 0 }
