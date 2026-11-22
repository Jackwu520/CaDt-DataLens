// desktopmcp：桌面控制（windows-mcp）的内嵌分发层——wheel 随 exe 携带，运行时按需释放。
//
// 体积口径（2026-11-22 用户裁决）：只内嵌 wheel（306 KB）；Python 3.14 解释器与 21 个
// 第三方依赖（约 197 MB）不内嵌，首次安装由 uv 下载——外部工具页的进度条盖的正是这一段。
// 内嵌而不是让 uvx 从 PyPI 现拉，为的是三件事：版本可复现（sha256 固定）、离线可修、
// 将来给上游打补丁（Snapshot 按窗口过滤等）时随 exe 一起走，见 docs/mcp-desktop/NOTICE.md。
//
// 纯引擎：不 import main、不碰 App；进度上报与事件推送由调用方注入（根壳 mcp_desktop_app.go）。
package desktopmcp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
	"datalens/internal/mcp"
)

const (
	// Version 内嵌的 windows-mcp 版本（写进释放目录名）。+p1 是本仓库的本地补丁版本：
	// 在 0.8.9 基础上加了 Snapshot 的 window 过滤、Type 的无坐标输入与 Find 工具（见 docs/mcp-desktop/NOTICE.md）。
	Version = "0.8.9+p3"
	// ServerName 桌面服务器在 mcp.json 里的名字（前端 DESKTOP_MCP_SERVER 必须一致）。
	ServerName = "windows"
	// WheelName 内嵌 wheel 的文件名（tools/pack-desktop-wheel.py 的产物）。
	WheelName = "windows_mcp-0.8.9+p3-py3-none-any.whl"
	// wheelEmbedPath 是它在 embed.FS 里的路径（相对仓库根）。
	wheelEmbedPath = "docs/mcp-desktop/" + WheelName
	// startupTimeoutMs 首次启动容得下 uv 下载解释器；缓存命中后大值无害。
	startupTimeoutMs = 600000
)

// Embedded 随 exe 分发的 docs/mcp-desktop 资源（根壳 desktop_mcp.go 注入）。
var Embedded fs.FS

// Logf 诊断日志出口（mcp.Logf 注入；未注入时静默）。
var Logf func(level, format string, args ...any)

// ToolInfo 一个上游工具的名字与风险标注。
// Risk 只用于设置页给用户提示，不参与授权判定——真正能不能用仍由
// enabledTools（应用侧勾选）+ 会话授权 + 控制模式三道闸决定。
type ToolInfo struct {
	Name string `json:"name"`
	Risk string `json:"risk,omitempty"` // "" 常规 / "high" 可执行命令或改系统
	Note string `json:"note,omitempty"`
}

// AllTools 是 windows-mcp 0.8.9 注册的全部工具（tools/__init__.py 的 13 个模块）。
// 顺序按「观察 → 输入 → 页面 → 系统」排列，设置页直接照这个顺序渲染开关。
// 与上游不一致时由 desktopmcp_test.go 的清单一致性用例兜住（改上游版本必须同步这张表）。
var AllTools = []ToolInfo{
	{Name: "Snapshot", Note: "屏幕截图 + 可交互元素树"},
	{Name: "Screenshot", Note: "纯截图，不提取元素"},
	{Name: "DisplayInventory", Note: "显示器清单与坐标系"},
	{Name: "Click", Note: "点击 / 双击 / 右键"},
	{Name: "Type", Note: "输入文本（可按元素编号定位）"},
	{Name: "Scroll", Note: "滚动"},
	{Name: "Move", Note: "移动指针 / 拖拽"},
	{Name: "Shortcut", Note: "键盘快捷键"},
	{Name: "Wait", Note: "固定时长等待"},
	{Name: "WaitFor", Note: "等元素 / 窗口 / 文本出现"},
	{Name: "Find", Note: "按名字找元素并直接点击 / 输入"},
	{Name: "Clipboard", Risk: "high", Note: "读写系统剪贴板"},
	{Name: "Scrape", Note: "抓取网页正文（可选当前页 DOM）"},
	{Name: "MultiSelect", Note: "批量点选"},
	{Name: "MultiEdit", Risk: "high", Note: "批量填充输入框"},
	{Name: "App", Risk: "high", Note: "启动程序 / 切换与调整窗口"},
	{Name: "Notification", Risk: "high", Note: "弹系统通知"},
	{Name: "Process", Risk: "high", Note: "进程列表与结束进程"},
	{Name: "PowerShell", Risk: "high", Note: "执行任意 PowerShell 脚本"},
	{Name: "FileSystem", Risk: "high", Note: "读写任意路径文件"},
	{Name: "Registry", Risk: "high", Note: "读写注册表"},
	{Name: "ControlStatus", Note: "上游的接管状态查询"},
}

