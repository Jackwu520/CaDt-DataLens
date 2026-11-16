// config.go：外部工具配置（external-tools.json）的结构、默认值与归一化。
// 文件位置由根目录壳注入（应用数据目录）；本包只负责解析、校验与原子落盘。
package webtools

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"datalens/internal/atomfile"
)

const (
	// DefaultProviderBaseURL 是服务提供商（DeepSeek 工具 API）的默认基础地址。
	DefaultProviderBaseURL = "https://api.deepseek.com/v1/tools"

	externalToolsFileMax = 256 << 10
)

// 能力来源。builtin 仅 search / fetch 有效；其余能力写了也按 off 处理。
const (
	ModeBuiltin  = "builtin"
	ModeProvider = "provider"
	ModeMCP      = "mcp"
	ModeOff      = "off"
)

// CapabilityKeys 是五种能力的固定顺序（配置、设置页与前端来源矩阵共用）。
var CapabilityKeys = []string{"search", "fetch", "ocr", "tts", "asr"}

var capabilityLabels = map[string]string{
	"search": "网页搜索",
	"fetch":  "网页抓取",
	"ocr":    "OCR / 文件解析",
	"tts":    "语音合成",
	"asr":    "语音识别",
}

// Capability 单个能力的来源配置。
type Capability struct {
	Mode string `json:"mode"`
}

// Config external-tools.json 的完整结构。APIKey 只在 Go 侧读写，对前端永远掩码。
type Config struct {
	Enabled      bool                  `json:"enabled"`
	BaseURL      string                `json:"baseUrl"`
	APIKey       string                `json:"apiKey"`
	SearchCount  int                   `json:"searchCount"`
	Capabilities map[string]Capability `json:"capabilities"`
	MCPBindings  map[string]string     `json:"mcpBindings"`
}

// DefaultConfig 返回默认配置：搜索/抓取内置，OCR/语音关闭，提供商总开关关闭。
func DefaultConfig() Config {
	caps := make(map[string]Capability, len(CapabilityKeys))
	bindings := make(map[string]string, len(CapabilityKeys))
	for _, key := range CapabilityKeys {
		mode := ModeOff
		if key == "search" || key == "fetch" {
			mode = ModeBuiltin
		}
		caps[key] = Capability{Mode: mode}
		bindings[key] = ""
	}
	return Config{
		Enabled:      false,
		BaseURL:      "",
		APIKey:       "",
		SearchCount:  10,
		Capabilities: caps,
		MCPBindings:  bindings,
	}
}

// NormalizeConfig 补默认值、裁剪越界值。未知能力与非法 mode 一律回到默认。
func NormalizeConfig(cfg Config) Config {
	out := DefaultConfig()
	out.Enabled = cfg.Enabled
	out.APIKey = strings.TrimSpace(cfg.APIKey)
	out.BaseURL = strings.TrimSpace(cfg.BaseURL)
	if cfg.SearchCount > 0 {
		out.SearchCount = cfg.SearchCount
	}
	if out.SearchCount < 1 {
		out.SearchCount = 1
	}
	if out.SearchCount > 50 {
		out.SearchCount = 50
	}
	for _, key := range CapabilityKeys {
		raw, ok := cfg.Capabilities[key]
		if !ok {
			continue
		}
		mode := strings.ToLower(strings.TrimSpace(raw.Mode))
		allowed := mode == ModeOff || mode == ModeProvider || mode == ModeMCP
		if key == "search" || key == "fetch" {
			allowed = allowed || mode == ModeBuiltin
		}
		if allowed {
			out.Capabilities[key] = Capability{Mode: mode}
		}
	}
	for _, key := range CapabilityKeys {
		if binding, ok := cfg.MCPBindings[key]; ok {
			binding = strings.TrimSpace(binding)
			if len(binding) > 200 {
				binding = binding[:200]
			}
			out.MCPBindings[key] = binding
		}
	}
	return out
}

// LoadConfig 读取配置文件；文件不存在时返回默认配置。损坏的 JSON 会报错，由调用方决定是否覆盖。
func LoadConfig(path string) (Config, error) {
	if strings.TrimSpace(path) == "" {
		return Config{}, errors.New("无法定位外部工具配置目录")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultConfig(), nil
		}
		return Config{}, err
	}
	if info.Size() > externalToolsFileMax {
		return Config{}, fmt.Errorf("外部工具配置超过 %d KB", externalToolsFileMax/1024)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, fmt.Errorf("外部工具配置解析失败：%w", err)
	}
	return NormalizeConfig(cfg), nil
}

// SaveConfig 归一化后原子写入（0600，与 ai-config.json 同口径）。
func SaveConfig(path string, cfg Config) error {
	if strings.TrimSpace(path) == "" {
		return errors.New("无法定位外部工具配置目录")
	}
	raw, err := json.MarshalIndent(NormalizeConfig(cfg), "", "  ")
	if err != nil {
		return err
	}
	return atomfile.WriteFileAtomicMode(path, raw, 0o600)
}

// MaskedConfig 返回给前端的配置视图：不回传 API Key 明文，只给 hasKey。
func MaskedConfig(cfg Config) map[string]interface{} {
	cfg = NormalizeConfig(cfg)
	return map[string]interface{}{
		"enabled":        cfg.Enabled,
		"baseUrl":        cfg.BaseURL,
		"apiKeySet":      cfg.APIKey != "",
		"searchCount":    cfg.SearchCount,
		"capabilities":   cfg.Capabilities,
		"mcpBindings":    cfg.MCPBindings,
		"defaultBaseUrl": DefaultProviderBaseURL,
	}
}

// ModeOf 返回某个能力的归一化来源。
func (c Config) ModeOf(capability string) string {
	cfg := NormalizeConfig(c)
	if item, ok := cfg.Capabilities[strings.ToLower(strings.TrimSpace(capability))]; ok {
		return item.Mode
	}
	return ModeOff
}

// ProviderReady 服务提供商总开关打开且配置了 Key。
func (c Config) ProviderReady() bool {
	return c.Enabled && strings.TrimSpace(c.APIKey) != ""
}

// RequireProvider 校验某能力确实选择了服务提供商且凭据就绪（工具执行侧硬拒绝兜底）。
func RequireProvider(cfg Config, capability string) error {
	key := strings.ToLower(strings.TrimSpace(capability))
	label := capabilityLabels[key]
	if label == "" {
		label = key
	}
	if cfg.ModeOf(key) != ModeProvider {
		return fmt.Errorf("「%s」的来源不是服务提供商（设置 → AI → 外部工具）", label)
	}
	if !cfg.Enabled {
		return fmt.Errorf("「%s」需要服务提供商，但总开关未启用", label)
	}
	if strings.TrimSpace(cfg.APIKey) == "" {
		return fmt.Errorf("「%s」需要服务提供商，但尚未填写 API Key", label)
	}
	return nil
}
