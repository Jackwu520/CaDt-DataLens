package main

// global_hotkey.go：全局热键（v3 GlobalShortcutManager，Windows 走 RegisterHotKey）。
// v2 没有全局热键 API，这是迁移后才有的能力。Run 之前注册的项由 v3 排队，
// 消息循环起来后生效；组合键被其他程序占用时 Register 报错，只记日志不重试。
// 退出时 v3 的 cleanup 会 UnregisterAll，无需手动摘除。

// registerGlobalHotkeys 注册全局热键。固定键位、无设置开关：组合键冲突时
// 由 Register 报错兜底（用户改用托盘/任务栏入口）。
func (a *App) registerGlobalHotkeys() {
	if wailsApp == nil || wailsApp.GlobalShortcut == nil {
		return
	}
	hotkeys := []struct {
		accel string
		desc  string
		fn    func()
	}{
		{"Ctrl+Alt+A", "AI 浮窗", func() { a.ensureFloatWindow() }},
		{"Ctrl+Alt+T", "主窗口终端面板", a.focusPrimaryTerminal},
		{"Ctrl+Alt+D", "调试控制台", func() { a.ensureDebugWindow() }},
	}
	for _, hk := range hotkeys {
		if err := wailsApp.GlobalShortcut.Register(hk.accel, hk.fn); err != nil {
			writeAppLog("warn", "全局热键注册失败 %s（%s）：%v", hk.accel, hk.desc, err)
			continue
		}
		writeAppLog("info", "全局热键：%s → %s", hk.accel, hk.desc)
	}
}

// focusPrimaryTerminal 把主窗口带到前台并打开终端面板；没有主窗口（浮窗/终端独立
// 窗口单独运行）时退化为开一个主窗口——热键语义是「给我一个能干活的终端」。
func (a *App) focusPrimaryTerminal() {
	st := winReg.primary()
	if st == nil {
		a.openMainWindow(windowSpec{})
		return
	}
	activateWindow(st.window())
	emitWindowEventTo(st.window(), "app-open-terminal", nil)
}
