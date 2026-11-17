//go:build !windows

package browser

// 非 Windows 平台浏览器标签页 stub：内嵌 WebView2 仅 Windows 可用。

import "fmt"

func (h *Host) BrowserOpen(id, url, profileKey string) (map[string]string, error) {
	return nil, fmt.Errorf("当前平台不支持内嵌浏览器")
}

func (h *Host) BrowserNavigate(id string, url string) error { return browserUnsupported() }
func (h *Host) BrowserGoBack(id string) error               { return browserUnsupported() }
func (h *Host) BrowserGoForward(id string) error            { return browserUnsupported() }
func (h *Host) BrowserReload(id string) error               { return browserUnsupported() }
func (h *Host) BrowserStop(id string) error                 { return browserUnsupported() }
func (h *Host) BrowserFocus(id string) error                { return browserUnsupported() }
func (h *Host) BrowserClose(id string) error                { return browserUnsupported() }

func (h *Host) BrowserState(id string) (map[string]interface{}, error) {
	return nil, browserUnsupported()
}

func (h *Host) BrowserEval(id string, script string) (string, error) {
	return "", browserUnsupported()
}

func (h *Host) BrowserCallCDP(id string, method string, paramsJSON string) (string, error) {
	return "", browserUnsupported()
}

// BrowserSetBounds 非 Windows 无内嵌浏览器：参数名不能与接收者 h 重名（否则本文件
// 编译即报 redeclared——之前这份桩从未被编译过，2026-11-17 交叉编译才发现）。
func (h *Host) BrowserSetBounds(id string, x int, y int, w int, height int, rasterScale float64) error {
	return browserUnsupported()
}

func (h *Host) BrowserSetVisible(id string, visible bool) error    { return browserUnsupported() }
func (h *Host) BrowserCaptureScreenshot(id string) (string, error) { return "", browserUnsupported() }
func (h *Host) BrowserSnapshot(id string) (string, error)          { return "", browserUnsupported() }

func browserUnsupported() error {
	return fmt.Errorf("当前平台不支持内嵌浏览器")
}

// ActiveProfileDirs 非 Windows 没有内嵌浏览器，没有在用配置目录需要跳过。
func ActiveProfileDirs() map[string]bool { return map[string]bool{} }
