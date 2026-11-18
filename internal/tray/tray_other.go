//go:build !windows

package tray

// 非 Windows 平台没有通知区域这回事：全部是空桩，Supported() 返回 false，
// 宿主据此把「最小化到托盘」这条路关掉（设置页仍会显示，选了也不生效）。

// Tray 是托盘图标的空桩。
type Tray struct{}

// New 返回一个无效的托盘对象。
func New(opts Options) *Tray {
	_ = opts
	return &Tray{}
}

// Supported 报告当前平台是否能真的挂托盘图标。
func Supported() bool { return false }

// Show 空实现。
func (t *Tray) Show() {}

// Hide 空实现。
func (t *Tray) Hide() {}

// Close 空实现。
func (t *Tray) Close() {}
