package main

// webtools_config.go：外部工具配置的 Wails 绑定壳——路径、合并与掩码逻辑在 internal/webtools。

import "datalens/internal/webtools"

// WebToolsConfigGet 返回掩码后的配置：apiKey 只报 apiKeySet，不回传明文。
func (a *App) WebToolsConfigGet() (map[string]interface{}, error) {
	cfg, err := webtools.LoadDefaultConfig()
	if err != nil {
		return nil, err
	}
	return webtools.MaskedConfig(cfg), nil
}

// WebToolsConfigSave 保存配置；apiKey 留空表示保持原值（清空走 WebToolsConfigClearKey）。
func (a *App) WebToolsConfigSave(payload map[string]interface{}) error {
	return webtools.MergeAndSaveConfig(payload)
}

// WebToolsConfigClearKey 清空服务提供商 API Key（其余配置保留）。
func (a *App) WebToolsConfigClearKey() error {
	return webtools.ClearDefaultAPIKey()
}
