package mcp

// Client：MCP 管理器生命周期与 Wails 绑定方法的宿主服务，main.App 以服务嵌入。
// 管理器在 InitClient 之前为 nil（浮窗 / 调试控制台进程不初始化，不拉子进程）。

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
)

type Client struct {
	mu  sync.Mutex
	mgr *Manager
}

func (c *Client) manager() *Manager {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.mgr
}

// InitClient 注入事件出口并加载配置（不启动任何进程——惰性）。
func InitClient(c *Client, emit func(event string, payload any)) error {
	c.mu.Lock()
	if c.mgr == nil {
		c.mgr = NewManager(emit)
	}
	mgr := c.mgr
	c.mu.Unlock()
	return mgr.LoadInitialConfig()
}

// CloseClient 应用退出前全量关闭（总预算 8s）。
func CloseClient(c *Client) {
	if mgr := c.manager(); mgr != nil {
		mgr.CloseAll()
	}
}

func (c *Client) MCPGetConfig() (MCPConfig, error) {
	return ReadConfig()
}

// ApplyConfigFromDisk 让运行态按 mcp.json 现状重建。给「绕过本 Client 直接写盘」的路径补应用：
// 最典型是内置示例安装（mcpsamples.MCPInstallSample 只释放脚本 + 写盘），漏了这一步新 server
// 不进 m.servers，MCPSnapshot 的惰性启动看不到它、也不会发 mcp-tools-changed——表现就是
// 「装好了列表没刷新，退出重进才出现」。包级函数而非 Client 方法：不新增 Wails 绑定面。
func ApplyConfigFromDisk(c *Client) error {
	cfg, err := ReadConfig()
	if err != nil {
		return err
	}
	if mgr := c.manager(); mgr != nil {
		mgr.ApplyConfig(cfg)
	}
	return nil
}

// MCPWriteConfig 保存配置：写入期校验拒绝坏条目 → 原子落盘 → 应用到运行态
// （停掉的旧进程等待关闭确认后才替换，见 applyConfig）。
func (c *Client) MCPWriteConfig(cfg MCPConfig) error {
	for name, s := range cfg.MCPServers {
		if err := ValidateServer(name, s); err != nil {
			return err
		}
	}
	if err := WriteConfig(cfg); err != nil {
		return err
	}
	if mgr := c.manager(); mgr != nil {
		mgr.ApplyConfig(cfg)
	}
	return nil
}

// MCPSnapshot 兜底拉取：返回全量快照并触发惰性启动（首次需要工具清单时才起进程）。
func (c *Client) MCPSnapshot() Snapshot {
	mgr := c.manager()
	if mgr == nil {
		return Snapshot{Enabled: false, Servers: []SnapshotServer{}}
	}
	mgr.LazyStartAll()
	return mgr.Snapshot()
}

// MCPCallTool 转发一次工具调用。args 是 JSON 对象文本（空串视为 {}）。
func (c *Client) MCPCallTool(publicName, args string) (CallResult, error) {
	mgr := c.manager()
	if mgr == nil {
		return CallResult{}, errors.New("MCP 客户端未启用")
	}
	var raw json.RawMessage
	if strings.TrimSpace(args) != "" {
		if !json.Valid([]byte(args)) {
			return CallResult{}, errors.New("工具参数不是合法 JSON")
		}
		raw = json.RawMessage(args)
	}
	return mgr.CallTool(publicName, raw)
}

// MCPListServerTools 工具勾选面板用：拉取该 server 的原始工具清单。
func (c *Client) MCPListServerTools(name string) ([]RemoteTool, error) {
	mgr := c.manager()
	if mgr == nil {
		return nil, errors.New("MCP 客户端未启用")
	}
	return mgr.RawToolsForPanel(name)
}

// MCPProbeServer 探测：设置页「测试连接」。独立临时进程，只读，总预算 10s。
func (c *Client) MCPProbeServer(name string, cfg MCPServerConfig) (ProbeResult, error) {
	return ProbeServer(context.Background(), name, cfg), nil
}

func (c *Client) MCPRestartServer(name string) error {
	mgr := c.manager()
	if mgr == nil {
		return errors.New("MCP 客户端未启用")
	}
	return mgr.RestartServer(name)
}

// MCPSetServerEnabled 列表行快捷启停开关：读盘 → 翻转 → 校验落盘 → 应用。
func (c *Client) MCPSetServerEnabled(name string, enabled bool) error {
	cfg, err := ReadConfig()
	if err != nil {
		return err
	}
	s, ok := cfg.MCPServers[name]
	if !ok {
		return errors.New("服务器 " + name + " 不存在")
	}
	s.Enabled = &enabled
	cfg.MCPServers[name] = s
	if err := WriteConfig(cfg); err != nil {
		return err
	}
	if mgr := c.manager(); mgr != nil {
		mgr.ApplyConfig(cfg)
	}
	return nil
}
