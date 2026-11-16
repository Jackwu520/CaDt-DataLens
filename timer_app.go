package main

// timer_app.go：AI 计时器的 Wails 绑定——注册表在 internal/aitimer，
// 这里负责惰性初始化与事件广播（到点 / 自动停止 / 手动停止）。

import (
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"datalens/internal/aitimer"
)

// aiTimersIf 惰性初始化注册表（NewApp 零值构造，字段按需创建）。
func (a *App) aiTimersIf() *aitimer.Registry {
	a.aiTimersMu.Lock()
	defer a.aiTimersMu.Unlock()
	if a.aiTimers == nil {
		a.aiTimers = aitimer.NewRegistry(
			func(info aitimer.Info) {
				if a.ctx != nil {
					runtime.EventsEmit(a.ctx, "ai-timer-fired", info)
				}
			},
			func(info aitimer.Info) {
				if a.ctx != nil {
					runtime.EventsEmit(a.ctx, "ai-timer-stopped", info) // Auto=true：正计时到点自动停止
				}
			},
		)
	}
	return a.aiTimers
}

// StartTimer 启动计时器（前端 AI 工具 start_timer 调用）。
func (a *App) StartTimer(mode string, seconds int, label string) (aitimer.StartResult, error) {
	return a.aiTimersIf().Start(mode, seconds, label)
}

// StopTimer 停止计时器（前端 AI 工具 stop_timer 调用），并广播停止事件让各窗口清掉胶囊。
func (a *App) StopTimer(id string) (aitimer.StopResult, error) {
	result, err := a.aiTimersIf().Stop(id)
	if err != nil {
		return result, err
	}
	if result.Found && a.ctx != nil {
		runtime.EventsEmit(a.ctx, "ai-timer-stopped", result.Stopped)
	}
	return result, nil
}

// ListTimers 当前运行中的计时器（面板重开/窗口重载时恢复胶囊）。
func (a *App) ListTimers() ([]aitimer.Info, error) {
	return a.aiTimersIf().List(), nil
}

// MarkTimer 给运行中的计时器打时刻标记（可选备注）：攒到停止 / 到点时随事件投递给绑定会话。
func (a *App) MarkTimer(id string, note string) (aitimer.Info, error) {
	return a.aiTimersIf().Mark(id, note)
}
