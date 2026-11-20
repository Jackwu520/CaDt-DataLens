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

// TermReadResult 是 TermRead 的返回：最近输出 + 会话状态（AI 靠它判断命令是否跑完）。
// 类型放共享文件：绑定方法在 Windows 实现，非 Windows 平台由桩保持契约完整。
type TermReadResult struct {
	ID        string `json:"id"`
	Shell     string `json:"shell"`
	Cwd       string `json:"cwd"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Exited    bool   `json:"exited"`
	ExitCode  int32  `json:"exitCode"`
	Bytes     int64  `json:"bytes"`
}

// TermInfo 是 TermList 的条目（含已退出的会话）。
type TermInfo struct {
	ID       string `json:"id"`
	Shell    string `json:"shell"`
	Cwd      string `json:"cwd"`
	Exited   bool   `json:"exited"`
	ExitCode int32  `json:"exitCode"`
	Bytes    int64  `json:"bytes"`
	Last     string `json:"last"`
}
