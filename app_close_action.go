package main

// 关闭行为（设置 → 通用 → 关闭窗口时）：
//   · exit：点 X 走原来的退出流程（未保存 / AI 回合 / 终端 / 后台命令照旧二次确认）。
//   · tray：点 X 只是把窗口藏起来——进程、AI 回合、终端会话、后台命令全都继续跑，
//     想找回窗口就点通知区图标；真想退出走托盘右键「退出」或菜单「退出」。
//
// 多窗口 = 多进程，每个窗口各是一个进程，所以「托盘」必须按「最后一个窗口」算：
//   · 还有别的应用窗口活着 → 点 X 就是关掉这个窗口（含脏文件确认），绝不藏；
//   · 它是最后一个 → 才藏进托盘。
// 否则多窗口下一个 X 藏一个，通知区会堆一串图标，而每个图标只能唤回自己那个窗口。
//
// 身份判定不看 --new-window：窗口模式下双击文件拉起的进程不带它（newwindow.OpenFiles
// 也是裸参数），这个标记只说明「要不要抢单实例锁」。能用的是「是不是应用窗口」
// （排除 AI 浮窗 / 调试控制台）＋「同 exe 还有没有别的窗口」（见 portablewindows_windows.go）。

import (
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"datalens/internal/appconfig"
	"datalens/internal/tray"
)

// isPortableWindowProcess 当前进程是不是「用户眼里的应用窗口」（主窗口 / 文件窗口）。
// AI 浮窗与调试控制台是附属窗口：它们关掉就是关掉，也不让程序因为它们留在后台。
func isPortableWindowProcess() bool {
	return !hasArg("--ai-float") && !hasArg("--debug-console")
}

// isPortableWindowTitle 判断一个窗口标题是否属于「应用窗口」。
// 附属窗口的标题是程序自己写死的（app_core.go 的 WindowSetTitle），据此排除；
// 用途是跨进程枚举时别把 AI 浮窗 / 调试控制台当成「另一个应用窗口」。
func isPortableWindowTitle(title string) bool {
	t := strings.TrimSpace(title)
	if t == "" {
		return false
	}
	if strings.HasPrefix(t, "AI 助手") || strings.HasPrefix(t, "调试控制台") {
		return false
	}
	return true
}

// shouldHideOnClose 是「点 X 时藏进托盘而不是退出」的唯一判定。
//   - 系统关机时必须 false：否则 Windows 等不到进程退出，用户看到的是「关不掉」。
//   - otherWindows > 0 时必须 false：多窗口下关掉的每个窗口都要真的关掉，
//     只有最后一个窗口才谈得上「留在后台」。
func shouldHideOnClose(action string, portable bool, force, quitRequested, shuttingDown bool, otherWindows int) bool {
	if action != appconfig.CloseActionTray {
		return false
	}
	if !portable || force || quitRequested || shuttingDown {
		return false
	}
	return otherWindows == 0
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

// QuitApp 显式退出（菜单「退出」）：与点 X 不同，它不受「最小化到托盘」影响，
// 该走的未保存 / 任务进行中确认照旧走（beforeClose 会拦下来弹框，用户确认后 ForceClose）。
func (a *App) QuitApp() {
	if a.ctx == nil {
		return
	}
	a.quitRequested.Store(true)
	runtime.Quit(a.ctx)
}

// hideToTray 隐藏窗口并把图标挂到通知区。
func (a *App) hideToTray() {
	a.showTray()
	if a.ctx != nil {
		runtime.WindowHide(a.ctx)
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
	a.quitRequested.Store(false)
}

// restoreFromTray 从托盘回到前台（托盘图标同时撤掉：窗口在时别继续占通知区）。
func (a *App) restoreFromTray() {
	if a.ctx == nil {
		return
	}
	a.quitRequested.Store(false)
	if a.tray != nil {
		a.tray.Hide()
	}
	runtime.WindowShow(a.ctx)
}

// quitFromTray 托盘右键「退出」：先把窗口露出来（未保存 / 任务进行中的确认框得看得见），
// 再走正常退出流程——quitRequested 让 beforeClose 不再隐藏。
func (a *App) quitFromTray() {
	if a.ctx == nil {
		return
	}
	a.quitRequested.Store(true)
	if a.tray != nil {
		a.tray.Hide()
	}
	runtime.WindowShow(a.ctx)
	runtime.Quit(a.ctx)
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
	runtime.WindowShow(a.ctx)
}
