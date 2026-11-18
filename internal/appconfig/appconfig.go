// appconfig：应用配置文件（config.json，打开方式 / 插件目录 / 开发者模式 / 数据源）读写。
//
// Read 是「宽容读」：文件缺失、JSON 损坏、字段取值非法一律回落默认值，不向调用方抛错，
// 保证坏配置不会让应用起不来。Save 是整体覆盖写（非原子），只由设置页在用户确认后调用。
package appconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"datalens/internal/appdata"
	"datalens/internal/plugins"
)

// Config 是 config.json 的磁盘结构。
type Config struct {
	OpenMode        string   `json:"openMode"`
	PluginsPathMode string   `json:"pluginsPathMode,omitempty"`
	DisabledPlugins []string `json:"disabledPlugins,omitempty"`
	DeveloperMode   bool     `json:"developerMode,omitempty"`
	DataSource      string   `json:"dataSource,omitempty"`
}

// Default 返回无配置时的默认值。
func Default() Config {
	return Config{OpenMode: "tab", PluginsPathMode: "portable", DataSource: plugins.MarketSourceGitee}
}

// Path 返回 config.json 的绝对路径（应用数据根目录不可用时返回空串）。
func Path() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "config.json")
}

// Read 读取配置并归一化；文件缺失或损坏时返回默认值。
func Read() Config {
	cfg := Default()
	path := Path()
	if path == "" {
		return cfg
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	var stored Config
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
	cfg.DataSource = plugins.NormalizeMarketSource(stored.DataSource)
	return cfg
}

// Save 整体覆盖写回配置（先建目录；os.WriteFile 直接覆盖，非临时文件+改名）。
func Save(cfg Config) error {
	path := Path()
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

// OpenMode 返回文件打开方式（tab / window）。
func OpenMode() string {
	return Read().OpenMode
}
