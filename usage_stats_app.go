package main

// usage_stats_app.go：AI 使用统计（internal/usagestats）的 Wails 绑定。
// 事实库是派生 SQLite（ai-usage.db，可随时删除重建）；前端流结束静默上报，
// 后台带游标增量回填会话 JSONL，查询只读库——打开面板不扫文件。

import "datalens/internal/usagestats"

func init() {
	usagestats.Logf = writeAppLog
}

// AIUsageStatsRecord 静默上报一条用量事实（幂等；失败返回错误文本，前端忽略）。
func (a *App) AIUsageStatsRecord(payloadJSON string) string {
	if err := usagestats.Record(payloadJSON); err != nil {
		// 前端静默消费返回值：写失败的诊断信息必须落在运行日志里，否则永久静默
		writeAppLog("warn", "AI 使用统计上报失败：%v", err)
		return err.Error()
	}
	return ""
}

// AIUsageStatsSnapshot 读取统计快照（rangeKey: 7d/30d；summary 与热力图始终全历史）。
func (a *App) AIUsageStatsSnapshot(rangeKey string) usagestats.Snapshot {
	snap, err := usagestats.LoadSnapshot(rangeKey)
	if err != nil {
		snap.Range = rangeKey
		snap.Error = err.Error()
	}
	return snap
}

// AIUsageStatsRequests 按时间倒序分页读取请求日志（只读库，不触发扫描）。
func (a *App) AIUsageStatsRequests(offset, limit int) usagestats.RequestPage {
	page, err := usagestats.LoadRequests(offset, limit)
	if err != nil {
		page.Error = err.Error()
	}
	return page
}

// AIUsageStatsSync 手动触发增量同步（刷新按钮），返回错误文本（空 = 成功）。
func (a *App) AIUsageStatsSync() string {
	if err := usagestats.SyncAll(); err != nil {
		return err.Error()
	}
	return ""
}
