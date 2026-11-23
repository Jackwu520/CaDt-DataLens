//go:build windows

package browser

// 固定视口回归：分辨率（页面 CSS 视口）与显示比例必须解耦。
// 事故背景（2026-11-23）：旧实现用 RasterizationScale 做缩放，而它只影响栅格化
// 密度、不参与布局——真机上选「375×812」页面照旧按可视框宽度布局，用户看到的是
// 「分辨率选择完全不缩放」。现在改由 ZoomFactor 承担显示比例，本用例把契约钉死：
//   - 固定视口时 window.innerWidth/innerHeight 恒等于设定值（与可视框大小无关）
//   - 可视框变小，页面不重新布局、只等比缩小渲染
//   - 传 0 恢复自适应，CSS 视口回到「可视框物理宽 / DPI 比例」
// 需本机 WebView2 Runtime；默认跳过，go test -v -run TestBrowserViewportEmulation 显式运行。

import (
	"encoding/json"
	"syscall"
	"testing"
	"time"
)

// viewportProbe 读页面自己的 CSS 视口与 devicePixelRatio。
func viewportProbe(t *testing.T, app *Host, id string) (w int, h int, dpr float64) {
	t.Helper()
	raw, err := app.BrowserEval(id, `JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})`)
	if err != nil {
		t.Fatalf("BrowserEval: %v", err)
	}
	var parsed struct {
		W   int     `json:"w"`
		H   int     `json:"h"`
		DPR float64 `json:"dpr"`
	}
	// ExecuteScript 返回的是「脚本结果再序列化一次」的 JSON：脚本给字符串时外面多一层引号
	payload := raw
	var inner string
	if err := json.Unmarshal([]byte(raw), &inner); err == nil && inner != "" {
		payload = inner
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatalf("解析视口结果失败：%v（原始=%s）", err, raw)
	}
	return parsed.W, parsed.H, parsed.DPR
}

func TestBrowserViewportEmulation(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；-v 显式运行（本机 WebView2 冒烟）")
	}
	// 主程序是 PerMonitorV2 DPI 感知，go test 默认不是；先对齐，否则量到的
	// devicePixelRatio 恒为 1，测不出高 DPI 下的换算。
	if u := syscall.NewLazyDLL("user32.dll"); u != nil {
		_, _, _ = u.NewProc("SetProcessDpiAwarenessContext").Call(uintptr(0xFFFFFFFFFFFFFFFC))
	}

	hwnd := browserReproWindow(t, "CaDtVpEmulationWnd", 960, 640)
	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return hwnd }
	defer func() { browserParentHWND = origParent }()

	app := &Host{}
	url := "data:text/html,<html><body style='margin:0'>viewport</body></html>"
	if _, err := app.BrowserOpen(nil, "t-vp", url, "test"); err != nil {
		t.Fatalf("BrowserOpen: %v", err)
	}
	defer app.BrowserClose("t-vp")
	time.Sleep(700 * time.Millisecond)

	// ① 固定 1280×720，可视框给 960×540：页面必须按 1280×720 布局
	if err := app.BrowserSetBounds("t-vp", 40, 40, 960, 540, 1280, 720); err != nil {
		t.Fatalf("BrowserSetBounds(960x540 → 1280x720): %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	w, h, dpr := viewportProbe(t, app, "t-vp")
	if w != 1280 || h != 720 {
		t.Fatalf("固定视口应为 1280x720，实际 %dx%d（缩放没生效）", w, h)
	}
	if dpr >= 1.5 {
		t.Fatalf("固定视口下页面应按缩小比例渲染，dpr 应小于显示器比例，实际 %.3f", dpr)
	}

	// ② 可视框再缩一半：页面仍是 1280×720（只缩放渲染，不重新布局）
	if err := app.BrowserSetBounds("t-vp", 40, 40, 480, 270, 1280, 720); err != nil {
		t.Fatalf("BrowserSetBounds(480x270 → 1280x720): %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	w2, h2, dpr2 := viewportProbe(t, app, "t-vp")
	if w2 != 1280 || h2 != 720 {
		t.Fatalf("可视框变化不应改变页面视口，实际 %dx%d", w2, h2)
	}
	if !(dpr2 < dpr) {
		t.Fatalf("可视框缩一半后 dpr 应更小：前 %.3f 后 %.3f", dpr, dpr2)
	}

	// ③ 换小屏预设：页面跟着换成 375×812（缩放比反推有 1px 舍入）
	if err := app.BrowserSetBounds("t-vp", 40, 40, 375, 812, 375, 812); err != nil {
		t.Fatalf("BrowserSetBounds(375x812 → 375x812): %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	w3, h3, _ := viewportProbe(t, app, "t-vp")
	if diff := w3 - 375; diff < -1 || diff > 1 {
		t.Fatalf("预设切换后视口宽应为 375，实际 %d", w3)
	}
	if diff := h3 - 812; diff < -1 || diff > 1 {
		t.Fatalf("预设切换后视口高应为 812，实际 %d", h3)
	}

	// ④ 回自适应：视口等于「物理宽 / DPI 比例」
	if err := app.BrowserSetBounds("t-vp", 40, 40, 960, 540, 0, 0); err != nil {
		t.Fatalf("BrowserSetBounds(自适应): %v", err)
	}
	time.Sleep(400 * time.Millisecond)
	w4, h4, dpr4 := viewportProbe(t, app, "t-vp")
	expectedW := int(960/dpr4 + 0.5)
	if diff := w4 - expectedW; diff < -1 || diff > 1 {
		t.Fatalf("自适应视口宽应约等于 960/dpr(%.3f)=%d，实际 %d", dpr4, expectedW, w4)
	}
	if h4 <= 0 {
		t.Fatalf("自适应视口高度异常：%d", h4)
	}
}
