//go:build !windows

// installercli：非 Windows 平台没有安装包集成，忽略这些参数。
package installercli

// Run 非 Windows 平台直接返回 false（未处理）。
func Run(args []string) bool {
	return false
}
