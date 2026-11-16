//go:build windows

package browser

// 浏览器使用标签页内核：宿主线程（STA + 消息泵）上创建/操作嵌入式 WebView2，
// 绑定方法从 Wails goroutine 封送任务到宿主线程执行。
// CDP 槽位调用见 browser_com_windows.go。

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"datalens/internal/appdata"

	"github.com/wailsapp/go-webview2/pkg/edge"
)

const (
	browserDispatchMsg = 0xBACC // 消息窗口私有任务派发消息
	browserCDPTimeout  = 30 * time.Second
	browserJobTimeout  = 60 * time.Second // 单任务看门狗（Embed 创建最长约 20s）
)

var (
	browserUser32                        = syscall.NewLazyDLL("user32.dll")
	procBrowserRegisterClassW            = browserUser32.NewProc("RegisterClassExW")
	procBrowserCreateWindowEx            = browserUser32.NewProc("CreateWindowExW")
	procBrowserDefWindowProcW            = browserUser32.NewProc("DefWindowProcW")
	procBrowserGetMessageW               = browserUser32.NewProc("GetMessageW")
	procBrowserTranslateMsg              = browserUser32.NewProc("TranslateMessage")
	procBrowserDispatchMsg               = browserUser32.NewProc("DispatchMessageW")
	procBrowserPostMessageW              = browserUser32.NewProc("PostMessageW")
	procBrowserShowWindow                = browserUser32.NewProc("ShowWindow")
	procBrowserDestroyWindow             = browserUser32.NewProc("DestroyWindow")
	procBrowserPeekMessageW              = browserUser32.NewProc("PeekMessageW")
	procBrowserMsgWaitForMultipleObjects = browserUser32.NewProc("MsgWaitForMultipleObjects")
	procBrowserEnumChildWindows          = browserUser32.NewProc("EnumChildWindows")
	procBrowserGetClassNameW             = browserUser32.NewProc("GetClassNameW")
	procBrowserSetWindowPos              = browserUser32.NewProc("SetWindowPos")
	procBrowserGetWindow                 = browserUser32.NewProc("GetWindow")
	procBrowserIsWindowVisible           = browserUser32.NewProc("IsWindowVisible")

	browserOle32Host          = syscall.NewLazyDLL("ole32.dll")
	procBrowserCoInitializeEx = browserOle32Host.NewProc("CoInitializeEx")
	procBrowserCoUninitialize = browserOle32Host.NewProc("CoUninitialize")

	browserKernel32Host        = syscall.NewLazyDLL("kernel32.dll")
	procBrowserGetModuleHandle = browserKernel32Host.NewProc("GetModuleHandleW")
)

type browserMsg struct {
	hwnd     uintptr
	message  uint32
	wParam   uintptr
	lParam   uintptr
	time     uint32
	ptX, ptY int32
}

// ---- 宿主线程 ----

var (
	browserHostOnce  sync.Once
	browserHostTasks chan func()
	browserHostHWND  uintptr
	browserHostReady chan struct{}
	browserHostErr   error
)

// browserInitCOM 在当前线程把 COM 公寓初始化为 STA（WebView2 的硬要求）。
// Go 的 OS 线程会被复用：系统通知等库可能已在线程上残留 MTA 初始化（RoInitialize），
// 此时 CoInitializeEx(STA) 返回 RPC_E_CHANGED_MODE。宿主线程已经 LockOSThread 独占，
// 这里把残留的 MTA 初始化逐个撤销后重试 STA。
func browserInitCOM() error {
	for attempt := 0; attempt < 8; attempt++ {
		hr, _, _ := procBrowserCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
		switch hr {
		case 0, 1: // S_OK / S_FALSE（已是 STA）
			return nil
		case 0x80010106: // RPC_E_CHANGED_MODE
			procBrowserCoUninitialize.Call()
		default:
			return fmt.Errorf("浏览器宿主线程 COM 初始化失败 0x%08x", hr)
		}
	}
	return fmt.Errorf("浏览器宿主线程无法进入 STA 公寓（残留 MTA 初始化过多）")
}

