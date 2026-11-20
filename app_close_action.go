package main

// 关闭行为（设置 → 通用 → 关闭窗口时）：
//   · exit：点 X 走原来的退出流程（未保存 / AI 回合 / 终端 / 后台命令照旧二次确认）。
//   · tray：点 X 只是把窗口藏起来——进程、AI 回合、终端会话、后台命令全都继续跑，
//     想找回窗口就点通知区图标；真想退出走托盘右键「退出」或菜单「退出」。
//
// P2 起多窗口在同一进程内，「托盘」按「还有没有别的主窗口」算：
//   · 还有别的主窗口活着 → 点 X 就是关掉这个窗口（含脏文件确认），绝不藏；
//   · 它是最后一个主窗口 → 才藏进托盘。
// 否则多窗口下一个 X 藏一个，通知区会堆一串图标，而每个图标只能唤回一个窗口。
// 附属窗口（AI 浮窗 / 调试控制台）只按其窗口类型判定，从不藏进托盘。

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/appconfig"
	"datalens/internal/cmdbridge"
	"datalens/internal/tray"
)

// shouldHideOnClose 是「点 X 时藏进托盘而不是退出」的唯一判定。
//   - 系统关机时必须 false：否则 Windows 等不到进程退出，用户看到的是「关不掉」。
//   - 托盘模式下主窗口一律藏：多主窗共用同一个托盘图标（单例），恢复时全部找回。
//     旧口径「只有最后一个主窗口才藏」在多窗口下会出现「点 X 弹确认框」的反直觉
//     行为（2026-11-21 用户实测裁定废弃）；附属窗口（浮窗/调试台/终端窗）从不藏，
//     由调用方的 isMain 判定承担。
func shouldHideOnClose(action string, portable bool, force, quitRequested, shuttingDown bool) bool {
	if action != appconfig.CloseActionTray {
		return false
	}
	if !portable || force || quitRequested || shuttingDown {
		return false
	}
	return true
}

// GetCloseAction 返回当前关闭行为（exit / tray），设置页用它回显。
func (a *App) GetCloseAction() string {
	if a.closeAction == "" {
		return appconfig.CloseActionExit
	}
	return a.closeAction
}

// SetCloseAction 设置关闭行为并落盘（config.json），下次启动沿用。
func (a *App) SetCloseAction(action string) error {
	normalized := appconfig.NormalizeCloseAction(action)
	if err := appconfig.SaveCloseAction(normalized); err != nil {
		return err
	}
	a.closeAction = normalized
	// 改回「直接退出」时若托盘图标还挂着（理论上窗口可见时不会），顺手撤掉
	if normalized != appconfig.CloseActionTray && a.tray != nil {
		a.tray.Hide()
	}
	return nil
}

// QuitApp 显式退出（菜单「退出」/ 托盘右键「退出」）。与点 X 不同，它不受
// 「最小化到托盘」影响，但未保存 / 任务进行中的确认照旧要走。
//
// v3 的 Application.Quit 不经过 WindowClosing（v2 的 runtime.Quit 会先调
// OnBeforeClose），所以不能直接把窗口关掉再 quitApp：没风险时直接关闭全部窗口；
// 有风险时把汇总结果发给一个窗口，前端复用关窗确认框，确认后调 ForceQuitAll。
func (a *App) QuitApp() {
	if a.ctx == nil {
		return
	}
	reasons := a.appQuitReasonSnapshot()
	if reasons.empty() {
		a.ForceQuitAll()
		return
	}
	st := winReg.primary()
	if st == nil {
		for _, cand := range winReg.list() {
			st = cand
			break
		}
	}
	if st == nil {
		a.ForceQuitAll()
		return
	}
	emitWindowEventTo(st.window(), "app-quit-request", reasons)
	activateWindow(st.window())
}

// ForceQuitAll 前端确认退出后调用：关闭全部窗口。应用级服务在这里先收口一次
// （幂等），不依赖最后一个窗口的钩子跑在前面。
func (a *App) ForceQuitAll() {
	a.quitRequested.Store(true)
	states := winReg.list()
	if len(states) == 0 {
		quitApp()
		return
	}
	a.teardownAppServices()
	for _, st := range states {
		st.markForceClose()
		st.SetDirty(false)
		st.SetAIRunning(false)
		closeWindow(st.window())
	}
}

// appQuitReasons 是显式退出前汇总的「有风险」状态（跨全部窗口 + 进程级任务）。
type appQuitReasons struct {
	Dirty     bool `json:"dirty"`
	AIRunning bool `json:"aiRunning"`
	Terms     int  `json:"terms"`
	BgJobs    int  `json:"bgJobs"`
}

