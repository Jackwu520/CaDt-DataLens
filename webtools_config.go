package main

// webtools_config.go：外部工具配置的 Wails 绑定与文件位置。
// 引擎（结构、校验、DeepSeek 适配）在 internal/webtools，这里只做路径与 key 掩码处理。

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"datalens/internal/webtools"
)

func externalToolsConfigPath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "external-tools.json")
}

func loadExternalToolsConfig() (webtools.Config, error) {
	path := externalToolsConfigPath()
	if path == "" {
		return webtools.Config{}, errors.New("无法定位应用数据目录")
	}
	return webtools.LoadConfig(path)
}

// WebToolsConfigGet 返回掩码后的配置：apiKey 只报 apiKeySet，不回传明文。
func (a *App) WebToolsConfigGet() (map[string]interface{}, error) {
	cfg, err := loadExternalToolsConfig()
	if err != nil {
		return nil, err
	}
	return webtools.MaskedConfig(cfg), nil
}

// WebToolsConfigSave 保存配置；apiKey 留空表示保持原值（清空走 WebToolsConfigClearKey）。
func (a *App) WebToolsConfigSave(payload map[string]interface{}) error {
	path := externalToolsConfigPath()
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	old, err := loadExternalToolsConfig()
	if err != nil {
		// 旧文件损坏时允许用本次保存覆盖修复；目录不可写会在 SaveConfig 报错
		old = webtools.DefaultConfig()
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var next webtools.Config
	if err := json.Unmarshal(raw, &next); err != nil {
		return err
	}
	if strings.TrimSpace(next.APIKey) == "" {
		next.APIKey = old.APIKey
	}
	return webtools.SaveConfig(path, next)
}

// WebToolsConfigClearKey 清空服务提供商 API Key（其余配置保留）。
func (a *App) WebToolsConfigClearKey() error {
	path := externalToolsConfigPath()
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	cfg, err := loadExternalToolsConfig()
	if err != nil {
		return err
	}
	cfg.APIKey = ""
	return webtools.SaveConfig(path, cfg)
}
