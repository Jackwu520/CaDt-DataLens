// Package appdata 统一应用数据目录（%APPDATA%\CandySweet\CaDt-DataLens）。
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