func browserHostWndProc(hwnd, msg, wParam, lParam uintptr) uintptr {
	if msg == browserDispatchMsg {
		for {
			select {
			case task := <-browserHostTasks:
				runBrowserTask(task)
			default:
				return 0
			}
		}
	}
	r, _, _ := procBrowserDefWindowProcW.Call(hwnd, msg, wParam, lParam)
	return r
}

func runBrowserTask(task func()) {
	defer func() {
		if r := recover(); r != nil {
			logf("ERROR", "浏览器宿主任务崩溃：%v", r)
		}
	}()
	task()
}

func browserHostFail(format string, args ...interface{}) {
	browserHostErr = fmt.Errorf(format, args...)
	logf("ERROR", "browser-host 初始化失败：%v", browserHostErr)
	close(browserHostReady)
}

func browserHostLoop() {
	runtime.LockOSThread()
	if err := browserInitCOM(); err != nil {
		browserHostFail("%v", err)
		return
	}
	defer procBrowserCoUninitialize.Call()

	hinst, _, _ := procBrowserGetModuleHandle.Call(0)
	classPtr, _ := syscall.UTF16PtrFromString("CaDtBrowserHost")
	var wc struct {
		cbSize, style               uint32
		lpfnWndProc                 uintptr
		cbClsExtra, cbWndExtra      int32
		hInstance, hIcon, hCursor   uintptr
		hbrBackground, lpszMenuName uintptr
		lpszClassName, hIconSm      uintptr
	}
	wc.cbSize = uint32(unsafe.Sizeof(wc))
	wc.lpfnWndProc = syscall.NewCallback(browserHostWndProc)
	wc.hInstance = hinst
	wc.lpszClassName = uintptr(unsafe.Pointer(classPtr))
	if r, _, _ := procBrowserRegisterClassW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		browserHostFail("浏览器宿主注册窗口类失败")
		return
	}
	// HWND_MESSAGE = -3（message-only 窗口）
	browserHostHWND, _, _ = procBrowserCreateWindowEx.Call(
		0, uintptr(unsafe.Pointer(classPtr)), 0, 0,
		0, 0, 0, 0, ^uintptr(2), 0, hinst, 0)
	if browserHostHWND == 0 {
		browserHostFail("浏览器宿主创建窗口失败")
		return
	}
	close(browserHostReady)

	// COM STA 标准泵：MsgWaitForMultipleObjects + PeekMessage（阻塞 GetMessage 下
	// WebView2 的回调派发会异常终止进程，见 2026-11-11 调试记录）
	var msg browserMsg
	for {
		for {
			select {
			case task := <-browserHostTasks:
				runBrowserTask(task)
			default:
				goto pump
			}
		}
	pump:
		for {
			r, _, _ := procBrowserPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1) // PM_REMOVE
			if r == 0 || int32(r) == -1 {
				break
			}
			procBrowserTranslateMsg.Call(uintptr(unsafe.Pointer(&msg)))
			procBrowserDispatchMsg.Call(uintptr(unsafe.Pointer(&msg)))
		}
		procBrowserMsgWaitForMultipleObjects.Call(0, 0, 0, 50, 0x4FF) // QS_ALLINPUT，最多等 50ms
	}
}

// browserHostRun 在宿主线程上执行任务并等待完成；任务内错误经闭包变量传递。
// 带看门狗：宿主线程卡死（如 WebView2 controller 创建失败时库的内联泵不会解除阻塞）时返回超时错误，不拖死调用方。
func browserHostRun(task func()) error {
	browserHostOnce.Do(func() {
		browserHostTasks = make(chan func(), 64)
		browserHostReady = make(chan struct{})
		go browserHostLoop()
	})
	<-browserHostReady
	// 宿主初始化失败要立刻报错，不能把任务排进无人消费的队列干等看门狗超时
	if browserHostErr != nil {
		return browserHostErr
	}
	if browserHostHWND == 0 {
		return fmt.Errorf("浏览器宿主窗口未就绪")
	}
	done := make(chan error, 1)
	browserHostTasks <- func() {
		defer func() {
			if r := recover(); r != nil {
				select {
				case done <- fmt.Errorf("任务异常：%v", r):
				default:
				}
			}
		}()
		task()
		select {
		case done <- nil:
		default:
		}
	}
	r, _, _ := procBrowserPostMessageW.Call(browserHostHWND, browserDispatchMsg, 0, 0)
	if r == 0 {
		return fmt.Errorf("浏览器宿主调度失败")
	}
	select {
	case err := <-done:
		return err
	case <-time.After(browserJobTimeout):
		return fmt.Errorf("浏览器任务超时（%.0fs），宿主线程可能已卡住", browserJobTimeout.Seconds())
	}
}

