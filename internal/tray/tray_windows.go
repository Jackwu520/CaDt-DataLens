//go:build windows

package tray

// 托盘线程模型：Shell_NotifyIcon 的通知消息只会投递给「创建图标的那个线程的消息循环」，
// 所以这里单独起一个 LockOSThread 的 goroutine 跑 GetMessage 循环，窗口创建完才返回。
// 其它 goroutine 一律通过 PostMessage 让托盘线程去加/删图标，不跨线程碰 HICON 与 visible。

import (
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

const (
	trayClassName   = "CaDtDataLensTrayWnd"
	trayIconUID     = 1
	wmApp           = 0x8000
	trayCallbackMsg = wmApp + 1 // 图标上的鼠标事件
	msgAddIcon      = wmApp + 2
	msgRemoveIcon   = wmApp + 3
	msgShutdown     = wmApp + 4

	wmNull       = 0x0000
	wmDestroy    = 0x0002
	wmClose      = 0x0010
	wmCommand    = 0x0111
	wmLButtonUp  = 0x0202
	wmLButtonDbl = 0x0203
	wmRButtonUp  = 0x0205
	wmContext    = 0x007B

	// 右键菜单
	menuShowID     = 1
	menuQuitID     = 2
	mfString       = 0x00000000
	mfSeparator    = 0x00000800
	tpmRightButton = 0x0002
	tpmBottomAlign = 0x0020

	// Shell_NotifyIcon
	nimAdd     = 0x00000000
	nimDelete  = 0x00000001
	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004

	imageIcon      = 1 // IMAGE_ICON
	smCxSmIcon     = 49
	idiApplication = 32512

	errClassAlreadyExists = 1410 // ERROR_CLASS_ALREADY_EXISTS
)

var (
	trayUser32   = syscall.NewLazyDLL("user32.dll")
	trayKernel32 = syscall.NewLazyDLL("kernel32.dll")
	trayShell32  = syscall.NewLazyDLL("shell32.dll")

	procRegisterClassExW  = trayUser32.NewProc("RegisterClassExW")
	procCreateWindowExW   = trayUser32.NewProc("CreateWindowExW")
	procDefWindowProcW    = trayUser32.NewProc("DefWindowProcW")
	procDestroyWindow     = trayUser32.NewProc("DestroyWindow")
	procGetMessageW       = trayUser32.NewProc("GetMessageW")
	procTranslateMessage  = trayUser32.NewProc("TranslateMessage")
	procDispatchMessageW  = trayUser32.NewProc("DispatchMessageW")
	procPostQuitMessage   = trayUser32.NewProc("PostQuitMessage")
	procPostMessageW      = trayUser32.NewProc("PostMessageW")
	procCreatePopupMenu   = trayUser32.NewProc("CreatePopupMenu")
	procAppendMenuW       = trayUser32.NewProc("AppendMenuW")
	procTrackPopupMenu    = trayUser32.NewProc("TrackPopupMenu")
	procDestroyMenu       = trayUser32.NewProc("DestroyMenu")
	procSetForeground     = trayUser32.NewProc("SetForegroundWindow")
	procGetCursorPos      = trayUser32.NewProc("GetCursorPos")
	procLoadImageW        = trayUser32.NewProc("LoadImageW")
	procLoadIconW         = trayUser32.NewProc("LoadIconW")
	procDestroyIcon       = trayUser32.NewProc("DestroyIcon")
	procGetSystemMetrics  = trayUser32.NewProc("GetSystemMetrics")
	procRegisterWindowMsg = trayUser32.NewProc("RegisterWindowMessageW")
	procGetModuleHandleW  = trayKernel32.NewProc("GetModuleHandleW")
	procShellNotifyIconW  = trayShell32.NewProc("Shell_NotifyIconW")

	wndProcCallback = syscall.NewCallback(trayWndProc)

	// taskbarCreatedMsg 是 "TaskbarCreated" 的注册消息号：Explorer 重启后通知区被清空，
	// 收到它要重新挂图标，否则图标会「自己消失」。
	taskbarCreatedMsg uint32

	// activeTray 只在托盘线程读写（窗口创建在托盘线程里），WndProc 也跑在同一线程。
	activeTray *Tray
)

// Tray 是一个托盘图标（每进程至多一个）。
type Tray struct {
	opts Options

	startOnce sync.Once
	hwnd      atomic.Uintptr // 消息窗口句柄：托盘线程创建后写入，其它 goroutine 只读

	// icon / iconOwned 只在托盘线程读写；visible 用原子量，方便测试观察挂没挂上。
	visible   atomic.Bool
	icon      uintptr
	iconOwned bool // LoadImage 拿到的句柄要 DestroyIcon；系统共享图标不能
}

// New 只做参数打包：消息窗口等到第一次 Show 才建（没必要给每个窗口都摊一份）。
func New(opts Options) *Tray {
	return &Tray{opts: opts}
}

// Supported 报告当前平台是否能真的挂托盘图标。
func Supported() bool { return true }

// Show 把图标挂到通知区；第一次调用顺带起托盘线程。
func (t *Tray) Show() {
	t.startOnce.Do(t.start)
	if hwnd := t.hwnd.Load(); hwnd != 0 {
		procPostMessageW.Call(hwnd, msgAddIcon, 0, 0)
	}
}

// Hide 撤掉图标（窗口回到前台时不该继续占着通知区）。
func (t *Tray) Hide() {
	if hwnd := t.hwnd.Load(); hwnd != 0 {
		procPostMessageW.Call(hwnd, msgRemoveIcon, 0, 0)
	}
}

// Close 撤图标并结束托盘线程（退出程序前调用；不调也不会残留，进程结束图标自然消失）。
func (t *Tray) Close() {
	if hwnd := t.hwnd.Load(); hwnd != 0 {
		procPostMessageW.Call(hwnd, msgShutdown, 0, 0)
	}
}

func (t *Tray) start() {
	ready := make(chan uintptr, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		activeTray = t
		hwnd := createMessageWindow()
		ready <- hwnd
		if hwnd == 0 {
			logf("warn", "托盘：消息窗口创建失败，最小化到托盘不可用")
			return
		}
		var msg msgStruct
		for {
			r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if int32(r) <= 0 { // 0 = WM_QUIT，-1 = 出错
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
		}
	}()
	t.hwnd.Store(<-ready)
	registerTaskbarCreated()
}

// registerTaskbarCreated 取 "TaskbarCreated" 的注册消息号（进程内一次即可）。
func registerTaskbarCreated() {
	if taskbarCreatedMsg != 0 {
		return
	}
	name, err := syscall.UTF16PtrFromString("TaskbarCreated")
	if err != nil {
		return
	}
	if v, _, _ := procRegisterWindowMsg.Call(uintptr(unsafe.Pointer(name))); v != 0 {
		taskbarCreatedMsg = uint32(v)
	}
}

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type point struct {
	x int32
	y int32
}

// msgStruct 对应 Win32 的 MSG（x64 下 48 字节；字段够用即可，尺寸不能小于真实结构）。
type msgStruct struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
	_       uint32
}

// notifyIconData 对应 Win32 的 NOTIFYICONDATAW（x64 下 976 字节）。
type notifyIconData struct {
	cbSize           uint32
	hWnd             uintptr
	uID              uint32
	uFlags           uint32
	uCallbackMessage uint32
	hIcon            uintptr
	szTip            [128]uint16
	dwState          uint32
	dwStateMask      uint32
	szInfo           [256]uint16
	uVersion         uint32
	szInfoTitle      [64]uint16
	dwInfoFlags      uint32
	guidItem         [16]byte
	hBalloonIcon     uintptr
}

func createMessageWindow() uintptr {
	hinst, _, _ := procGetModuleHandleW.Call(0)
	cls, err := syscall.UTF16PtrFromString(trayClassName)
	if err != nil {
		return 0
	}
	wc := wndClassEx{
		cbSize:        uint32(unsafe.Sizeof(wndClassEx{})),
		lpfnWndProc:   wndProcCallback,
		hInstance:     hinst,
		lpszClassName: cls,
	}
	if atom, _, errno := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); atom == 0 {
		if errno != syscall.Errno(errClassAlreadyExists) {
			logf("warn", "托盘：窗口类注册失败（%v）", errno)
			return 0
		}
	}
	// 无样式、无父窗口的隐藏窗口：只承接 Shell_NotifyIcon 的回调消息与右键菜单。
	hwnd, _, errno := procCreateWindowExW.Call(0, uintptr(unsafe.Pointer(cls)), 0, 0, 0, 0, 0, 0, 0, 0, hinst, 0)
	if hwnd == 0 {
		logf("warn", "托盘：CreateWindowEx 失败（%v）", errno)
	}
	return hwnd
}

