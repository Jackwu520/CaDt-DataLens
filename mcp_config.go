// mcp_config.go：MCP 服务器配置（mcp.json）——Go 独占读写、0600 原子写、写入期校验。
// 独立于 ai-config.json（后者由前端整块读写覆盖，混入结构化配置冲突面太大）。
// 读取时损坏/超限一律报错，绝不自动重写——那会洗掉用户手写的内容。
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	mcpConfigFileMax           = 1 << 20
	mcpConfigVersion           = 1
	mcpMaxArgsCount            = 128 // 与 normalizeCommandArgs 的上限一致
	mcpTimeoutMaxMs            = 600000
	mcpDefaultStartupTimeoutMs = 30000
	mcpDefaultCallTimeoutMs    = 60000
	mcpDefaultCloseTimeoutMs   = 5000
)

var (
	// serverName 是 mcp.json 的键，也是工具 namespace 的唯一来源（绝不用远程 serverInfo.name）。
	mcpServerNameRule  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	// 原始工具名允许点号等字符（如 context7.resolve-library-id）；公开名的合法性由 mcp_name.go 保证。
	mcpRawToolNameRule = regexp.MustCompile(`^[A-Za-z0-9_.:@/-]{1,128}$`)
)

type MCPServerConfig struct {
	Command          string            `json:"command"`
	Args             []string          `json:"args,omitempty"`
	Env              map[string]string `json:"env,omitempty"`
	Cwd              string            `json:"cwd,omitempty"`
	Enabled          *bool             `json:"enabled,omitempty"`          // 缺省 = 启用；显式 false = 停用但保留条目
	StartupTimeoutMs int               `json:"startupTimeoutMs,omitempty"` // 0 = 默认 30000
	CallTimeoutMs    int               `json:"callTimeoutMs,omitempty"`    // 0 = 默认 60000
	CloseTimeoutMs   int               `json:"closeTimeoutMs,omitempty"`   // 0 = 默认 5000
	EnabledTools     []string          `json:"enabledTools"`               // 显式勾选；空 = 一个都不给（刻意的安全默认，不是 bug）
}

type MCPConfig struct {
	Version    int                        `json:"version"`
	Enabled    *bool                      `json:"enabled,omitempty"` // 客户端总开关：缺省 = 启用；关闭时工具全部移除、进程全部停止
	MCPServers map[string]MCPServerConfig `json:"mcpServers"`
}

// mcpConfigEnabled：总开关缺省视为启用。没有 server 时本就零进程，默认开无副作用。
func mcpConfigEnabled(cfg MCPConfig) bool {
	return cfg.Enabled == nil || *cfg.Enabled
}

func mcpConfigFilePath() string {
	return mcpConfigFilePathAt(appDataRoot())
}

func mcpConfigFilePathAt(configDir string) string {
	if configDir == "" {
		return ""
	}
	return filepath.Join(configDir, "mcp.json")
}

// mcpServerEnabled：Enabled 缺省（nil）视为启用——手写 mcp.json 时最自然的预期。
func mcpServerEnabled(s MCPServerConfig) bool {
	return s.Enabled == nil || *s.Enabled
}

func (s MCPServerConfig) startupTimeout() time.Duration {
	if s.StartupTimeoutMs > 0 {
		return time.Duration(s.StartupTimeoutMs) * time.Millisecond
	}
	return mcpDefaultStartupTimeoutMs * time.Millisecond
}

func (s MCPServerConfig) callTimeout() time.Duration {
	if s.CallTimeoutMs > 0 {
		return time.Duration(s.CallTimeoutMs) * time.Millisecond
	}
	return mcpDefaultCallTimeoutMs * time.Millisecond
}

func (s MCPServerConfig) closeTimeout() time.Duration {
	if s.CloseTimeoutMs > 0 {
		return time.Duration(s.CloseTimeoutMs) * time.Millisecond
	}
	return mcpDefaultCloseTimeoutMs * time.Millisecond
}

// readMCPConfig 读取 mcp.json。不存在返回空配置不报错；损坏/超限返回错误让设置页展示，
// 绝不自动重写成空配置。
func readMCPConfig() (MCPConfig, error) {
	return readMCPConfigAt(mcpConfigFilePath())
}

