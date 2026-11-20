// window_app.go：窗口注册与跨窗口会话投递的 Wails 绑定（P2 进程内实现）。
//
// v2（windowreg 文件注册表 + 信箱）在 P2 由进程内窗口注册表取代：
//   - WindowRegister：调用方窗口把当前工作区写进 windowState；
//   - WindowReuseForSession：按工作区找存活窗口，直接把打开会话的事件投给目标窗口；
//   - 信箱 Take/Ack 保留为空实现，兼容前端既有 drain 循环（P3 清理）。
//
// 旧的 internal/windowreg 包暂时保留（P3 删除），本文件不再依赖它。

package main

import (
	"context"
)

// ensureWindowReg 兼容旧调用点（P1 启动路径曾调用）；P2 注册表是进程内的，无需初始化。
func (a *App) ensureWindowReg() {}

// shutdownWindowReg 进程退出时收尾（进程内注册表随进程销毁，无需动作）。
func (a *App) shutdownWindowReg() {}

// WindowRegister 登记调用方窗口当前工作区（关闭工作区传空串，退出可匹配集合）。
// 浮窗/调试控制台不参与工作区复用，静默忽略。
func (a *App) WindowRegister(ctx context.Context, workspace string) error {
	st := stateForCaller(ctx)
	if st == nil || st.startup().Mode != windowModeMain {
		return nil
	}
	st.setWorkspace(workspace)
	return nil
}

// WindowReuseForSession 找目标工作区的存活窗口，直接把「打开会话」事件投给它。
// 返回复用的窗口名；空串 = 没有可用窗口（调用方退化为开新窗口）。
func (a *App) WindowReuseForSession(ctx context.Context, workspace, sessionID string) (string, error) {
	from := callerWindowName(ctx)
	target := winReg.findByWorkspace(workspace, from)
	if target == nil {
		return "", nil
	}
	deliverOpenSession(target, workspace, sessionID)
	return target.name(), nil
}

// WindowInboxTake 兼容旧前端的信箱轮询：进程内投递不再有信箱，恒空。
func (a *App) WindowInboxTake() (string, error) { return "", nil }

// WindowInboxAck 兼容旧前端的信箱回执：空实现。
func (a *App) WindowInboxAck(reqID, status string) error { return nil }

// WindowActivate 把调用方窗口还原并前置（与「又点了一次桌面图标」同语义）。
func (a *App) WindowActivate(ctx context.Context) error {
	activateWindow(callerWindow(ctx))
	return nil
}
