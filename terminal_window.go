package main

// 终端独立窗口的绑定壳：弹出、窗口形态判定与启动上下文。
// ConPTY 会话留在进程内（internal/terminal），弹窗只是换一个窗口渲染；
// 事件归属在窗口装载时经 RegisterEventOwner 切到新窗口，关窗时经
// term-popout-closed 交还原窗口（见 window_factory.go）。

import (
	"context"
	"fmt"
	"strings"
)

// PopOutTerminal 把终端会话弹出为独立窗口。调用方窗口记为来源（Origin）：
// 弹出窗口关闭时会话交还给它。已退出的会话没有弹出价值，直接报错。
func (a *App) PopOutTerminal(ctx context.Context, termID string) error {
	termID = strings.TrimSpace(termID)
	if termID == "" {
		return fmt.Errorf("缺少终端 id")
	}
	for _, info := range a.TermList() {
		if info.ID == termID {
			if info.Exited {
				return fmt.Errorf("终端已退出")
			}
			a.ensureTerminalWindow(termID, callerWindowName(ctx))
			return nil
		}
	}
	return fmt.Errorf("终端会话不存在：%s", termID)
}

// IsTerminalWindow 当前调用窗口是否是终端独立窗口。
func (a *App) IsTerminalWindow(ctx context.Context) bool {
	st := stateForCaller(ctx)
	return st != nil && st.startup().Mode == windowModeTerminal
}

// GetStartupTermID 终端独立窗口的启动会话 id；其他窗口返回空串。
func (a *App) GetStartupTermID(ctx context.Context) string {
	st := stateForCaller(ctx)
	if st == nil || st.startup().Mode != windowModeTerminal {
		return ""
	}
	return st.startup().TermID
}
