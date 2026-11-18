// Package appdata 统一应用数据目录（%APPDATA%\CandySweet\CaDt-DataLens）。
//
// 只负责拼路径，不创建目录、不读配置；需要目录时由调用方 MkdirAll。
// 应用数据目录对 AI 助手是硬禁区，读取方一律经这里拿根，
// 不要在别处硬编码厂商名与产品名。
package appdata

import (
	"os"
	"path/filepath"
)

const (
	vendorDir = "CandySweet"
	appDir    = "CaDt-DataLens"
)

// RootAt 在给定系统配置目录下拼出应用数据根；configDir 为空时返回空。
func RootAt(configDir string) string {
	if configDir == "" {
		return ""
	}
	return filepath.Join(configDir, vendorDir, appDir)
}

// Root 返回当前用户的应用数据根；系统配置目录不可用时返回空。
func Root() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return RootAt(dir)
}