// ---- 实例管理 ----

type browserInstance struct {
	id         string
	profileKey string
	chromium   *edge.Chromium
	controller *edge.ICoreWebView2Controller
	ctrl3      *edge.ICoreWebView2Controller3 // 栅格缩放用（QI 一次缓存，Close 时 Release）
	webview    *edge.ICoreWebView2
	hwndCtl    uintptr // WebView2 控件自己的 HWND（z 序调整用）
	url        string
	title      string
	canGoBack  bool
	canGoFwd   bool
	loading    bool
	visible    bool
	raster     float64     // 当前生效的 RasterizationScale（宿主线程读写）
	dead       atomic.Bool // 内核错误后隔离：该实例不再接受操作，只等关闭
	emit       func(event string, data interface{})
}

var (
	browserMu        sync.Mutex
	browserInstances = map[string]*browserInstance{}
)

// ---- 子窗口 z 序：主 WebView 占满客户区，内嵌控件默认会被它盖住 ----

const (
	browserHwndTop       = 0
	browserSwpNoSize     = 0x0001
	browserSwpNoMove     = 0x0002
	browserSwpNoActivate = 0x0010
	// GetWindow 方向：GW_HWNDPREV 往 z 序**上方**、GW_HWNDNEXT 往**下方**。
	// z 序自检找「谁压在我上面」只能用 PREV（上一版用了 NEXT，方向反了）。
	browserGwHwndPrev = 3
)

var browserChildHwnds []uintptr

var browserEnumChildProc = syscall.NewCallback(func(hwnd, _ uintptr) uintptr {
	var buf [64]uint16
	n, _, _ := procBrowserGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n > 0 && syscall.UTF16ToString(buf[:n]) == "Chrome_WidgetWin_0" {
		browserChildHwnds = append(browserChildHwnds, hwnd)
	}
	return 1
})

// browserWebviewChildren 列出父窗口下所有 WebView2 顶层控件（宿主线程调用）。
func browserWebviewChildren(parent uintptr) map[uintptr]bool {
	browserChildHwnds = browserChildHwnds[:0]
	procBrowserEnumChildWindows.Call(parent, browserEnumChildProc, 0)
	out := make(map[uintptr]bool, len(browserChildHwnds))
	for _, h := range browserChildHwnds {
		out[h] = true
	}
	return out
}

// browserRaiseControl 把内嵌控件提到主 WebView 之上（否则原生控件被盖住，页面看着像空白）。
func browserRaiseControl(inst *browserInstance) {
	if inst.hwndCtl == 0 {
		return
	}
	procBrowserSetWindowPos.Call(inst.hwndCtl, browserHwndTop, 0, 0, 0, 0,
		browserSwpNoMove|browserSwpNoSize|browserSwpNoActivate)
}