func (r appQuitReasons) empty() bool {
	return !r.Dirty && !r.AIRunning && r.Terms == 0 && r.BgJobs == 0
}

func (a *App) appQuitReasonSnapshot() appQuitReasons {
	var r appQuitReasons
	for _, st := range winReg.list() {
		if st.IsDirty() {
			r.Dirty = true
		}
		if st.IsAIRunning() {
			r.AIRunning = true
		}
	}
	r.Terms = a.Terminal.RunningSessionCount()
	r.BgJobs = cmdbridge.RunningAIJobCount()
	return r
}

// teardownAppServices 应用级服务收口（托盘 / MCP / 插件服务 / 工作区监听）。
// 只在应用退出时调用一次；普通关掉一个窗口不能走这里。
func (a *App) teardownAppServices() {
	if !a.teardownDone.CompareAndSwap(false, true) {
		return
	}
	a.stopTray()
	a.mcpCloseAll()         // MCP 子进程全量关闭（总预算 8s，超时靠 taskkill 兜底）
	a.AppServices.StopAll() // 插件后台服务全量停止（取消即杀整棵进程树）
	a.Watcher.UnwatchAll()  // 全部工作区监听槽（按窗口键控，退出时统一收口）
}

// hideToTray 隐藏指定窗口并把图标挂到通知区。
func (a *App) hideToTray(w *application.WebviewWindow) {
	a.showTray()
	if w != nil {
		w.Hide()
	}
	if !a.trayHintShown {
		a.trayHintShown = true
		// 第一次隐藏给条系统通知：窗口和任务栏按钮一起消失，不说一声用户会以为程序已经退出。
		go func() {
			if a.Notifier == nil {
				return
			}
			_ = a.NotifySystemToast("已最小化到托盘",
				"程序仍在后台运行，AI 任务不受影响；点击通知区图标可重新打开，右键图标可以退出。", "", true)
		}()
	}
}

// showTray 懒创建托盘对象并挂图标。
func (a *App) showTray() {
	if a.tray == nil {
		a.tray = tray.New(tray.Options{
			IconID:  appTrayIconID(),
			Tooltip: "CaDt-DataLens",
			OnShow:  func() { a.restoreFromTray() },
			OnQuit:  func() { a.quitFromTray() },
		})
	}
	a.tray.Show()
}

// stopTray 撤图标并结束托盘线程（真正退出时调用）。
func (a *App) stopTray() {
	if a.tray == nil {
		return
	}
	a.tray.Close()
	a.tray = nil
	// 注意：这里不能清 quitRequested——ForceQuitAll 先置位再走 teardown→stopTray，
	// 清掉会让退出流程里的窗口钩子丢失退出标记（2026-11-21 审查 P1-2）。
	// 重置只属于 restoreFromTray / secondInstanceShow（窗口回到前台语义）。
}

// restoreFromTray 从托盘回到前台（托盘图标同时撤掉：窗口在时别继续占通知区）。
// 托盘模式下可能藏了多个主窗口：全部找回（Show 对已可见窗口是幂等 no-op）。
func (a *App) restoreFromTray() {
	if a.ctx == nil {
		return
	}
	a.quitRequested.Store(false)
	if a.tray != nil {
		a.tray.Hide()
	}
	for _, st := range winReg.list() {
		if st.startup().Mode != windowModeMain {
			continue
		}
		if w := st.window(); w != nil {
			w.Show()
			if w.IsMinimised() {
				w.UnMinimise()
			}
		}
	}
}

// quitFromTray 托盘右键「退出」：先把窗口露出来（未保存 / 任务进行中的确认框得看得见），
// 再走与菜单「退出」同一条退出请求流程（v3 不能直接 Application.Quit，会绕过关窗确认）。
func (a *App) quitFromTray() {
	if a.ctx == nil {
		return
	}
	if a.tray != nil {
		a.tray.Hide()
	}
	showMainWindow()
	a.QuitApp()
}

// clearTrayState 第二实例/恢复路径的托盘态清理（v2 secondInstanceShow 每个分支都做）：
// 复位退出标记并撤掉通知区图标——窗口已经被拉出来了，图标残留会让人误以为还在托盘。
func (a *App) clearTrayState() {
	a.quitRequested.Store(false)
	if a.tray != nil {
		a.tray.Hide()
	}
}

// secondInstanceShow 是「又点了一次桌面图标 / 系统通知被点击」时把窗口找回来的路径：
// 顺手把托盘态清掉，否则图标会留在通知区而窗口已经在前台。
func (a *App) secondInstanceShow() {
	if a.ctx == nil {
		return
	}
	a.quitRequested.Store(false)
	if a.tray != nil {
		a.tray.Hide()
	}
	showMainWindow()
}
