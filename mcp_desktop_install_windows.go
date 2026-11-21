//go:build windows

package main

// mcp_desktop_install_windows.go：桌面控制「安装…」的后端执行体。
// 用户点了安装按钮就是明确授权跑安装命令（2026-11-22 用户裁决：连 uv / Python 依赖一起装）：
//   ① uv / uvx 都不在 PATH 与 ~\.local\bin 时，跑官方安装脚本（astral.sh，装到用户目录免管理员）；
//   ② 用 uvx 预热 windows-mcp@0.8.9（首次下载 Python 3.14 解释器与依赖，约 100 MB）。
// 输出隐藏窗口、总预算 15 分钟；步骤与错误原样回给前端显示，失败不吞。

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"datalens/internal/executil"
)

const desktopMcpUvInstallCommand = `irm https://astral.sh/uv/install.ps1 | iex`

// uvxPathForInstall：先查 PATH，再看官方安装器的用户目录落点（装完当次即可用，不必重开应用）。
func uvxPathForInstall() string {
	if path, err := exec.LookPath("uvx"); err == nil {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	for _, name := range []string{"uvx.exe", "uvx"} {
		candidate := filepath.Join(home, ".local", "bin", name)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func runDesktopMcpBootstrap(ctx context.Context) ([]string, error) {
	steps := make([]string, 0, 2)
	uvx := uvxPathForInstall()
	if uvx == "" {
		cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", desktopMcpUvInstallCommand)
		executil.HideCommandWindow(cmd)
		out, err := cmd.CombinedOutput()
		steps = append(steps, "安装 uv / uvx")
		if err != nil {
			return steps, fmt.Errorf("uv 安装失败：%s（%v）", tailText(string(out), 600), err)
		}
		if uvx = uvxPathForInstall(); uvx == "" {
			return steps, fmt.Errorf("uv 安装完成但找不到 uvx，请重启应用后重试")
		}
	} else {
		steps = append(steps, "uv 已就绪")
	}
	// 预热：uvx 会把 windows-mcp 与它需要的 Python 解释器 / 依赖装进缓存，之后再启动只需几秒
	warm := exec.CommandContext(ctx, uvx, "windows-mcp@0.8.9", "--help")
	executil.HideCommandWindow(warm)
	out, err := warm.CombinedOutput()
	steps = append(steps, "预热 windows-mcp 依赖")
	if ctx.Err() == context.DeadlineExceeded {
		return steps, fmt.Errorf("预热超时（首次下载依赖约需数分钟），稍后首次控制时会自动继续")
	}
	if err != nil {
		return steps, fmt.Errorf("预热失败：%s（%v）", tailText(string(out), 600), err)
	}
	return steps, nil
}

// tailText：错误输出只留尾部（下载日志很长，前端只需要最后一句话）。
func tailText(text string, max int) string {
	trimmed := strings.TrimSpace(text)
	runes := []rune(trimmed)
	if len(runes) <= max {
		return trimmed
	}
	return "…" + string(runes[len(runes)-max:])
}