// BrowserEnsureZ z 序幂等自检：主 WebView 重建/重排控件窗口时会重新抢占子窗口
// z 顶，把内嵌控件盖回下面——用户看到内容区「黑屏」，点一下（触发重新同步 /
// 一次 SetBounds）才恢复（2026-11-14 实测）。前端 250ms 兜底轮询无条件调用本方法；
// 控件已在 z 顶（或上方只有隐藏兄弟）时零副作用。
func (h *Host) BrowserEnsureZ(id string) error {
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.hwndCtl == 0 || !inst.visible {
			return
		}
		// 沿 GW_HWNDPREV 往 z 序**上方**找：上方还有可见兄弟（主 WebView 抢回了 z 顶）
		// 才提顶。方向必须是 PREV——GW_HWNDNEXT 是往下方走，控件被压到最底时
		// GetWindow 立刻返回 0，上一版据此判成「已在最顶」，自愈其实一次都没提过顶
		// （2026-11-15 复查：症状复发即此故）。
		for h := inst.hwndCtl; ; {
			above, _, _ := procBrowserGetWindow.Call(h, browserGwHwndPrev)
			if above == 0 {
				return // 上方没有兄弟：已经在最顶
			}
			h = above
			if vis, _, _ := procBrowserIsWindowVisible.Call(h); vis != 0 {
				browserRaiseControl(inst)
				return
			}
		}
	})
	return jobErr
}

// browserParentHWND 返回 WebView2 控件的宿主父窗口（生产 = Wails 主窗口；测试可替换）。
var browserParentHWND = func() uintptr {
	if FindParent != nil {
		return FindParent()
	}
	return 0
}

func browserGet(id string) *browserInstance {
	browserMu.Lock()
	defer browserMu.Unlock()
	inst := browserInstances[id]
	if inst != nil && inst.dead.Load() {
		return nil // 已隔离实例：按不存在报错，前端提示关标签页重开
	}
	return inst
}

// browserGetRaw 不做失效过滤：关闭路径要能触达 dead 实例，完成资源清理。
func browserGetRaw(id string) *browserInstance {
	browserMu.Lock()
	defer browserMu.Unlock()
	return browserInstances[id]
}

// ActiveProfileDirs 列出仍然存活的实例各自占用的配置目录名。
// 「存储与清理」清除内嵌浏览器数据时按它跳过在用实例——
// 删了既会被 WebView2 进程拒绝，又会让正开着的标签页当场失联。
func ActiveProfileDirs() map[string]bool {
	browserMu.Lock()
	defer browserMu.Unlock()
	out := make(map[string]bool, len(browserInstances))
	for _, inst := range browserInstances {
		if inst == nil {
			continue
		}
		out[sanitizeBrowserProfileKey(inst.id+"_"+inst.profileKey)] = true
	}
	return out
}

// browserKillInstance 隔离一个出错的内核实例：记日志 + 通知前端，进程存活。
// 只在宿主线程（含 COM 回调上下文）调用。
func browserKillInstance(inst *browserInstance, source string, err error) {
	first := !inst.dead.Swap(true)
	logf("ERROR", "browser-%s 内核错误（%s，实例已隔离，请关闭标签页后重开）：%v\n%s",
		inst.id, source, err, debug.Stack())
	if first && inst.emit != nil {
		inst.emit("browser-error", map[string]interface{}{"id": inst.id})
	}
}

// browserCallbackGuard 包住库回调入口：回调跑在 COM 派发帧上，Go panic 穿不过
// 原生栈会直接击穿整个进程，这里兜住并隔离实例。
func browserCallbackGuard(inst *browserInstance, name string, fn func()) {
	defer func() {
		if r := recover(); r != nil {
			browserKillInstance(inst, name, fmt.Errorf("%v", r))
		}
	}()
	fn()
}

// browserRefreshState 导航状态刷新（宿主线程调用），并向前端发 browser-nav 事件。
func browserRefreshState(inst *browserInstance) {
	if inst.webview == nil {
		return
	}
	if url, err := inst.webview.GetSource(); err == nil {
		inst.url = url
	}
	if title, err := wvStringOut(inst.webview, wvSlotGetDocumentTitle); err == nil {
		inst.title = title
	}
	if back, err := wvInt32Out(inst.webview, wvSlotGetCanGoBack); err == nil {
		inst.canGoBack = back != 0
	}
	if fwd, err := wvInt32Out(inst.webview, wvSlotGetCanGoForward); err == nil {
		inst.canGoFwd = fwd != 0
	}
	if inst.emit != nil {
		inst.emit("browser-nav", map[string]interface{}{
			"id": inst.id, "url": inst.url, "title": inst.title,
			"canGoBack": inst.canGoBack, "canGoForward": inst.canGoFwd, "loading": inst.loading,
		})
	}
}

