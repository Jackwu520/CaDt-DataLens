// window_app.go：窗口注册与跨窗口会话投递的 Wails 绑定（P2 进程内实现，P3 已删除文件注册表）。
//
//   - WindowRegister：调用方窗口把当前工作区写进 windowState；
//   - WindowReuseForSession：按工作区找存活窗口，直接把打开会话的事件投给目标窗口；
//   - 原 windowreg 文件注册表 / 信箱协议已随 P3 清理删除。

package main

import "context"

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

// WindowActivate 把调用方窗口还原并前置（与「又点了一次桌面图标」同语义）。
func (a *App) WindowActivate(ctx context.Context) error {
	activateWindow(callerWindow(ctx))
	return nil
}
