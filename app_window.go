package main

// 应用状态与窗口：脏标记、应用配置（open mode）、多窗口与资源管理器定位。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) SetDirty(dirty bool) {
	a.dirty = dirty
}

// SetAIRunning：前端在 AI 回合开始/结束时同步（关窗二次确认依据，见 beforeClose）。
func (a *App) SetAIRunning(running bool) {
	a.aiRunning = running
}

type appConfig struct {
	OpenMode        string   `json:"openMode"`
	PluginsPathMode string   `json:"pluginsPathMode,omitempty"`
	DisabledPlugins []string `json:"disabledPlugins,omitempty"`
	DeveloperMode   bool     `json:"developerMode,omitempty"`
}

func defaultAppConfig() appConfig {
	return appConfig{OpenMode: "tab", PluginsPathMode: "portable"}
}

func readAppConfig() appConfig {
	cfg := defaultAppConfig()
	path := configFilePath()
	if path == "" {
		return cfg
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	var stored appConfig
	if json.Unmarshal(raw, &stored) != nil {
		return cfg
	}
	if stored.OpenMode == "window" {
		cfg.OpenMode = "window"
	}
	if stored.PluginsPathMode == "appdata" {
		cfg.PluginsPathMode = "appdata"
	}
	if stored.DisabledPlugins != nil {
		cfg.DisabledPlugins = stored.DisabledPlugins
	}
	cfg.DeveloperMode = stored.DeveloperMode
	return cfg
}

func saveAppConfig(cfg appConfig) error {
	path := configFilePath()
	if path == "" {
		return fmt.Errorf("无法定位配置目录")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}

func readOpenMode() string {
	return readAppConfig().OpenMode
}

func randomLaunchID() string {
	return fmt.Sprintf("cadt-datalens-window-%d-%d", os.Getpid(), time.Now().UnixNano())
}

func uniqueIDForArgs(args []string) string {
	for _, arg := range args {
		if arg == "--new-window" {
			return randomLaunchID()
		}
	}
	if readOpenMode() == "window" {
		return randomLaunchID()
	}
	return "cadt-datalens-7f3a9c21"
}

func uniqueIDForLaunch() string {
	return uniqueIDForArgs(os.Args[1:])
}

func (a *App) GetOpenMode() string {
	return readOpenMode()
}

// ReadImageAsDataURL 读取本地图片为 data URL（供 Markdown 预览解析相对路径图片）。
func (a *App) ReadImageAsDataURL(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("路径为空")
	}
	ext := strings.ToLower(filepath.Ext(path))
	mime := map[string]string{
		".png":  "image/png",
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".gif":  "image/gif",
		".webp": "image/webp",
		".bmp":  "image/bmp",
		".svg":  "image/svg+xml",
	}
	m, ok := mime[ext]
	if !ok {
		return "", fmt.Errorf("不支持的图片格式: %s", ext)
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > 30*1024*1024 {
		return "", fmt.Errorf("图片过大（>30MB）")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return "data:" + m + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func (a *App) GetAppVersion() string {
	return appVersion
}

func (a *App) SetOpenMode(mode string) error {
	if mode != "window" {
		mode = "tab"
	}
	cfg := readAppConfig()
	cfg.OpenMode = mode
	return saveAppConfig(cfg)
}

func (a *App) OpenNewWindow() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--new-window")
	cmd.Dir = filepath.Dir(exe)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// OpenDirInNewWindow 在独立新窗口打开目录（一目录一窗口）。
// 带 --new-window 参数让新实例拿到独立 SingleInstanceLock ID，从而真正开出新窗口；
// 不改动配置里的默认打开模式（文件仍按 openMode 走）。
func (a *App) OpenDirInNewWindow(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return fmt.Errorf("没有目录")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是目录：%s", dir)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--new-window", dir)
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// OpenWorkspaceForConversation 软切换：当前窗口已有工作区时，另开窗口打开目标工作区，
// 并把目标 AI 会话 id 传给新窗口（新窗口启动后恢复工作区环境并选中该会话）。
func (a *App) OpenWorkspaceForConversation(dir string, sessionID string) error {
	if strings.TrimSpace(dir) == "" {
		return fmt.Errorf("没有目录")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("不是目录：%s", dir)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{"--new-window", dir}
	if id := strings.TrimSpace(sessionID); id != "" {
		args = append(args, "--ai-session="+id)
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

func (a *App) ShowInFolder(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("路径不存在：%s", path)
	}
	cmd := exec.Command("explorer.exe", explorerArgs(path, info.IsDir())...)
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}

// explorerArgs 构造 ShowInFolder 传给 explorer.exe 的参数。
// 路径必须先经 filepath.Clean 归一成 Windows 原生分隔符：前端（AI 日志目录等）传来的
// 路径是正斜杠形式，explorer.exe 的命令行解析把 / 开头的段当开关处理，
// 解析失败时不会报错，而是回退打开「文档」文件夹。
func explorerArgs(path string, isDir bool) []string {
	cleaned := filepath.Clean(path)
	if isDir {
		return []string{cleaned}
	}
	return []string{"/select,", cleaned}
}

func (a *App) CopyText(text string) error {
	return runtime.ClipboardSetText(a.ctx, text)
}

func (a *App) GetClipboardText() (string, error) {
	return runtime.ClipboardGetText(a.ctx)
}

// GetClipboardImage 把剪贴板里的图片读成 PNG data URL（空串表示没有图片）。
// 编辑器/AI 输入框的右键菜单「粘贴」拿不到 paste 事件，只能由后端回读系统剪贴板。
func (a *App) GetClipboardImage() (string, error) {
	return clipboardImageDataURL()
}

func (a *App) OpenInNewWindows(paths []string) error {
	_ = a.SetOpenMode("window")
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	started := 0
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		cmd := exec.Command(exe, path)
		cmd.Dir = filepath.Dir(path)
		if err := cmd.Start(); err != nil {
			return err
		}
		_ = cmd.Process.Release()
		started++
	}
	if started == 0 {
		return fmt.Errorf("没有可打开的文件")
	}
	return nil
}

func (a *App) SetWindowBg(r, g, b int) {
	clamp := func(v int) uint8 {
		if v < 0 {
			return 0
		}
		if v > 255 {
			return 255
		}
		return uint8(v)
	}
	runtime.WindowSetBackgroundColour(a.ctx, clamp(r), clamp(g), clamp(b), 255)
}

func (a *App) beforeClose(ctx context.Context) bool {
	if a.forceClose || (!a.dirty && !a.aiRunning) {
		a.mcpCloseAll() // MCP 子进程全量关闭（总预算 8s，超时靠 taskkill 兜底）
		a.stopWorkspaceWatch()
		return false
	}
	runtime.EventsEmit(ctx, "confirm-close", map[string]bool{"dirty": a.dirty, "aiRunning": a.aiRunning})
	return true
}

func (a *App) ForceClose() {
	a.forceClose = true
	a.dirty = false
	a.aiRunning = false
	a.mcpCloseAll()
	a.stopWorkspaceWatch()
	runtime.Quit(a.ctx)
}