// browserNotifyLoading 只广播 loading 状态（导航刚开始时页面还是旧 URL，
// 不能走 browserRefreshState 把地址栏覆盖回去）。
func browserNotifyLoading(inst *browserInstance) {
	if inst.emit == nil {
		return
	}
	inst.emit("browser-nav", map[string]interface{}{"id": inst.id, "loading": inst.loading})
}

// browserCreateOnHost 在宿主线程上创建实例（Embed 自带消息泵，同步等到 controller 就绪）。
func browserCreateOnHost(inst *browserInstance, hwnd uintptr) error {
	c := edge.NewChromium()
	// 库的 errorCallback 已本地补丁为「只回调、不退出」；这里把出错实例隔离掉，
	// 绝不再 panic——panic 无法穿过 COM 回调的原生帧，以前表现为整个应用瞬间闪退
	// （2026-11-16 定位：切视口预设 → 页面走 window.external/invoke →
	// MessageReceived 解消息失败 → 回调里 panic → 进程直接没了）。
	c.SetErrorCallback(func(err error) {
		browserKillInstance(inst, "errorCallback", err)
	})
	c.DataPath = filepath.Join(appdata.Root(), ProfileRoot, sanitizeBrowserProfileKey(inst.id+"_"+inst.profileKey))
	c.NavigationCompletedCallback = func(sender *edge.ICoreWebView2, args *edge.ICoreWebView2NavigationCompletedEventArgs) {
		browserCallbackGuard(inst, "NavigationCompleted", func() {
			inst.loading = false
			browserRefreshState(inst)
		})
	}
	c.ProcessFailedCallback = func(sender *edge.ICoreWebView2, args *edge.ICoreWebView2ProcessFailedEventArgs) {
		browserCallbackGuard(inst, "ProcessFailed", func() {
			inst.loading = false
			if inst.emit != nil {
				inst.emit("browser-error", map[string]interface{}{"id": inst.id})
			}
		})
	}
	inst.chromium = c
	before := browserWebviewChildren(hwnd)
	if !c.Embed(hwnd) {
		return fmt.Errorf("创建浏览器控件失败")
	}
	// Embed 会新建一个 Chrome_WidgetWin_0 子窗口；找出来记住，后面调 z 序用
	for h := range browserWebviewChildren(hwnd) {
		if !before[h] {
			inst.hwndCtl = h
			break
		}
	}
	if inst.hwndCtl == 0 {
		logf("WARN", "browser-%s：未找到 WebView2 控件窗口，页面可能被主界面遮挡", inst.id)
	}
	ctrl := c.GetController()
	wv, err := ctrl.GetCoreWebView2()
	if err != nil {
		return fmt.Errorf("获取浏览器内核失败：%w", err)
	}
	inst.controller = ctrl
	inst.webview = wv
	if err := wvInitScript(wv, `window.__cadtHost = 'datalens';`); err != nil {
		return err
	}
	// 创建即隐藏（2026-11-15）：Embed 到前端首次 SetBounds 之间，控件以库默认矩形
	// 裸露——最大化首开时用户看到整块黑屏（页面其实已在加载，状态栏有 URL）。
	// 先 Hide，前端第一次 BrowserSetBounds 自带 Show（w/h>0 → Resize+Show），
	// 控件直接以正确矩形出现，黑屏窗口变成标签页背景色的一瞬。
	inst.visible = false
	_ = c.Hide()
	if inst.url != "" && inst.url != "about:blank" {
		if err := wvNavigate(wv, inst.url); err != nil {
			return err
		}
		inst.loading = true
	}
	return nil
}

// ---- App 绑定方法 ----

