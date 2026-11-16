package main

// plugins_app.go：插件引擎（internal/plugins）的宿主接线与对话框壳。

import (
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"datalens/internal/plugins"
)

func init() {
	plugins.Logf = writeAppLog
	plugins.PluginsPathMode = func() string { return readAppConfig().PluginsPathMode }
	plugins.SavePluginsPathMode = func(mode string) error {
		cfg := readAppConfig()
		cfg.PluginsPathMode = mode
		return saveAppConfig(cfg)
	}
	plugins.DisabledPlugins = func() []string { return readAppConfig().DisabledPlugins }
	plugins.SaveDisabledPlugins = func(ids []string) error {
		cfg := readAppConfig()
		cfg.DisabledPlugins = ids
		return saveAppConfig(cfg)
	}
	plugins.MarketSource = func() string { return readAppConfig().DataSource }
	plugins.SaveMarketSource = func(source string) error {
		cfg := readAppConfig()
		cfg.DataSource = source
		return saveAppConfig(cfg)
	}
}

// OpenPluginsDir 确保插件目录存在后在资源管理器中打开它。
func (a *App) OpenPluginsDir() error {
	dir, err := a.Manager.EnsureDir()
	if err != nil {
		return err
	}
	return a.ShowInFolder(dir)
}

// AddPluginFromFolder 选择本地插件文件夹并安装。
func (a *App) AddPluginFromFolder() (*plugins.PluginInfo, error) {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择插件文件夹（内含 plugin.json）",
	})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return nil, nil // 用户取消
	}
	return plugins.InstallFromFolder(dir)
}

// ImportPluginFromZip 选择插件包并逐个导入。
func (a *App) ImportPluginFromZip() (*plugins.PluginInfo, error) {
	paths, err := runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "导入插件包",
		Filters: []runtime.FileFilter{
			{DisplayName: "插件包 (*.zip)", Pattern: "*.zip"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, nil // 用户取消
	}
	return plugins.ImportZipPaths(paths)
}
