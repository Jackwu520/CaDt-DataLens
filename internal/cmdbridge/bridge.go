// Package cmdbridge 进程桥：为插件命令、git 浅集成与 AI 终端工具提供受控的命令执行。
// 信任模型与插件一致：页面 JS（含插件）可以启动本机进程，只安装可信来源的插件。
package cmdbridge

// Bridge 进程桥。事件经 Emit 钩子注入，进程注册与取消走 internal/procctl。
type Bridge struct{}

// Emit 前端事件推送（main 在 startup 注入 Wails EventsEmit）。
var Emit func(event string, data any)

func emit(event string, data any) {
	if Emit != nil {
		Emit(event, data)
	}
}