func trayWndProc(hwnd, umsg, wparam, lparam uintptr) uintptr {
	t := activeTray
	switch umsg {
	case trayCallbackMsg:
		if t == nil {
			break
		}
		// 老式（未 SETVERSION）回调：lParam 低字是鼠标消息
		switch uint32(lparam) & 0xFFFF {
		case wmLButtonUp, wmLButtonDbl:
			t.fire(t.opts.OnShow)
		case wmRButtonUp, wmContext:
			t.showMenu()
		}
		return 0
	case wmCommand:
		if t == nil {
			break
		}
		switch uint32(wparam) & 0xFFFF {
		case menuShowID:
			t.fire(t.opts.OnShow)
		case menuQuitID:
			t.fire(t.opts.OnQuit)
		}
		return 0
	case msgAddIcon:
		if t != nil {
			t.addIcon()
		}
		return 0
	case msgRemoveIcon:
		if t != nil {
			t.removeIcon()
		}
		return 0
	case msgShutdown:
		if t != nil {
			t.removeIcon()
		}
		procDestroyWindow.Call(hwnd)
		return 0
	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	if taskbarCreatedMsg != 0 && uint32(umsg) == taskbarCreatedMsg {
		if t != nil && t.visible.Load() {
			t.addIcon()
		}
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, umsg, wparam, lparam)
	return r
}

// fire 在独立 goroutine 里跑回调：托盘线程要留在消息循环里，
// 而回调里的窗口操作（还原窗口、走退出流程）可能弹对话框、阻塞若干秒。
func (t *Tray) fire(fn func()) {
	if fn == nil {
		return
	}
	go fn()
}

func (t *Tray) addIcon() {
	hwnd := t.hwnd.Load()
	if hwnd == 0 || t.visible.Load() {
		return
	}
	icon, owned := t.loadIcon()
	nid := notifyIconData{
		cbSize:           uint32(unsafe.Sizeof(notifyIconData{})),
		hWnd:             hwnd,
		uID:              trayIconUID,
		uFlags:           nifMessage | nifIcon | nifTip,
		uCallbackMessage: trayCallbackMsg,
		hIcon:            icon,
	}
	utf16Into(nid.szTip[:], t.opts.Tooltip)
	if r, _, errno := procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&nid))); r == 0 {
		logf("warn", "托盘：图标挂载失败（%v）", errno)
		if owned && icon != 0 {
			procDestroyIcon.Call(icon)
		}
		return
	}
	t.icon = icon
	t.iconOwned = owned
	t.visible.Store(true)
}

