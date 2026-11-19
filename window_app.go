// window_app.go：窗口注册表与跨窗口会话投递的 Wails 薄包装。
//
// 引擎在 internal/windowreg；这里只做挂名绑定、生命周期接线（启动 Sweep/Register/
// heartbeat/信箱监听，退出 Close）与复用成功后的窗口前置。
// 方案见 docs/unfinished-plans/multi-window-session-reuse.md。

package main

import (
	"encoding/json"
	"path/filepath"
	"sync"
	"time"

	"datalens/internal/appdata"
	"datalens/internal/watch"
	"datalens/internal/windowreg"
)

const (
	windowRegHeartbeatInterval = 30 * time.Second  // meta.json 活性心跳
	windowReuseDeliverBudget   = 2500 * time.Millisecond // 跨候选共享的总等待预算
)

var windowRegInitMu sync.Mutex

// windowRegRoot 注册表根：<应用数据>/windows。
func windowRegRoot() string {
	return filepath.Join(appdata.Root(), "windows")
}

// ensureWindowReg 建立本窗口的注册条目：Sweep 残留 → 取租约写 meta → 心跳 → 信箱监听。
// 浮窗 / 调试控制台窗口与 convert 模式不注册（不参与跨窗口匹配）。
// startup 与前端 WindowRegister 双入口共用。Register 失败不锁死——前端每次工作区
// 变化都会再调本函数，天然带重试（不能用 sync.Once：可失败的初始化一旦失败就被
// Once 永久固化，本窗口从此既不可复用别人、也不可被复用）。
func (a *App) ensureWindowReg() {
	windowRegInitMu.Lock()
	defer windowRegInitMu.Unlock()
	if a.windowReg != nil || a.IsAIFloatWindow() || a.IsDebugConsoleWindow() {
		return
	}
	root := windowRegRoot()
	if _, err := windowreg.Sweep(root); err != nil {
		writeAppLog("warn", "窗口注册表残留清理失败：%v", err)
	}
	reg, err := windowreg.Register(root, windowreg.Entry{})
	if err != nil {
		writeAppLog("warn", "窗口注册表注册失败：%v", err)
		return
	}
	a.windowReg = reg
	reg.StartHeartbeat(windowRegHeartbeatInterval)
	if watch.Supported() {
		// 非 Windows 平台 watchDirectory 不可用，信箱收不到事件——
		// 不登记监听（投递侧同样降级，见 WindowReuseForSession）。
		if err := watch.Resources.Watch(windowreg.InboxWatchKind, reg.WindowID(), reg.InboxDir()); err != nil {
			writeAppLog("warn", "窗口信箱监听登记失败：%v", err)
		}
	}
}

// shutdownWindowReg 进程退出时释放租约并清注册痕迹；失败由下次启动的 Sweep 兜底。
func (a *App) shutdownWindowReg() {
	if a.windowReg != nil {
		a.windowReg.Close()
		a.windowReg = nil
	}
}

// WindowRegister 登记本窗口当前工作区（归一化后进 meta）。关闭工作区时传空串，
// 让本窗口退出可匹配集合。startup 后前端每次工作区变化都调用。
func (a *App) WindowRegister(workspace string) error {
	a.ensureWindowReg()
	if a.windowReg == nil {
		return nil // 浮窗 / 调试控制台：不参与，静默忽略
	}
	return a.windowReg.Update(workspace)
}

// WindowReuseForSession 找目标工作区的存活窗口并投递打开会话的请求。
// 返回复用的 windowId；空串 = 没有可用窗口（调用方退化为开新窗口）。
func (a *App) WindowReuseForSession(workspace, sessionID string) (string, error) {
	if !watch.Supported() {
		// 信箱收不到事件的平台上复用不可靠，直接退化为开新窗口。
		return "", nil
	}
	a.ensureWindowReg()
	from := ""
	if a.windowReg != nil {
		from = a.windowReg.WindowID()
	}
	return windowreg.Deliver(windowRegRoot(), workspace, sessionID, from, windowReuseDeliverBudget)
}

// WindowInboxTake 取一条待处理信箱请求（JSON）；无请求返回空串。
func (a *App) WindowInboxTake() (string, error) {
	if a.windowReg == nil {
		return "", nil
	}
	req, err := a.windowReg.Take()
	if err != nil || req == nil {
		return "", err
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// WindowInboxAck 对取走的请求写回执（status: ok / mismatch / expired）。
func (a *App) WindowInboxAck(reqID, status string) error {
	if a.windowReg == nil {
		return nil
	}
	return a.windowReg.Ack(reqID, status)
}

// WindowActivate 复用成功后目标窗口自调：还原并前置到前台。
// 走 secondInstanceShow（与「又点了一次桌面图标」同语义：清托盘态 + quitRequested + WindowShow）；
// 不能用 WindowUnminimise——它走 WM_SYSCOMMAND/SC_RESTORE 会把最大化的窗口还原成
// 普通窗口（既有结论见 app_core.go:210），复用命中即触发一次可见回归。
func (a *App) WindowActivate() error {
	if a.ctx == nil {
		return nil
	}
	a.secondInstanceShow()
	return nil
}
