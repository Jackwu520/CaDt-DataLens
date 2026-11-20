//go:build !windows

package terminal

// RunningSessionCount 非 Windows 平台没有 ConPTY 会话表，恒为 0（关窗二次确认用）。
func (t *Terminal) RunningSessionCount() int { return 0 }

// TermList 非 Windows 平台没有会话表，恒为空（终端独立窗口的交还判定用）。
func (t *Terminal) TermList() []TermInfo { return nil }
