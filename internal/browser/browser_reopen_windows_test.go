//go:build windows

package browser

import (
	"syscall"
	"testing"
	"unsafe"
)

// TestBrowserCloseThenReopen 同一父窗口上关掉一个标签页后再开一个（真实使用路径）。
func TestBrowserCloseThenReopen(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；go test -v -run TestBrowserCloseThenReopen 显式运行（本机 WebView2 冒烟）")
	}
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	clsPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserReopenWnd")
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
		0, 0, 480, 320, 0, 0, hinst, 0)
	if hwnd == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(hwnd, 4)
	defer procBrowserDestroyWindow.Call(hwnd)

	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return hwnd }
	defer func() { browserParentHWND = origParent }()

	app := &Host{}
	if _, err := app.BrowserOpen("t-a", "about:blank", "test"); err != nil {
		t.Fatalf("第一次 BrowserOpen: %v", err)
	}
	if err := app.BrowserClose("t-a"); err != nil {
		t.Fatalf("BrowserClose: %v", err)
	}
	if _, err := app.BrowserOpen("t-b", "about:blank", "test"); err != nil {
		t.Fatalf("关闭后再 BrowserOpen: %v", err)
	}
	if err := app.BrowserClose("t-b"); err != nil {
		t.Fatalf("BrowserClose(t-b): %v", err)
	}
}

// zOrderIndex 返回 hwnd 在 parent 直接子窗口 z 序中的位置（0 = 最上；-1 = 不在其中）。
func zOrderIndex(parent, hwnd uintptr) int {
	child, _, _ := procBrowserGetWindow.Call(parent, 5) // GW_CHILD
	for idx := 0; child != 0; idx++ {
		if child == hwnd {
			return idx
		}
		child, _, _ = procBrowserGetWindow.Call(child, 2) // GW_HWNDNEXT
	}
	return -1
}

// TestBrowserControlRaisedAboveMainWebView：主 WebView 占满客户区，内嵌控件必须被提到它上面，
// 否则原生页面被盖住，用户看到的是空白区域。
func TestBrowserControlRaisedAboveMainWebView(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；go test -v -run TestBrowserControlRaisedAboveMainWebView 显式运行")
	}
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	classPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserZOrderWnd")
	className := uintptr(unsafe.Pointer(classPtr))
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
	wc.lpszClassName = className
	if r, _, _ := procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		t.Fatal("注册测试窗口类失败")
	}
	parent, _, _ := procBrowserCreateWindowEx.Call(0, className, 0, 0x80000000, 0, 0, 480, 320, 0, 0, hinst, 0)
	if parent == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(parent, 4)
	defer procBrowserDestroyWindow.Call(parent)

	// 模拟主 WebView：铺满客户区的兄弟窗口
	cover, _, _ := procBrowserCreateWindowEx.Call(0, className, 0, 0x40000000, // WS_CHILD
		0, 0, 480, 320, parent, 0, hinst, 0)
	if cover == 0 {
		t.Fatal("创建遮罩窗口失败")
	}
	procBrowserShowWindow.Call(cover, 4)

	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return parent }
	defer func() { browserParentHWND = origParent }()

	app := &Host{}
	if _, err := app.BrowserOpen("t-z", "about:blank", "test"); err != nil {
		t.Fatalf("BrowserOpen: %v", err)
	}
	defer app.BrowserClose("t-z")
	inst := browserGet("t-z")
	if inst == nil || inst.hwndCtl == 0 {
		t.Fatal("未记录 WebView2 控件 HWND")
	}
	// 把遮罩压到最上，再走一次尺寸同步（真实路径：切标签/调窗口都会触发）
	procBrowserSetWindowPos.Call(cover, browserHwndTop, 0, 0, 0, 0,
		browserSwpNoMove|browserSwpNoSize|browserSwpNoActivate)
	if err := app.BrowserSetBounds("t-z", 0, 0, 480, 320, 1); err != nil {
		t.Fatalf("BrowserSetBounds: %v", err)
	}
	ctlIdx := zOrderIndex(parent, inst.hwndCtl)
	coverIdx := zOrderIndex(parent, cover)
	if ctlIdx < 0 || coverIdx < 0 {
		t.Fatalf("z 序查询失败 ctl=%d cover=%d", ctlIdx, coverIdx)
	}
	if ctlIdx > coverIdx {
		t.Fatalf("内嵌控件仍在主界面之下：ctl=%d cover=%d", ctlIdx, coverIdx)
	}
}

