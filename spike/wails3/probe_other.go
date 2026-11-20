//go:build !windows

package main

// 非 Windows 平台的桩：spike 只在 Windows 上验证无边框。
func checkFrameless() {
	logf("[go] frameless 自查：非 Windows 平台跳过")
}
