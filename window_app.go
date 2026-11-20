// window_app.go：窗口注册与跨窗口会话投递的 Wails 绑定（P2 进程内实现，P3 已删除文件注册表）。
//
//   - WindowRegister：调用方窗口把当前工作区写进 windowState；
//   - WindowReuseForSession：按工作区找存活窗口，投递打开会话请求并等待目标窗口回执
//     （超时 2.5s / 目标返回 mismatch 时退化为开新窗口，等价 v2 信箱的 ack 语义）；
//   - WindowReuseResult：目标窗口完成切换后回执 ok / mismatch；
//   - 原 windowreg 文件注册表 / 信箱协议已随 P3 清理删除。

package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// reuseResultBudget 是等待目标窗口回执的总预算（与 v2 信箱投递预算一致）。
const reuseResultBudget = 2500 * time.Millisecond

var (
	reuseSeq     atomic.Uint64
	reuseWaiters sync.Map // reqId -> chan string
)

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

// WindowReuseForSession 找目标工作区的存活窗口，投递「打开会话」请求并等待回执。
// 返回复用的窗口名；空串 = 无可用窗口或目标切换失败（调用方退化为开新窗口）。
func (a *App) WindowReuseForSession(ctx context.Context, workspace, sessionID string) (string, error) {
	from := callerWindowName(ctx)
	target := winReg.findByWorkspace(workspace, from)
	if target == nil {
		return "", nil
	}
	reqID := fmt.Sprintf("reuse-%d-%d", os.Getpid(), reuseSeq.Add(1))
	result := make(chan string, 1)
	reuseWaiters.Store(reqID, result)
	defer reuseWaiters.Delete(reqID)

	deliverOpenSession(target, reqID, workspace, sessionID)
	select {
	case status := <-result:
		if status == "ok" {
			return target.name(), nil
		}
		return "", nil
	case <-time.After(reuseResultBudget):
		return "", nil
	}
}

// WindowReuseResult 目标窗口回执复用结果（status: ok / mismatch）。
func (a *App) WindowReuseResult(reqID, status string) error {
	if reqID == "" {
		return nil
	}
	if v, ok := reuseWaiters.Load(reqID); ok {
		select {
		case v.(chan string) <- status:
		default: // 已超时/已回执：丢弃，避免阻塞
		}
	}
	return nil
}

// WindowActivate 把调用方窗口还原并前置（与「又点了一次桌面图标」同语义）。
func (a *App) WindowActivate(ctx context.Context) error {
	activateWindow(callerWindow(ctx))
	return nil
}
