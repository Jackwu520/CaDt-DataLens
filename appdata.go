package main

import (
	"os"
	"path/filepath"

	"datalens/internal/appdata"
)

// 应用数据统一存放在 %APPDATA%\CandySweet\CaDt-DataLens 下：
//
//	config.json  后端配置（打开方式、插件目录模式、禁用插件）
//	WebView2\    WebView2 用户数据，localStorage 里的界面设置保存在这里
//	plugins\     插件目录（设置里选择“应用数据目录”时）
//
// 路径拼装已下沉 internal/appdata；这里保留 main 包内的旧名供既有调用点使用。

func appDataRootAt(configDir string) string { return appdata.RootAt(configDir) }

func appDataRoot() string { return appdata.Root() }

func webviewDataPath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "WebView2")
}

// ensureAppDataDir 在 WebView2 启动前创建统一根目录，避免子目录创建失败。
func ensureAppDataDir() {
	root := appDataRoot()
	if root == "" {
		return
	}
	_ = os.MkdirAll(root, 0o755)
}
