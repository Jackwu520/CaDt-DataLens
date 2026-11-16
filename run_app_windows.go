//go:build windows

package main

// run_app_windows.go：运行代码引擎（internal/run）的 Windows 宿主接线——
// 解释器探测复用终端面板的 findGitBash / findPwsh。

import "datalens/internal/run"

func init() {
	run.FindGitBash = findGitBash
	run.FindPwsh = findPwsh
}
