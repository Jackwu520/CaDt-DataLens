//go:build !windows

package main

// mcp_desktop_install_other.go：桌面控制一键安装的非 Windows 桩。
// 真实实现见 mcp_desktop_install_windows.go（powershell 官方 uv 安装脚本 + uvx 预热）。
// 非 Windows 上桌面控制本就不可用（windows-mcp 只驱动 Win32 UI），这里如实报错而不是静默成功。

import (
	"context"
	"errors"
)

func runDesktopMcpBootstrap(ctx context.Context) ([]string, error) {
	return nil, errors.New("桌面控制只支持 Windows")
}