// ToolNames 全部工具名（默认勾选清单）。
func ToolNames() []string {
	out := make([]string, 0, len(AllTools))
	for _, tool := range AllTools {
		out = append(out, tool.Name)
	}
	return out
}

// HasTool 判断名字是否在上游清单里（前端保存勾选时的兜底校验）。
func HasTool(name string) bool {
	for _, tool := range AllTools {
		if tool.Name == name {
			return true
		}
	}
	return false
}

// rootDir 释放根：与 mcp.json 同目录（对齐 internal/mcpsamples 的口径）。
func rootDir() string {
	if path := mcp.ConfigFilePath(); path != "" {
		return filepath.Dir(path)
	}
	return appdata.Root()
}

// WheelDir 当前版本的释放目录。
func WheelDir() string {
	root := rootDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "builtin-desktop-mcp", Version)
}

// WheelPath 释放后的 wheel 绝对路径（不保证存在）。
func WheelPath() string {
	dir := WheelDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, WheelName)
}

// EnsureWheel 把内嵌 wheel 释放到数据目录（内容一致则跳过），返回绝对路径。
func EnsureWheel() (string, error) {
	path := WheelPath()
	if path == "" {
		return "", errors.New("无法定位应用数据目录")
	}
	raw, err := fs.ReadFile(Embedded, wheelEmbedPath)
	if err != nil {
		return "", fmt.Errorf("内置桌面组件缺失：%w", err)
	}
	if existing, readErr := os.ReadFile(path); readErr == nil && bytes.Equal(existing, raw) {
		return path, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := atomfile.WriteFileAtomicMode(path, raw, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// ServerConfig 生成 mcp.json 里的桌面 server 行。
// 命令用 uvx --from <内置 wheel>：代码来源固定，依赖仍按 uv 缓存解析（首次下载）。
// EnabledTools 默认全选（用户要求：装好即可用，再逐项取消）；空数组语义是「一个都不给」，
// 所以这里必须显式写全。
func ServerConfig(wheelPath string) mcp.MCPServerConfig {
	enabled := true
	return mcp.MCPServerConfig{
		Command:          "uvx",
		Args:             []string{"--from", wheelPath, "windows-mcp", "serve", "--no-control"},
		Env:              defaultEnv(),
		Enabled:          &enabled,
		EnabledTools:     ToolNames(),
		StartupTimeoutMs: startupTimeoutMs,
		Notes:            serverNotes(),
	}
}

// defaultEnv 上游默认值：截图缩放 0.75、关掉接管闪屏与低级键盘钩子、关遥测。
func defaultEnv() map[string]string {
	return map[string]string{
		"WINDOWS_MCP_SCREENSHOT_SCALE":   "0.75",
		"WINDOWS_MCP_DISABLE_FLASH":      "1",
		"WINDOWS_MCP_SCREENSHOT_BACKEND": "auto",
		"WINDOWS_MCP_MAX_TREE_ELEMENTS":  "500",
		"WINDOWS_MCP_WATCHDOG":           "off",
		"ANONYMIZED_TELEMETRY":           "false",
	}
}

// serverNotes 注入系统提示词的 <mcp_server_notes>：写清边界与首次启动耗时。
func serverNotes() string {
	return strings.Join([]string{
		"桌面控制（Computer Use）：第三方原生窗口的 GUI 自动化，工具在用户开启会话授权并进入控制模式后才可用。",
		"想知道屏幕上是什么：Screenshot（纯截图，可用 display=[0] 选显示器、region=[left,top,right,bottom] 只截一块）",
		"或 Snapshot(use_vision=True)（连可交互元素一起给，元素带编号，Click/Type/Scroll 传 label=编号 比坐标稳）。",
		"页面内容用 Scrape(use_dom=True) 取正文。宿主会把返回的图片存成 PNG 并在文本里给出绝对路径，用 read_image 打开即可看到画面。",
		"首次启动 uv 会下载 Python 3.14 解释器与依赖（约 100–190 MB，耗时数分钟，启动超时已放宽到 10 分钟）。",
		"凡是可执行命令或改系统的工具（PowerShell / FileSystem / Registry / Process / App）默认由用户按需勾选；",
		"只操作用户明确要求的目标窗口，一次任务结束就停，并调 windows_control_mode 退出交还控制权。",
	}, "")
}

// Plan 给设置页与诊断用的只读快照（配置行、工具清单、wheel 状态）。
type Plan struct {
	Version          string     `json:"version"`
	ServerName       string     `json:"serverName"`
	WheelPath        string     `json:"wheelPath"`
	WheelReady       bool       `json:"wheelReady"`
	Command          string     `json:"command"`
	Args             []string   `json:"args"`
	EnabledTools     []string   `json:"enabledTools"`
	StartupTimeoutMs int        `json:"startupTimeoutMs"`
	Notes            string     `json:"notes"`
	Tools            []ToolInfo `json:"tools"`
}

// BuildPlan 生成只读计划（不释放 wheel、不起进程）。
func BuildPlan() Plan {
	path := WheelPath()
	ready := false
	if path != "" {
		if _, err := os.Stat(path); err == nil {
			ready = true
		}
	}
	cfg := ServerConfig(path)
	tools := make([]ToolInfo, len(AllTools))
	copy(tools, AllTools)
	return Plan{
		Version:          Version,
		ServerName:       ServerName,
		WheelPath:        path,
		WheelReady:       ready,
		Command:          cfg.Command,
		Args:             cfg.Args,
		EnabledTools:     cfg.EnabledTools,
		StartupTimeoutMs: cfg.StartupTimeoutMs,
		Notes:            cfg.Notes,
		Tools:            tools,
	}
}

// Progress 安装进度：Percent 是阶段估算（下载无法拿到真实字节比），Line 是上游日志尾行。
type Progress struct {
	Stage   string `json:"stage"`
	Detail  string `json:"detail,omitempty"`
	Percent int    `json:"percent"`
	Line    string `json:"line,omitempty"`
}

const (
	StageWheel = "release"
	StageUV    = "uv"
	StageWarm  = "warm"
	StageDone  = "done"
)

// Install 释放 wheel → 确保 uv 可用 → 预热依赖（下载 Python 与依赖）。report 可为 nil。
// 返回人类可读的步骤清单；错误原样上抛（调用方翻译成前端文案）。
func Install(ctx context.Context, report func(Progress)) ([]string, error) {
	emit := func(p Progress) {
		if report != nil {
			report(p)
		}
	}
	steps := make([]string, 0, 3)

	emit(Progress{Stage: StageWheel, Detail: "释放内置桌面组件", Percent: 4})
	path, err := EnsureWheel()
	if err != nil {
		return steps, err
	}
	steps = append(steps, "释放内置组件 windows-mcp "+Version)
	emit(Progress{Stage: StageWheel, Detail: "内置组件已就绪", Percent: 10})

	platformSteps, err := installPlatform(ctx, path, emit)
	steps = append(steps, platformSteps...)
	if err != nil {
		return steps, err
	}
	emit(Progress{Stage: StageDone, Detail: "安装完成", Percent: 100})
	return steps, nil
}

// EnsureServerWheel 是 mcp.PrepareServer 的组合实现之一：每次 spawn 前自愈。
// 触发场景真实存在——设置 → 存储清理把 builtin-desktop-mcp 当缓存删掉，或版本升级后
// 释放目录变成新版本号而 mcp.json 里仍指旧路径；没有这条路径，server 会初始化失败十次后放弃。
func EnsureServerWheel(cfg mcp.MCPServerConfig) {
	if !isOurConfig(cfg) {
		return
	}
	path := WheelPath()
	if path == "" {
		return
	}
	if _, err := os.Stat(path); err == nil {
		return
	}
	if _, err := EnsureWheel(); err != nil {
		logf("warn", "内置桌面组件补回失败（%s）：%v", path, err)
		return
	}
	logf("info", "内置桌面组件已补回：%s", path)
}

// isOurConfig 只认 args 里 --from 指向我们释放目录的配置行，绝不动用户自备的 windows-mcp 配置。
func isOurConfig(cfg mcp.MCPServerConfig) bool {
	base := filepath.Join(rootDir(), "builtin-desktop-mcp")
	if base == filepath.Join("", "builtin-desktop-mcp") {
		return false
	}
	for i, arg := range cfg.Args {
		if strings.TrimSpace(arg) != "--from" || i+1 >= len(cfg.Args) {
			continue
		}
		raw := strings.TrimSpace(cfg.Args[i+1])
		if raw == "" {
			continue
		}
		abs, err := filepath.Abs(raw)
		if err != nil {
			continue
		}
		if strings.HasPrefix(strings.ToLower(abs), strings.ToLower(base)+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}
