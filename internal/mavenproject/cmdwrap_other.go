//go:build !windows

package mavenproject

// wrapMavenCmd 非 Windows 直接执行 mvn（PATH 上的 mvn 是可执行 shell 脚本）。
func wrapMavenCmd(mvnPath string, args []string) (string, []string) {
	return mvnPath, args
}
