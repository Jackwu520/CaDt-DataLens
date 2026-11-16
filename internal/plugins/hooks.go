package plugins

// 宿主注入（main 包的根壳在 init 中接线）。

// Logf 诊断日志（main/logging.go 的 writeAppLog）。
var Logf func(level, format string, args ...any)

// 配置文件访问：只暴露插件/市场相关的窄字段，避免引擎依赖根 AppConfig。
var (
	// PluginsPathMode 返回插件目录模式（portable / appdata）。
	PluginsPathMode func() string
	// SavePluginsPathMode 持久化插件目录模式。
	SavePluginsPathMode func(mode string) error
	// DisabledPlugins 返回被禁用的插件 id 列表。
	DisabledPlugins func() []string
	// SaveDisabledPlugins 持久化禁用列表。
	SaveDisabledPlugins func(ids []string) error
	// MarketSource 返回市场数据源（gitee / github）。
	MarketSource func() string
	// SaveMarketSource 持久化市场数据源。
	SaveMarketSource func(source string) error
)

func logf(level, format string, args ...any) {
	if Logf != nil {
		Logf(level, format, args...)
	}
}

func currentPathMode() string {
	if PluginsPathMode == nil {
		return "portable"
	}
	return PluginsPathMode()
}

func disabledPluginList() []string {
	if DisabledPlugins == nil {
		return nil
	}
	return DisabledPlugins()
}

func savePathMode(mode string) error {
	if SavePluginsPathMode == nil {
		return nil
	}
	return SavePluginsPathMode(mode)
}

func saveDisabledPlugins(ids []string) error {
	if SaveDisabledPlugins == nil {
		return nil
	}
	return SaveDisabledPlugins(ids)
}

func currentMarketSource() string {
	if MarketSource == nil {
		return marketSourceGitee
	}
	return normalizeMarketSource(MarketSource())
}

func saveMarketSource(source string) error {
	if SaveMarketSource == nil {
		return nil
	}
	return SaveMarketSource(normalizeMarketSource(source))
}
