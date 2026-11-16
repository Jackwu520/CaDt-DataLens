package main

// envvars_app.go：环境变量配置的 Wails 绑定——引擎在 internal/envvars，
// 这里只转发并注入应用数据目录。

import "datalens/internal/envvars"

func init() {
	envvars.AppDataDir = appDataRoot
}

func (a *App) GetEnvVars() (*envvars.EnvVarSnapshot, error) {
	return envvars.Get()
}

func (a *App) SetEnvVars(inputs []envvars.EnvVarInput) error {
	return envvars.Set(inputs)
}

func (a *App) SetEnvVarEncrypted(on bool) error {
	return envvars.SetEncrypted(on)
}