func (h *Host) BrowserOpen(id, url, profileKey string) (map[string]string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, fmt.Errorf("id 不能为空")
	}
	profileKey = strings.TrimSpace(profileKey)
	if profileKey == "" {
		profileKey = "default"
	}
	if strings.TrimSpace(url) == "" {
		url = "about:blank"
	}
	browserMu.Lock()
	if len(browserInstances) >= browserMaxInstances {
		browserMu.Unlock()
		return nil, fmt.Errorf("浏览器标签页最多同时 %d 个，请先关闭一些", browserMaxInstances)
	}
	if browserInstances[id] != nil {
		browserMu.Unlock()
		return nil, fmt.Errorf("浏览器标签页 %s 已存在", id)
	}
	inst := &browserInstance{id: id, profileKey: profileKey, url: url, emit: emit}
	browserInstances[id] = inst
	browserMu.Unlock()

	hwnd := browserParentHWND()
	if hwnd == 0 {
		browserMu.Lock()
		delete(browserInstances, id)
		browserMu.Unlock()
		return nil, fmt.Errorf("找不到主窗口")
	}
	var createErr error
	jobErr := browserHostRun(func() {
		createErr = browserCreateOnHost(inst, hwnd)
	})
	if jobErr != nil || createErr != nil || inst.dead.Load() {
		browserMu.Lock()
		delete(browserInstances, id)
		browserMu.Unlock()
		if jobErr != nil {
			return nil, jobErr
		}
		if createErr != nil {
			return nil, createErr
		}
		return nil, fmt.Errorf("创建浏览器控件失败：内核错误（详情见运行日志）")
	}
	return map[string]string{"id": inst.id, "url": inst.url, "title": inst.title}, nil
}

func browserWrapErr(id string, err error) error {
	if err != nil {
		return err
	}
	return fmt.Errorf("浏览器标签页未就绪：%s", id)
}

