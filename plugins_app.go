package main

// plugins_app.go：插件引擎（internal/plugins）的宿主接线与对话框壳。

import (
	"datalens/internal/appconfig"
	"datalens/internal/plugins"
)

func init() {
	plugins.Logf = writeAppLog
	plugins.PluginsPathMode = func() string { return appconfig.Read().PluginsPathMode }
	plugins.SavePluginsPathMode = func(mode string) error {
		cfg := appconfig.Read()
		cfg.PluginsPathMode = mode
		return appconfig.Save(cfg)
	}
	plugins.DisabledPlugins = func() []string { return appconfig.Read().DisabledPlugins }
	plugins.SaveDisabledPlugins = func(ids []string) error {
		cfg := appconfig.Read()
		cfg.DisabledPlugins = ids
		return appconfig.Save(cfg)
	}
	plugins.MarketSource = func() string { return appconfig.Read().DataSource }
	plugins.SaveMarketSource = func(source string) error {
		cfg := appconfig.Read()
		cfg.DataSource = source
		return appconfig.Save(cfg)
	}
}

// OpenPluginsDir 确保插件目录存在后在资源管理器中打开它。
func (a *App) OpenPluginsDir() error {
	dir, err := plugins.EnsureDir()
	if err != nil {
		return err
	}
	return a.ShowInFolder(dir)
}

// AddPluginFromFolder 选择本地插件文件夹并安装。
func (a *App) AddPluginFromFolder() (*plugins.PluginInfo, error) {
	if wailsApp == nil {
		return nil, nil
	}
	dir, err := wailsApp.Dialog.OpenFile().
		SetTitle("选择插件文件夹（内含 plugin.json）").
		CanChooseFiles(false).
		CanChooseDirectories(true).
		PromptForSingleSelection()
	if isDialogCancelled(err) {
		return nil, nil
	}
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
	if wailsApp == nil {
		return nil, nil
	}
	paths, err := wailsApp.Dialog.OpenFile().
		SetTitle("导入插件包").
		AddFilter("插件包 (*.zip)", "*.zip").
		AddFilter("所有文件 (*.*)", "*.*").
		PromptForMultipleSelection()
	if isDialogCancelled(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, nil // 用户取消
	}
	return plugins.ImportZipPaths(paths)
}
