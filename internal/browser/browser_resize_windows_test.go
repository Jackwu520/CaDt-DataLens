//go:build windows

package browser

// 内嵌浏览器「视口尺寸」回归测试：预设切换全链路的存活冒烟 +
// 页面 postMessage 非字符串导致整进程闪退的崩溃类回归。
// 需本机 WebView2 Runtime；默认跳过，go test -v -run 'TestBrowserViewport|TestBrowserObjectMessage' 显式运行。

import (
	"syscall"
	"testing"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
)

// browserReproWindow 建一个可见的普通父窗口（WebView2 在不可见父窗口中暂停 JS）。
func browserReproWindow(t *testing.T, className string, w, h int) uintptr {
	t.Helper()
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	clsPtr, _ := syscall.UTF16PtrFromString(className)
	var wc struct {
		cbSize, style               uint32
		lpfnWndProc                 uintptr
		cbClsExtra, cbWndExtra      int32
		hInstance, hIcon, hCursor   uintptr
		hbrBackground, lpszMenuName uintptr
		lpszClassName, hIconSm      uintptr
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	wc.lpfnWndProc = procBrowserDefWindowProcW.Addr()
	wc.hInstance = hinst
	wc.lpszClassName = uintptr(unsafe.Pointer(clsPtr))
	if r, _, _ := procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		t.Fatal("注册测试窗口类失败")
	}
	hwnd, _, _ := procBrowserCreateWindowEx.Call(
		0, uintptr(unsafe.Pointer(clsPtr)), 0, 0x80000000,
		0, 0, uintptr(w), uintptr(h), 0, 0, hinst, 0)
	if hwnd == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(hwnd, 4)
	t.Cleanup(func() { procBrowserDestroyWindow.Call(hwnd) })
	return hwnd
}

func TestBrowserViewportPresetSmoke(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；-v 显式运行（本机 WebView2 冒烟）")
	}
	hwnd := browserReproWindow(t, "CaDtBrowserReproWnd", 960, 640)
	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return hwnd }
	defer func() { browserParentHWND = origParent }()

	app := &Host{}
	if _, err := app.BrowserOpen(nil, "t-resize", "data:text/html,<html><head><meta name='viewport' content='width=device-width'><title>rp</title></head><body>resize repro</body></html>", "test"); err != nil {
		t.Fatalf("BrowserOpen: %v", err)
	}
	defer app.BrowserClose("t-resize")

	inst := browserGet("t-resize")
	if inst == nil || inst.chromium == nil {
		t.Fatal("实例未就绪")
	}
	dpr := 1.25 // 模拟 125% 缩放系统
	// 第三列是页面 CSS 视口：0 表示自适应（视觉框给多少就是多少）
	presets := [][2]int{{1280, 720}, {1440, 900}, {375, 812}, {768, 1024}, {0, 0}}

	// 两轮预设切换：第一轮单步，第二轮带并发兜底（EnsureZ/Snapshot/Hide-Show）
	for round := 0; round < 2; round++ {
		for _, p := range presets {
			x, y := 40, 90
			w, h := int(float64(p[0])*dpr), int(float64(p[1])*dpr)
			if p[0] == 0 {
				w, h = 880, 480
			}
			if err := app.BrowserSetBounds("t-resize", x, y, w, h, p[0], p[1]); err != nil {
				t.Logf("SetBounds(%dx%d): %v", p[0], p[1], err)
			}
			if round == 1 {
				_ = app.BrowserEnsureZ("t-resize")
				go func() { _, _ = app.BrowserSnapshot("t-resize") }()
				time.Sleep(60 * time.Millisecond)
				_ = app.BrowserSetVisible("t-resize", false)
				time.Sleep(60 * time.Millisecond)
				if err := app.BrowserSetBounds("t-resize", -20, y, w, h, p[0], p[1]); err != nil {
					t.Logf("负坐标 SetBounds(%dx%d): %v", p[0], p[1], err)
				}
				_ = app.BrowserSetVisible("t-resize", true)
			}
			time.Sleep(120 * time.Millisecond)
		}
	}
	// 收尾：极端尺寸（用户可输入 8000×8000）
	err := browserHostRun(func() {
		bounds := edge.Rect{Left: 0, Top: 0, Right: 10000, Bottom: 10000}
		inst.chromium.ResizeWithBounds(&bounds)
	})
	if err != nil {
		t.Logf("10000x10000: %v", err)
	}
	if browserGet("t-resize") == nil {
		t.Fatal("实例在切换过程中消失")
	}
	t.Log("repro done")
}

// TestBrowserObjectMessageQuarantine 崩溃类回归：页面 postMessage 非字符串会走库的
// errorCallback。以前该回调在 COM 派发帧里 panic/os.Exit，整个应用瞬间闪退；
// 现在必须「进程存活 + 实例隔离（browserGet 视为不存在）+ 能被正常关闭清理」。
func TestBrowserObjectMessageQuarantine(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；-v 显式运行（本机 WebView2 冒烟）")
	}
	hwnd := browserReproWindow(t, "CaDtBrowserObjMsgWnd", 640, 480)
	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return hwnd }
	defer func() { browserParentHWND = origParent }()

	app := &Host{}
	url := "data:text/html,<html><body><script>setTimeout(function(){window.chrome.webview.postMessage({a:1});},200)</script></body></html>"
	if _, err := app.BrowserOpen(nil, "t-objmsg", url, "test"); err != nil {
		t.Fatalf("BrowserOpen: %v", err)
	}
	// 泵 2 秒：让页面脚本的 postMessage 回调派发出来
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && browserGetRaw("t-objmsg") != nil && !browserGetRaw("t-objmsg").dead.Load() {
		time.Sleep(100 * time.Millisecond)
	}
	if browserGetRaw("t-objmsg") == nil {
		t.Fatal("实例被移出注册表（应只隔离、等关闭）")
	}
	if !browserGetRaw("t-objmsg").dead.Load() {
		t.Log("未观察到隔离（消息通道可能被页面绕开），继续走关闭断言")
	}
	// 隔离后常规操作必须报错而不是拖死进程
	if _, err := app.BrowserState("t-objmsg"); err == nil {
		t.Fatal("隔离实例的 BrowserState 应报错")
	}
	if err := app.BrowserSetBounds("t-objmsg", 0, 0, 640, 480, 0, 0); err == nil {
		t.Fatal("隔离实例的 BrowserSetBounds 应报错")
	}
	if err := app.BrowserClose("t-objmsg"); err != nil {
		t.Fatalf("BrowserClose: %v", err)
	}
	if browserGetRaw("t-objmsg") != nil {
		t.Fatal("关闭后实例应移出注册表")
	}
	// 同名重开必须可用（隔离不挡重建）
	if _, err := app.BrowserOpen(nil, "t-objmsg", "about:blank", "test"); err != nil {
		t.Fatalf("隔离后同名重开: %v", err)
	}
	defer app.BrowserClose("t-objmsg")
	t.Log("object-message quarantine regression done")
}