func (t *Tray) removeIcon() {
	hwnd := t.hwnd.Load()
	if hwnd == 0 || !t.visible.Load() {
		return
	}
	nid := notifyIconData{
		cbSize: uint32(unsafe.Sizeof(notifyIconData{})),
		hWnd:   hwnd,
		uID:    trayIconUID,
	}
	procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
	// LoadImage 没带 LR_SHARED，HICON 是我们自己的，撤图标后要销毁
	if t.icon != 0 && t.iconOwned {
		procDestroyIcon.Call(t.icon)
	}
	t.icon = 0
	t.iconOwned = false
	t.visible.Store(false)
}

// loadIcon 取 exe 内嵌图标（与任务栏同一个），失败退回系统默认应用图标。
// 第二个返回值表示句柄是否由我们新分配（决定撤图标时要不要 DestroyIcon）。
func (t *Tray) loadIcon() (uintptr, bool) {
	hinst, _, _ := procGetModuleHandleW.Call(0)
	cx, _, _ := procGetSystemMetrics.Call(smCxSmIcon)
	if hicon, _, _ := procLoadImageW.Call(hinst, t.opts.IconID, imageIcon, cx, cx, 0); hicon != 0 {
		return hicon, true
	}
	hicon, _, _ := procLoadIconW.Call(0, idiApplication)
	return hicon, false
}

func (t *Tray) showMenu() {
	hwnd := t.hwnd.Load()
	hmenu, _, _ := procCreatePopupMenu.Call()
	if hmenu == 0 || hwnd == 0 {
		return
	}
	defer procDestroyMenu.Call(hmenu)
	appendMenuItem(hmenu, menuShowID, "显示主窗口")
	procAppendMenuW.Call(hmenu, mfSeparator, 0, 0)
	appendMenuItem(hmenu, menuQuitID, "退出 CaDt-DataLens")

	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	// 弹菜单前先抢前台，弹完补一条 WM_NULL：否则点菜单外面菜单不会消失（Windows 老毛病）。
	procSetForeground.Call(hwnd)
	procTrackPopupMenu.Call(hmenu, tpmRightButton|tpmBottomAlign,
		uintptr(int64(pt.x)), uintptr(int64(pt.y)), 0, hwnd, 0)
	procPostMessageW.Call(hwnd, wmNull, 0, 0)
}

func appendMenuItem(hmenu, id uintptr, label string) {
	text, err := syscall.UTF16PtrFromString(label)
	if err != nil {
		return
	}
	procAppendMenuW.Call(hmenu, mfString, id, uintptr(unsafe.Pointer(text)))
}

// utf16Into 把 s 写成以 NUL 结尾的 UTF-16（放不下就截断，末尾一定是 NUL）。
func utf16Into(dst []uint16, s string) {
	if len(dst) == 0 {
		return
	}
	u, err := syscall.UTF16FromString(s)
	if err != nil {
		u = []uint16{0}
	}
	if len(u) > len(dst) {
		u = u[:len(dst)-1]
		u = append(u, 0)
	}
	copy(dst, u)
}