// TestBrowserEnsureZRaisesCoveredControl 覆盖「主 WebView 抢回 z 顶 → 250ms 自检把控件提回去」。
// 这条路径 2026-11-14 上线时把 GetWindow 方向写反了（GW_HWNDNEXT 是往 z 序下方走），
// 控件被压到最底时第一跳就返回 0，被当成「已在最顶」，自愈形同虚设——症状是内容区黑屏、
// 点一下（触发一次 SetBounds）才恢复。本测试同时校验幂等：已在最顶时不动 z 序。
func TestBrowserEnsureZRaisesCoveredControl(t *testing.T) {
	if !testing.Verbose() {
		t.Skip("默认跳过；go test -v -run TestBrowserEnsureZRaisesCoveredControl 显式运行")
	}
	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	classPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserEnsureZWnd")
	className := uintptr(unsafe.Pointer(classPtr))
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
	wc.lpszClassName = className
	if r, _, _ := procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		t.Fatal("注册测试窗口类失败")
	}
	parent, _, _ := procBrowserCreateWindowEx.Call(0, className, 0, 0x80000000, 0, 0, 480, 320, 0, 0, hinst, 0)
	if parent == 0 {
		t.Fatal("创建测试窗口失败")
	}
	procBrowserShowWindow.Call(parent, 4)
	defer procBrowserDestroyWindow.Call(parent)
	// 模拟主 WebView：铺满客户区的兄弟窗口
	cover, _, _ := procBrowserCreateWindowEx.Call(0, className, 0, 0x40000000, // WS_CHILD
		0, 0, 480, 320, parent, 0, hinst, 0)
	if cover == 0 {
		t.Fatal("创建遮罩窗口失败")
	}
	procBrowserShowWindow.Call(cover, 4)

	origParent := browserParentHWND
	browserParentHWND = func() uintptr { return parent }
	defer func() { browserParentHWND = origParent }()

	app := &Host{}
	if _, err := app.BrowserOpen("t-ensure", "about:blank", "test"); err != nil {
		t.Fatalf("BrowserOpen: %v", err)
	}
	defer app.BrowserClose("t-ensure")
	inst := browserGet("t-ensure")
	if inst == nil || inst.hwndCtl == 0 {
		t.Fatal("未记录 WebView2 控件 HWND")
	}
	if err := app.BrowserSetBounds("t-ensure", 0, 0, 480, 320, 1); err != nil {
		t.Fatalf("BrowserSetBounds: %v", err)
	}

	// 主 WebView 抢回 z 顶：不重设边界（模拟真实路径——矩形没变，只有 z 序被抢）
	procBrowserSetWindowPos.Call(cover, browserHwndTop, 0, 0, 0, 0,
		browserSwpNoMove|browserSwpNoSize|browserSwpNoActivate)
	if ctl, cov := zOrderIndex(parent, inst.hwndCtl), zOrderIndex(parent, cover); ctl < 0 || cov < 0 {
		t.Fatalf("z 序查询失败 ctl=%d cover=%d", ctl, cov)
	} else if ctl < cov {
		t.Fatalf("测试前置条件不成立：控件仍在遮罩之上 ctl=%d cover=%d", ctl, cov)
	}

	if err := app.BrowserEnsureZ("t-ensure"); err != nil {
		t.Fatalf("BrowserEnsureZ: %v", err)
	}
	ctlIdx := zOrderIndex(parent, inst.hwndCtl)
	coverIdx := zOrderIndex(parent, cover)
	if ctlIdx < 0 || coverIdx < 0 {
		t.Fatalf("z 序查询失败 ctl=%d cover=%d", ctlIdx, coverIdx)
	}
	if ctlIdx > coverIdx {
		t.Fatalf("BrowserEnsureZ 没有把控件提回遮罩之上：ctl=%d cover=%d", ctlIdx, coverIdx)
	}

	// 幂等：已在最顶时再调一次不应改变 z 序，也不应报错
	if err := app.BrowserEnsureZ("t-ensure"); err != nil {
		t.Fatalf("第二次 BrowserEnsureZ: %v", err)
	}
	if again := zOrderIndex(parent, inst.hwndCtl); again != ctlIdx {
		t.Fatalf("幂等性被破坏：ctl %d → %d", ctlIdx, again)
	}
}