func (h *Host) BrowserNavigate(id string, url string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		// webview 在 browserCreateOnHost 里晚于 chromium 赋值（355/376 行），
		// 异步创建窗口期调导航会对 nil 解引用 panic——首次导航必崩、重试即过
		// 的初始化竞态（2026-11-14）。守卫与 BrowserGoBack 对齐查 webview。
		if inst == nil || inst.webview == nil || inst.chromium == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在或未就绪：%s", id)
			return
		}
		inst.loading = true
		if taskErr = wvNavigate(inst.webview, url); taskErr != nil {
			return
		}
		// 让前端立刻拿到 loading=true（「停止加载」可用），完成回调会再发一次 loading=false
		browserNotifyLoading(inst)
		// 任务内泵等导航完成（回调依赖宿主线程泵）；超时不视为错误，状态事件照发
		deadline := time.Now().Add(3 * time.Second)
		var msg browserMsg
		for time.Now().Before(deadline) && inst.loading {
			r, _, _ := procBrowserPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1)
			if r != 0 && int32(r) != -1 {
				procBrowserTranslateMsg.Call(uintptr(unsafe.Pointer(&msg)))
				procBrowserDispatchMsg.Call(uintptr(unsafe.Pointer(&msg)))
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (h *Host) BrowserGoBack(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		taskErr = wvGoBack(inst.webview)
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (h *Host) BrowserGoForward(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		taskErr = wvGoForward(inst.webview)
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (h *Host) BrowserReload(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		inst.loading = true
		taskErr = wvReload(inst.webview)
		if taskErr == nil {
			browserNotifyLoading(inst)
		}
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (h *Host) BrowserStop(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		taskErr = wvStop(inst.webview)
		if taskErr == nil {
			inst.loading = false
			browserNotifyLoading(inst)
		}
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (h *Host) BrowserState(id string) (map[string]interface{}, error) {
	var state map[string]interface{}
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在：%s", id)
			return
		}
		browserRefreshState(inst)
		state = map[string]interface{}{
			"id": inst.id, "url": inst.url, "title": inst.title,
			"canGoBack": inst.canGoBack, "canGoForward": inst.canGoFwd, "loading": inst.loading,
		}
	})
	if jobErr != nil {
		return nil, jobErr
	}
	return state, taskErr
}

// jsonStringValue 把字符串编码为 JSON 字符串字面量（表达式内嵌用）。
func jsonStringValue(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

func (h *Host) BrowserEval(id string, script string) (string, error) {
	var result string
	var handler *browserCDPHandler
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		handler, taskErr = wvCallExecScriptStart(inst.webview, script)
		if taskErr != nil {
			return
		}
		result, taskErr = handler.waitPump(browserCDPTimeout)
	})
	if jobErr != nil {
		return "", jobErr
	}
	return result, taskErr
}

// BrowserCallCDP 直连 DevTools Protocol 通道。CallDevToolsProtocolMethod（槽位 36）
// 在部分 WebView2 环境调用即崩溃（2026-11-11 调试记录，与 handler 实现无关），暂不开放；
// 截图走 BrowserCaptureScreenshot（CapturePreview），页面脚本走 BrowserEval（ExecuteScript）。
func (h *Host) BrowserCallCDP(id string, method string, paramsJSON string) (string, error) {
	if browserGet(id) == nil {
		return "", fmt.Errorf("浏览器标签页不存在：%s", id)
	}
	return "", fmt.Errorf("CDP 通道暂不可用（%s）", method)
}

// BrowserCaptureScreenshot 抓取当前页面为 PNG，返回 base64。
//
// 隐藏态的 WebView2 会暂停渲染，CapturePreview 的完成回调永远不来（实测卡满 30s 超时）——
// 而 browser_screenshot 恰好最常发生在「用户切到 AI 面板」之后，这时标签页正是隐藏的。
// 所以抓图前临时 Show 一下（不 Focus、不 Raise、不改边界），抓完立即还原 Hide。
func (h *Host) BrowserCaptureScreenshot(id string) (string, error) {
	var result string
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil {
			taskErr = browserWrapErr(id, nil)
			return
		}
		wasVisible := inst.visible
		if !wasVisible && inst.chromium != nil {
			_ = inst.chromium.Show()
			defer func() { _ = inst.chromium.Hide() }()
			// Show() 之后的第一帧还没提交，此时抓图会拿到整幅白图——先等它合成一帧再抓
			wvWaitForPaint(inst.webview, browserCapturePaintTimeout)
		}
		result, taskErr = browserCaptureWithRetry(
			func() (string, error) { return wvCaptureScreenshot(inst.webview, browserCDPTimeout) },
			func() { wvWaitForPaint(inst.webview, browserCapturePaintTimeout) },
			browserCaptureAttempts)
		if taskErr != nil && !wasVisible {
			taskErr = fmt.Errorf("%w（抓图前该标签页为隐藏态，已临时显示后重试；标签页=%s）", taskErr, id)
		}
	})
	if jobErr != nil {
		return "", jobErr
	}
	return result, taskErr
}

// browserSnapshotTimeout 定格帧抓图的硬上限：浮层打开时必须尽快隐藏原生控件，
// 这里只允许一次 CapturePreview、最多等 300ms，绝不把宿主线程拖进 30s 超时。
const browserSnapshotTimeout = 300 * time.Millisecond

// BrowserSnapshot 抓当前可见网页的一帧（PNG base64），供浮层遮挡时的定格占位图使用。
// 与 BrowserCaptureScreenshot（AI 的 browser_screenshot 工具）的区别：
//   - 只在控件可见时抓；隐藏态直接返回空串，不临时 Show（否则原生控件会在弹层上闪一下）；
//   - 单次尝试、短超时、不等帧、不重试，失败或空白帧一律返回空串（前端沿用上一张或留白）。
func (h *Host) BrowserSnapshot(id string) (string, error) {
	var result string
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil || inst.webview == nil || !inst.visible {
			return
		}
		shot, err := wvCaptureScreenshot(inst.webview, browserSnapshotTimeout)
		if err != nil || browserCaptureLooksBlank(shot) {
			return
		}
		result = shot
	})
	return result, jobErr
}

