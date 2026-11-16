// Package terminal 内置终端会话（Windows 下基于 ConPTY）。
package terminal

// Terminal 终端后端。会话状态在 Windows 实现内维护；事件经 Emit 钩子注入。
type Terminal struct{}

// Emit 前端事件推送（main 在 startup 注入 Wails EventsEmit）。
var Emit func(event string, data any)

func emit(event string, data any) {
	if Emit != nil {
		Emit(event, data)
	}
}
