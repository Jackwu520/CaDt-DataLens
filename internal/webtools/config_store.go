package webtools

// external-tools.json 的默认位置与保存合并规则（原 main/webtools_config.go 的路径与掩码逻辑）。

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"datalens/internal/appdata"
)

// ConfigPath 返回 external-tools.json 的绝对路径；应用数据目录不可用时返回空。
func ConfigPath() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "external-tools.json")
}

// LoadDefaultConfig 从默认路径加载配置。
func LoadDefaultConfig() (Config, error) {
	path := ConfigPath()
	if path == "" {
		return Config{}, errors.New("无法定位应用数据目录")
	}
	return LoadConfig(path)
}

// MergeAndSaveConfig 用前端 payload 更新默认路径配置；apiKey 留空表示保持原值。
func MergeAndSaveConfig(payload map[string]interface{}) error {
	path := ConfigPath()
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	old, err := LoadConfig(path)
	if err != nil {
		// 旧文件损坏时允许用本次保存覆盖修复；目录不可写会在 SaveConfig 报错
		old = DefaultConfig()
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var next Config
	if err := json.Unmarshal(raw, &next); err != nil {
		return err
	}
	if strings.TrimSpace(next.APIKey) == "" {
		next.APIKey = old.APIKey
	}
	return SaveConfig(path, next)
}

// ClearDefaultAPIKey 清空服务提供商 API Key（其余配置保留）。
func ClearDefaultAPIKey() error {
	path := ConfigPath()
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		return err
	}
	cfg.APIKey = ""
	return SaveConfig(path, cfg)
}
