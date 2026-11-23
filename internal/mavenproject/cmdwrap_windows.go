//go:build windows

package mavenproject

import (
	"os"
	"strings"
)

// wrapMavenCmd 把 mvn 调用包进 cmd.exe：Windows 上 mvn 是 mvn.cmd，批处理不能裸 exec，
// 与前端运行配方（RECIPES 的 shell:'cmd' + /c 范式）同一套约定。
func wrapMavenCmd(mvnPath string, args []string) (string, []string) {
	comspec := strings.TrimSpace(os.Getenv("COMSPEC"))
	if comspec == "" {
		comspec = "cmd.exe"
	}
	return comspec, append([]string{"/c", mvnPath}, args...)
}
