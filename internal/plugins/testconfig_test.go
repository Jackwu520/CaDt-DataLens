package plugins

// 测试环境用内存配置替换根 AppConfig 钩子。

var testCfg struct {
	pathMode string
	disabled []string
	source   string
}

func init() {
	Logf = func(string, string, ...any) {}
	PluginsPathMode = func() string {
		if testCfg.pathMode == "" {
			return "portable"
		}
		return testCfg.pathMode
	}
	SavePluginsPathMode = func(mode string) error {
		testCfg.pathMode = mode
		return nil
	}
	DisabledPlugins = func() []string {
		return append([]string(nil), testCfg.disabled...)
	}
	SaveDisabledPlugins = func(ids []string) error {
		testCfg.disabled = append([]string(nil), ids...)
		return nil
	}
	MarketSource = func() string {
		if testCfg.source == "" {
			return MarketSourceGitee
		}
		return testCfg.source
	}
	SaveMarketSource = func(source string) error {
		testCfg.source = NormalizeMarketSource(source)
		return nil
	}
}

func resetTestConfig() {
	testCfg.pathMode = "portable"
	testCfg.disabled = nil
	testCfg.source = MarketSourceGitee
}
