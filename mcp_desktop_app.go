package main

// mcp_desktop_app.go：桌面 MCP（windows-mcp）产品化外壳的 P4 doctor——uv 探测只读绑定。
// 方案 docs/finished-plans/desktop-mcp.md §5.5 / §13.5（P2 降级：安装命令复制与配置行
// 写入都在前端经既有 MCPGetConfig / MCPWriteConfig / MCPProbeServer 完成，不新增写绑定）。
// 只诊断不修复：修复动作仍走设置页的显式按钮。UIA 窗口数 / 显示器缩放属上游行为，
// 首版不探测（server 未连接时无从查起），如实只报 uv 解析结果。

import (
	"os"
	"os/exec"
	"path/filepath"
)

// MCPDesktopDoctorResult 桌面 doctor 的探测结果（前端拼进诊断面板）。
type MCPDesktopDoctorResult struct {
	UVFound     bool     `json:"uvFound"`     // uv 在 PATH 上（uvx 可直接用）
	UVPath      string   `json:"uvPath"`      // PATH 命中的 uv 可执行文件路径
	UVHomeFound bool     `json:"uvHomeFound"` // uv 在 %USERPROFILE%\.local\bin（官方安装器默认位，可能不在 PATH）
	UVHome      string   `json:"uvHome"`      // 该候选路径（无论是否存在，供前端给安装提示）
	Hints       []string `json:"hints,omitempty"`
}

// resolveUvCandidates 纯函数：PATH 之外的 uv 探测位置——官方安装脚本默认装到
// 用户主目录 .local\bin（windows-mcp 方案 §5.3 的探测口径）。home 为空返回 nil。
// Windows 上安装的是 uv.exe 而 os.Stat 不做 PATHEXT 解析——候选必须显式带扩展名，
// 同时保留无扩展名形态覆盖非 Windows（2026-11-21 审查 P1-2：缺 .exe 曾让该候选恒落空）。
func resolveUvCandidates(home string) []string {
	if home == "" {
		return nil
	}
	bin := filepath.Join(home, ".local", "bin")
	return []string{
		filepath.Join(bin, "uv.exe"),
		filepath.Join(bin, "uv"),
	}
}

// MCPDesktopDoctor 桌面控制卡片的「检测依赖」按钮：解析 uv 的位置。纯读、无子进程
// （LookPath 只查目录，不执行）、无副作用；首次安装说明由前端按结果拼。
func (a *App) MCPDesktopDoctor() MCPDesktopDoctorResult {
	result := MCPDesktopDoctorResult{}
	if path, err := exec.LookPath("uv"); err == nil {
		result.UVFound = true
		result.UVPath = path
	}
	home, err := os.UserHomeDir()
	for _, candidate := range resolveUvCandidates(home) {
		result.UVHome = candidate
		if _, statErr := os.Stat(candidate); statErr == nil {
			result.UVHomeFound = true
		}
	}
	if err != nil {
		result.Hints = append(result.Hints, "无法定位用户主目录："+err.Error())
	}
	if !result.UVFound && !result.UVHomeFound {
		result.Hints = append(result.Hints,
			"未找到 uv：桌面 server 依赖它启动 windows-mcp（首次运行会下载 Python 3.14 解释器与依赖，约 100 MB）。",
			"安装命令：powershell -ExecutionPolicy Bypass -Command \"irm https://astral.sh/uv/install.ps1 | iex\"（装到用户目录，免管理员；装完重开应用生效）。")
	} else if !result.UVFound && result.UVHomeFound {
		result.Hints = append(result.Hints,
			"uv 在用户目录但不在 PATH："+result.UVHome+"。MCP server 配置里把 command 改成该路径也可用。")
	}
	return result
}
