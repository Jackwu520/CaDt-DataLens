package main

// logging.go：日志引擎（internal/applog）的绑定壳与跨包 Logf 入口。

import (
	"fmt"
	"os"
	"strings"

	"datalens/internal/appconfig"
	"datalens/internal/appdata"
	"datalens/internal/applog"
)

// writeAppLog 供各 internal 包的 Logf 钩子直接引用。
var writeAppLog = applog.Write

// LogFrontend 接收前端日志；错误与警告始终记录，info/debug 仅在开发者模式下记录。
func (a *App) LogFrontend(level, message string) {
	tag := strings.ToLower(strings.TrimSpace(level))
	switch tag {
	case "error", "warn", "info", "debug":
	case "warning":
		tag = "warn"
	default:
		tag = "info"
	}
	if (tag == "info" || tag == "debug") && !applog.DevMode() {
		return
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return
	}
	writeAppLog(tag, "%s", message)
}

func (a *App) GetDeveloperMode() bool {
	return applog.DevMode()
}

func (a *App) SetDeveloperMode(enabled bool) error {
	cfg := appconfig.Read()
	cfg.DeveloperMode = enabled
	if err := appconfig.Save(cfg); err != nil {
		return err
	}
	applog.SetDevMode(enabled)
	writeAppLog("info", "开发者模式：%s", applog.OnOff(enabled))
	return nil
}

func (a *App) GetLogPath() string {
	return applog.FilePath()
}

func (a *App) OpenLogDir() error {
	dir := applog.Dir()
	if dir == "" {
		return appdata.ErrNoRoot
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("无法创建日志目录：%w", err)
	}
	return a.ShowInFolder(dir)
}
