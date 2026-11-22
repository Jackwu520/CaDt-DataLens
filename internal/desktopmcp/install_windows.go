//go:build windows

package desktopmcp

// install_windows.go：桌面控制安装的平台执行体。
// 用户打开开关就是明确授权跑安装命令（2026-11-22 用户裁决：连 uv / Python 依赖一起装）：
//   ① uv / uvx 都不在 PATH 与 ~\.local\bin 时，跑官方安装脚本（astral.sh，装到用户目录免管理员）；
//   ② uvx --from <内置 wheel> 预热 windows-mcp（首次下载 Python 3.14 解释器与 21 个依赖）。
// 两步都流式读输出：进度与上游日志逐行上报，前端据此画进度条（不吞日志、不静默等待）。

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"datalens/internal/executil"
)

// uvInstallCommand 与上游文档一致：装到用户目录（免管理员），装完当次即可用。
const uvInstallCommand = `irm https://astral.sh/uv/install.ps1 | iex`

// emitThrottle 同一阶段内的事件最小间隔：uv 的 \r 进度会刷出成百上千行，
// 逐行 EventsEmit 会把 WebView2 IPC 打满。
const emitThrottle = 150 * time.Millisecond

// uvxPath 先查 PATH，再看官方安装器的用户目录落点（装完当次即可用，不必重开应用）。
func uvxPath() string {
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

func installPlatform(ctx context.Context, wheelPath string, emit func(Progress)) ([]string, error) {
	steps := make([]string, 0, 2)

	uvx := uvxPath()
	if uvx == "" {
		emit(Progress{Stage: StageUV, Detail: "正在安装 uv（官方脚本，装到用户目录）", Percent: 12})
		cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", uvInstallCommand)
		executil.HideCommandWindow(cmd)
		last := time.Now()
		err := runStreaming(cmd, func(line string) {
			if time.Since(last) < emitThrottle {
				return
			}
			last = time.Now()
			emit(Progress{Stage: StageUV, Detail: "安装 uv", Percent: 20, Line: line})
		})
		if err != nil {
			return steps, fmt.Errorf("uv 安装失败：%v", err)
		}
		steps = append(steps, "安装 uv / uvx")
		if uvx = uvxPath(); uvx == "" {
			return steps, fmt.Errorf("uv 安装完成但找不到 uvx，请重启应用后重试")
		}
	} else {
		steps = append(steps, "uv 已就绪")
		emit(Progress{Stage: StageUV, Detail: "uv 已就绪", Percent: 30})
	}

	emit(Progress{Stage: StageWarm, Detail: "下载 Python 3.14 与依赖（首次约 100–190 MB）", Percent: 35})
	// --help 只加载入口与依赖解析，不真的起 server：等于把依赖装进 uv 缓存。
	cmd := exec.CommandContext(ctx, uvx, "--from", wheelPath, "windows-mcp", "--help")
	executil.HideCommandWindow(cmd)
	percent := 35
	last := time.Now()
	err := runStreaming(cmd, func(line string) {
		if percent < 95 {
			percent++
		}
		if time.Since(last) < emitThrottle && percent < 95 {
			return
		}
		last = time.Now()
		emit(Progress{Stage: StageWarm, Detail: "下载 Python 与依赖", Percent: percent, Line: line})
	})
	steps = append(steps, "预热 windows-mcp 依赖")
	if ctx.Err() == context.DeadlineExceeded {
		return steps, fmt.Errorf("预热超时（首次下载依赖约需数分钟），稍后首次控制时会自动继续")
	}
	if err != nil {
		return steps, fmt.Errorf("预热失败：%v", err)
	}
	return steps, nil
}
