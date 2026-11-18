package main

// appservices_app.go：插件后台服务引擎（internal/appservices）的宿主接线与 Wails 绑定壳。
// 引擎只负责声明服务的启停/健康/日志，声明本身由前端插件在加载完成后 Sync 推送。

import (
	"datalens/internal/appservices"
)

func init() {
	appservices.Logf = writeAppLog
}

// AppServiceSync 用当前插件声明覆盖服务注册表：不再声明的服务停止并移除，
// spec 变化的服务重启，autoStart 的服务拉起。前端每次 loadPlugins 后调用。
func (a *App) AppServiceSync(specs []appservices.Spec) error {
	return a.AppServices.Sync(specs)
}

// AppServiceStart 手动启动一个服务。
func (a *App) AppServiceStart(id string) error {
	return a.AppServices.Start(id)
}

// AppServiceStop 手动停止一个服务。
func (a *App) AppServiceStop(id string) error {
	return a.AppServices.Stop(id)
}

// AppServiceStatus 查询单个服务状态。
func (a *App) AppServiceStatus(id string) (appservices.Status, error) {
	st, ok := a.AppServices.Status(id)
	if !ok {
		return appservices.Status{}, nil
	}
	return st, nil
}

// AppServiceList 列出所有服务的状态。
func (a *App) AppServiceList() []appservices.Status {
	return a.AppServices.List()
}

// AppServiceLogs 返回服务日志行。
func (a *App) AppServiceLogs(id string) []string {
	return a.AppServices.Logs(id)
}
