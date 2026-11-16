//go:build !windows

package notify

// AppWindowActive 在非 Windows 平台无窗口判定，恒为前台。
func (nt *Notifier) AppWindowActive() bool { return true }

// Prepare 在非 Windows 平台无操作。
func Prepare() {}

// NotifyAttention 在非 Windows 平台无操作。
func (nt *Notifier) NotifyAttention(beep bool) {}

// NotifySystemToast 在非 Windows 平台无操作。
func (nt *Notifier) NotifySystemToast(title string, body string, payload string, silent bool) error {
	return nil
}
