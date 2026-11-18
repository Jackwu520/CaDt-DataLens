// Package screenshot 应用窗口截图（Windows 下 BitBlt + PNG data URL）。
package screenshot

// Capturer 截图引擎（无状态）。
type Capturer struct{}

// FindParent 返回要截图的窗口句柄（main/windowicon_windows.go 的 findWailsWindow）。
var FindParent func() uintptr

// findParent 取宿主注入的窗口句柄；未注入（非 Windows 或测试）时返回 0，
// 由平台实现决定是否降级为整屏截图。
func findParent() uintptr {
	if FindParent != nil {
		return FindParent()
	}
	return 0
}
