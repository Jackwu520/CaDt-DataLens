package main

// ai_float.go：AI 浮窗的窗口归属与打开动作。
// P2 起浮窗是同一进程里的独立窗口（不再是独立进程），窗口名固定 float。

import (
	"context"
	"strings"

	"datalens/internal/launchargs"
)

// IsAIFloatWindow 当前调用窗口是不是 AI 悬浮窗；无窗口上下文时看首个窗口形态。
func (a *App) IsAIFloatWindow(ctx context.Context) bool {
	st := stateForCaller(ctx)
	return st != nil && st.startup().Mode == windowModeFloat
}

// OpenAIFloatWindow 打开（或聚焦）AI 浮窗；root 非空时把该工作区作为打开目标。
func (a *App) OpenAIFloatWindow(root string) error {
	root = strings.TrimSpace(root)
	var targets []launchargs.OpenTarget
	if root != "" {
		targets = []launchargs.OpenTarget{{Path: root}}
	}
	a.ensureFloatWindow(targets...)
	return nil
}

// OpenSettingsInMainWindow 请求主窗口打开设置页（悬浮窗使用）。
// 无主窗口（浮窗单独运行）时回退发到浮窗自身——设置对话框在浮窗形态可见
// （与 v2 的单实例转发等价，审查 P2-1）；前端 flash 文案由调用窗口自己出。
func (a *App) OpenSettingsInMainWindow(pane string) error {
	if strings.TrimSpace(pane) == "" {
		pane = "models"
	}
	st := winReg.primary()
	if st == nil {
		st = winReg.get("float")
	}
	if st == nil {
		return nil
	}
	emitWindowEventTo(st.window(), "app-open-settings", pane)
	activateWindow(st.window())
	return nil
}
