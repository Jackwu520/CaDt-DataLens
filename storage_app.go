package main

// storage_app.go：设置页「存储与清理」的 Wails 壳。
//
// 引擎在 internal/storage（条目表、体积统计、清除与待清理标记），这里只做三件事：
// 把宿主知道的位置与删除动作注进去、暴露两个绑定方法、在 WebView2 起来之前执行待清理项。

import (
	"os"
	"path/filepath"

	"datalens/internal/activity"
	"datalens/internal/aicatalog"
	"datalens/internal/aiconfig"
	"datalens/internal/aischedule"
	"datalens/internal/browser"
	"datalens/internal/debugconsole"
	"datalens/internal/envvars"
	"datalens/internal/mcp"
	"datalens/internal/run"
	"datalens/internal/sessionindex"
	"datalens/internal/sessionstore"
	"datalens/internal/storage"
)

var storageService = storage.New(storage.Deps{
	Location:              storageLocation,
	RemoveToRecycleBin:    deleteEntry,
	ActiveBrowserProfiles: browser.ActiveProfileDirs,
	BeforeClear: map[string]func(){
		// 派生 SQLite 打开状态下删不掉，清除前先释放本进程句柄
		"session-index": sessionindex.ResetFiles,
		"ai-schedule":   aischedule.Close,
	},
})

// storageLocation 报告应用真正写数据的位置。已有构造函数的全部复用，
// 免得目录名在写入端与清理端各写一遍、改一处就清错地方。
func storageLocation(name string) string {
	switch name {
	case storage.LocAppRoot:
		return appDataRoot()
	case storage.LocScratchDir:
		return os.TempDir()
	case storage.LocWebview:
		return webviewDataPath()
	case storage.LocBrowserProfiles:
		return appDataChild(browser.ProfileRoot)
	case storage.LocRunTemp:
		return run.RunTempRoot()
	case storage.LocAppLogs:
		return appLogsDir()
	case storage.LocDebugConsole:
		return debugconsole.Path()
	case storage.LocSessionIndex:
		return sessionindex.Path()
	case storage.LocScheduleDB:
		return aischedule.Path()
	case storage.LocModelCatalog:
		return aicatalog.Path()
	case storage.LocActivity:
		return activity.Dir()
	case storage.LocAISessions:
		return appDataChild(sessionstore.SessionsDirName)
	case storage.LocConfig:
		return configFilePath()
	case storage.LocAIConfig:
		return aiconfig.Path()
	case storage.LocMCPConfig:
		return mcp.ConfigFilePath()
	case storage.LocEnvVars:
		return envvars.Path()
	}
	return ""
}

// appDataChild 应用数据根下的子项；根目录定位不到时返回空串，
// 不能退化成相对路径（那样会去删当前工作目录下的同名目录）。
func appDataChild(name string) string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, name)
}

// StorageScan 统计存储占用；workspaceRoot 传当前工作区根，空串时工作区条目按不存在处理。
func (a *App) StorageScan(workspaceRoot string) (storage.Report, error) {
	return storageService.Scan(workspaceRoot), nil
}

// StorageClear 按条目 id 清除：缓存直删，数据送回收站，WebView2 两项排到下次启动前。
func (a *App) StorageClear(ids []string, workspaceRoot string) (storage.ClearReport, error) {
	return storageService.Clear(ids, workspaceRoot), nil
}

// applyPendingStorageCleanup 在 wails.Run 创建 WebView2 之前执行上次排下的清理。
// 多窗口时另一个进程可能还占着配置目录，那种情况保留标记，下次启动再试。
func applyPendingStorageCleanup() {
	for _, result := range storageService.ApplyPending() {
		if result.Reason != "" {
			writeAppLog("warn", "启动前清理未完成：%s（剩余 %d 项，%v）", result.Label, result.Remaining, result.Reason)
			continue
		}
		writeAppLog("info", "启动前清理完成：%s，释放 %d 字节", result.Label, result.Freed)
	}
}