func readMCPConfigAt(path string) (MCPConfig, error) {
	var cfg MCPConfig
	if path == "" {
		return cfg, errors.New("无法定位应用数据目录")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	if info.Size() > mcpConfigFileMax {
		return cfg, fmt.Errorf("MCP 配置超过 %d KB", mcpConfigFileMax/1024)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := mcpCheckDuplicateKeys(raw); err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("MCP 配置不是合法 JSON：%w", err)
	}
	if cfg.Version != 0 && cfg.Version != mcpConfigVersion {
		return cfg, fmt.Errorf("MCP 配置版本不支持：%d", cfg.Version)
	}
	return cfg, nil
}

// writeMCPConfig 写入 mcp.json。写入期校验：坏条目当场拒绝落盘，用户改配置的当下就知道错在哪，
// 而不是下次开 AI 面板看到一句「启动失败」。
func writeMCPConfig(cfg MCPConfig) error {
	return writeMCPConfigAt(mcpConfigFilePath(), cfg)
}

func writeMCPConfigAt(path string, cfg MCPConfig) error {
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	if cfg.Version == 0 {
		cfg.Version = mcpConfigVersion
	}
	if cfg.MCPServers == nil {
		cfg.MCPServers = map[string]MCPServerConfig{}
	}
	for name, s := range cfg.MCPServers {
		if err := mcpValidateServer(name, s); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if len(data) > mcpConfigFileMax {
		return fmt.Errorf("MCP 配置超过 %d KB", mcpConfigFileMax/1024)
	}
	return writeFileAtomicMode(path, data, 0o600)
}

// mcpValidateServer 校验单个 server 条目。EnabledTools 不在这里校验存在性——
// 写入时进程可能从未启动（本方案明确不预探测），存在性对账移到保存后的异步工具面板（§15.1）。
func mcpValidateServer(name string, s MCPServerConfig) error {
	if !mcpServerNameRule.MatchString(name) {
		return fmt.Errorf("服务器名 %q 不合法：只能用字母数字下划线连字符，最长 32", name)
	}
	if strings.TrimSpace(s.Command) == "" {
		return fmt.Errorf("服务器 %s：缺少启动命令", name)
	}
	if len(s.Args) > mcpMaxArgsCount {
		return fmt.Errorf("服务器 %s：参数个数超过上限 %d", name, mcpMaxArgsCount)
	}
	for _, t := range []struct {
		label string
		v     int
	}{{"startupTimeoutMs", s.StartupTimeoutMs}, {"callTimeoutMs", s.CallTimeoutMs}, {"closeTimeoutMs", s.CloseTimeoutMs}} {
		if t.v < 0 || t.v > mcpTimeoutMaxMs {
			return fmt.Errorf("服务器 %s：%s 必须在 0 或 1–%d 毫秒之间", name, t.label, mcpTimeoutMaxMs)
		}
	}
	seen := map[string]bool{}
	for _, tool := range s.EnabledTools {
		if strings.TrimSpace(tool) == "" {
			return fmt.Errorf("服务器 %s：勾选的工具名不能为空", name)
		}
		if !mcpRawToolNameRule.MatchString(tool) {
			return fmt.Errorf("服务器 %s：工具名 %q 不合法", name, tool)
		}
		if seen[tool] {
			return fmt.Errorf("服务器 %s：工具 %q 重复勾选", name, tool)
		}
		seen[tool] = true
	}
	return nil
}

// mcpCheckDuplicateKeys 拒绝含重复键的 JSON。encoding/json 对重复键是「后者静默覆盖」，
// 用户手写配置时复制粘贴漏改键名会被静默吞掉，以为配置没生效。
func mcpCheckDuplicateKeys(raw []byte) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("MCP 配置不是合法 JSON：%w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return errors.New("MCP 配置顶层必须是 JSON 对象")
	}
	if err := mcpScanJSONObject(dec); err != nil {
		return err
	}
	if _, err := dec.Token(); err != io.EOF {
		return errors.New("MCP 配置顶层之后有多余内容")
	}
	return nil
}

func mcpScanJSONObject(dec *json.Decoder) error {
	seen := map[string]bool{}
	for {
		tok, err := dec.Token()
		if err != nil {
			return fmt.Errorf("MCP 配置不是合法 JSON：%w", err)
		}
		if d, ok := tok.(json.Delim); ok {
			if d == '}' {
				return nil
			}
			return fmt.Errorf("MCP 配置 JSON 解析错误：意外的分隔符 %v", d)
		}
		key, ok := tok.(string)
		if !ok {
			return errors.New("MCP 配置 JSON 解析错误：键不是字符串")
		}
		if seen[key] {
			return fmt.Errorf("MCP 配置存在重复键 %q（后者会静默覆盖前者，请修正后重试）", key)
		}
		seen[key] = true
		if err := mcpScanJSONValue(dec); err != nil {
			return err
		}
	}
}

func mcpScanJSONValue(dec *json.Decoder) error {
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	switch d, ok := tok.(json.Delim); {
	case !ok:
		return nil // 标量：不含键，无需下探
	case d == '{':
		return mcpScanJSONObject(dec)
	case d == '[':
		return mcpScanJSONArray(dec)
	default:
		return fmt.Errorf("MCP 配置 JSON 解析错误：意外的分隔符 %v", d)
	}
}

func mcpScanJSONArray(dec *json.Decoder) error {
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		if d, ok := tok.(json.Delim); !ok {
			continue // 标量元素
		} else if d == ']' {
			return nil
		} else if d == '{' {
			if err := mcpScanJSONObject(dec); err != nil {
				return err
			}
		} else if d == '[' {
			if err := mcpScanJSONArray(dec); err != nil {
				return err
			}
		} else {
			return fmt.Errorf("MCP 配置 JSON 解析错误：意外的分隔符 %v", d)
		}
	}
}
