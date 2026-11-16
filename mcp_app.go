// mcp_app.go：MCP 客户端的 Wails 薄包装——核心逻辑都在 internal/mcp，
// 这里只做入口转发与 emit 接线（仿 patch_app.go 的薄包装约定）。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"datalens/internal/mcp"
)

// 宿主注入：诊断日志、appdata 目录与应用版本都来自 main 包。
func init() {
	mcp.Logf = writeAppLog
	mcp.AppDataDir = appDataRoot
	mcp.Version = appVersion
}

// mcpGet 返回 MCP 管理器；浮窗 / 调试控制台进程未初始化时为 nil（工具列表为空，不拉子进程）。
func (a *App) mcpGet() *mcp.Manager {
	a.muMCP.Lock()
	defer a.muMCP.Unlock()
	return a.mcp
}

// initMCPManager 主窗口进程在 startup 里初始化（配置加载不启动任何进程——惰性）。
func (a *App) initMCPManager() {
	a.muMCP.Lock()
	if a.mcp == nil {
		a.mcp = mcp.NewManager(func(event string, payload any) {
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, event, payload)
			}
		})
	}
	mgr := a.mcp
	a.muMCP.Unlock()
	if err := mgr.LoadInitialConfig(); err != nil {
		// 损坏的 mcp.json 不阻塞启动：设置页会读到同样的错误并展示路径
		writeAppLog("warn", "MCP 配置加载失败：%v", err)
	}
}

func (a *App) MCPGetConfig() (mcp.MCPConfig, error) {
	return mcp.ReadConfig()
}

// MCPWriteConfig 保存配置：写入期校验拒绝坏条目 → 原子落盘 → 应用到运行态
// （停掉的旧进程等待关闭确认后才替换，见 applyConfig）。
func (a *App) MCPWriteConfig(cfg mcp.MCPConfig) error {
	for name, s := range cfg.MCPServers {
		if err := mcp.ValidateServer(name, s); err != nil {
			return err
		}
	}
	if err := mcp.WriteConfig(cfg); err != nil {
		return err
	}
	if mgr := a.mcpGet(); mgr != nil {
		mgr.ApplyConfig(cfg)
	}
	return nil
}

// MCPSnapshot 兜底拉取：返回全量快照并触发惰性启动（首次需要工具清单时才起进程）。
func (a *App) MCPSnapshot() mcp.Snapshot {
	mgr := a.mcpGet()
	if mgr == nil {
		return mcp.Snapshot{Enabled: false, Servers: []mcp.SnapshotServer{}}
	}
	mgr.LazyStartAll()
	return mgr.Snapshot()
}

// MCPCallTool 转发一次工具调用。args 是 JSON 对象文本（空串视为 {}）。
func (a *App) MCPCallTool(publicName, args string) (mcp.CallResult, error) {
	mgr := a.mcpGet()
	if mgr == nil {
		return mcp.CallResult{}, errors.New("MCP 客户端未启用")
	}
	var raw json.RawMessage
	if strings.TrimSpace(args) != "" {
		if !json.Valid([]byte(args)) {
			return mcp.CallResult{}, errors.New("工具参数不是合法 JSON")
		}
		raw = json.RawMessage(args)
	}
	return mgr.CallTool(publicName, raw)
}

// MCPListServerTools 工具勾选面板用：拉取该 server 的原始工具清单。
func (a *App) MCPListServerTools(name string) ([]mcp.RemoteTool, error) {
	mgr := a.mcpGet()
	if mgr == nil {
		return nil, errors.New("MCP 客户端未启用")
	}
	return mgr.RawToolsForPanel(name)
}

// MCPProbeServer 探测：设置页「测试连接」。独立临时进程，只读，总预算 10s。
func (a *App) MCPProbeServer(name string, cfg mcp.MCPServerConfig) (mcp.ProbeResult, error) {
	return mcp.ProbeServer(context.Background(), name, cfg), nil
}

func (a *App) MCPRestartServer(name string) error {
	mgr := a.mcpGet()
	if mgr == nil {
		return errors.New("MCP 客户端未启用")
	}
	return mgr.RestartServer(name)
}

// MCPSetServerEnabled 列表行快捷启停开关：读盘 → 翻转 → 校验落盘 → 应用。
func (a *App) MCPSetServerEnabled(name string, enabled bool) error {
	cfg, err := mcp.ReadConfig()
	if err != nil {
		return err
	}
	s, ok := cfg.MCPServers[name]
	if !ok {
		return errors.New("服务器 " + name + " 不存在")
	}
	s.Enabled = &enabled
	cfg.MCPServers[name] = s
	if err := mcp.WriteConfig(cfg); err != nil {
		return err
	}
	if mgr := a.mcpGet(); mgr != nil {
		mgr.ApplyConfig(cfg)
	}
	return nil
}

// mcpCloseAll 应用退出前全量关闭（总预算 8s）。beforeClose 与 ForceClose 都走这里。
func (a *App) mcpCloseAll() {
	if mgr := a.mcpGet(); mgr != nil {
		mgr.CloseAll()
	}
}