// BrowserSetBounds 摆位并显示内嵌控件；x/y/w/h 为父窗口客户区物理像素。
// rasterScale>0 时同步设置 RasterizationScale（CSS 像素 = 物理尺寸/该值）：
// 自适应模式传设备缩放比，固定视口模式传「缩放比×适配系数」，让页面逻辑视口
// 保持用户设定的宽高、画面等比缩进标签页区域，而不是把控件铺到区域外面
// （2026-11-16 修复固定视口盖住其他界面）。
func (*Host) BrowserSetBounds(id string, x int, y int, w int, h int, rasterScale float64) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在或未就绪：%s", id)
			return
		}
		if inst.chromium == nil {
			return
		}
		if w <= 0 || h <= 0 {
			if inst.visible {
				_ = inst.chromium.Hide()
				inst.visible = false
			}
			return
		}
		bounds := edge.Rect{Left: int32(x), Top: int32(y), Right: int32(x + w), Bottom: int32(y + h)}
		inst.chromium.ResizeWithBounds(&bounds)
		browserApplyRasterScale(inst, rasterScale)
		if !inst.visible {
			_ = inst.chromium.Show()
			inst.visible = true
		}
		browserRaiseControl(inst)
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

// browserApplyRasterScale 设置控件栅格缩放（宿主线程调用）。老 Runtime 拿不到
// Controller3 或调用失败时只记一次日志，不影响摆位。
func browserApplyRasterScale(inst *browserInstance, scale float64) {
	if scale <= 0 || inst.raster == scale {
		return
	}
	if inst.ctrl3 == nil {
		if inst.controller == nil {
			return
		}
		c3 := inst.controller.GetICoreWebView2Controller3()
		if c3 == nil {
			logf("WARN", "browser-%s：Runtime 不支持 RasterizationScale，固定视口按 1:1 摆位", inst.id)
			inst.raster = scale // 记住期望值，避免每次摆位重复查询
			return
		}
		inst.ctrl3 = c3
	}
	if err := inst.ctrl3.PutRasterizationScale(scale); err != nil {
		logf("WARN", "browser-%s：设置栅格缩放 %.4f 失败：%v", inst.id, scale, err)
		return
	}
	inst.raster = scale
}

func (h *Host) BrowserSetVisible(id string, visible bool) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在：%s", id)
			return
		}
		if inst.chromium == nil || inst.visible == visible {
			return
		}
		if visible {
			_ = inst.chromium.Show()
			inst.chromium.Focus()
			browserRaiseControl(inst)
		} else {
			_ = inst.chromium.Hide()
		}
		inst.visible = visible
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (h *Host) BrowserFocus(id string) error {
	var taskErr error
	jobErr := browserHostRun(func() {
		inst := browserGet(id)
		if inst == nil {
			taskErr = fmt.Errorf("浏览器标签页不存在：%s", id)
			return
		}
		if inst.chromium != nil {
			inst.chromium.Focus()
			_ = inst.chromium.Show()
			browserRaiseControl(inst)
		}
	})
	if jobErr != nil {
		return jobErr
	}
	return taskErr
}

func (h *Host) BrowserClose(id string) error {
	jobErr := browserHostRun(func() {
		inst := browserGetRaw(id) // 失效实例也要能关掉并清出注册表
		if inst == nil {
			return // 已不存在视为成功
		}
		if inst.chromium != nil {
			inst.chromium.ShuttingDown()
			_ = inst.chromium.Hide()
		}
		if inst.ctrl3 != nil {
			// GetICoreWebView2Controller3 是 QI 出来的接口指针，库只导出 AddRef，这里按 IUnknown 约定归还
			inst.ctrl3.Vtbl.Release.Call(uintptr(unsafe.Pointer(inst.ctrl3)))
			inst.ctrl3 = nil
		}
		if inst.controller != nil {
			if err := wvControllerClose(inst.controller); err != nil {
				logf("WARN", "浏览器控制器关闭失败：%v", err)
			}
			inst.controller = nil
			inst.webview = nil
		}
		browserMu.Lock()
		delete(browserInstances, inst.id)
		browserMu.Unlock()
	})
	return jobErr
}
