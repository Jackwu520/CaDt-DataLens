// wipeguard_app.go：工作区破坏防护的 Wails 薄包装（docs/finished-plans/workspace-wipe-guard.md）。
//
// 引擎在 internal/wipeguard；这里注入依赖（应用数据根 / 日志 / patch 写前备份钩子 / 存储清理门闩）
// 并以 WipeGuard* 前缀挂绑定。wipe-guard 不进 AI 工具体系：全部由应用自身调用，不暴露给模型。
package main

import (
	"fmt"

	"datalens/internal/patch"
	"datalens/internal/wipeguard"
)

// wipeGuardService 包级服务（对齐 memo.SetDeps / storageService 先例）。
// 备份根由引擎内部解析：设置里的 backupRoot 优先（校验见方案 §4.1），默认 <应用数据>/wipe-guard。
var wipeGuardService = wipeguard.New(wipeguard.Deps{Root: appDataRoot, Logf: writeAppLog})

func init() {
	// 补丁两阶段写入的备份点（patch_write.go）已把原字节读进内存，顺手持久化成
	// 可跨会话恢复的备份；patch 引擎不 import main，走包级钩子（对齐 patch.AppDataDir 惯例）。
	patch.OnWriteBackup = func(root, rel, abs string, content []byte) {
		_ = wipeGuardService.Store(root, rel, abs, content)
	}
}

// WipeGuardConfigure 应用设置开关（设置 → 存储与清理；前端在启动与设置变更时调用）。
func (a *App) WipeGuardConfigure(settings wipeguard.Settings) { wipeGuardService.Configure(settings) }

// WipeGuardFingerprint 取工作区结构指纹（run_command / background_command 前后保底 +
// 周期校准；主信号是前端消费 workspace-changed 的滚动删除计数）。
func (a *App) WipeGuardFingerprint(ws string) wipeguard.Fingerprint { return wipeguard.Take(ws) }

// WipeGuardCompare 指纹对比判定（前端兜底校准调用；阈值单一来源在 Go，前端不复制）。
func (a *App) WipeGuardCompare(before, after wipeguard.Fingerprint) wipeguard.Verdict {
	return wipeguard.Compare(before, after)
}


// WipeGuardAlarm 告警落运行日志；状态栏 / 停会话 / 熔断在前端做，留痕走前端 activity-log。
func (a *App) WipeGuardAlarm(level, reason, detail string) {
	if level == "" {
		return
	}
	line := fmt.Sprintf("告警[%s] %s", level, reason)
	if detail != "" {
		line += "：" + detail
	}
	logLevel := "warn"
	if level == "critical" {
		logLevel = "error"
	}
	writeAppLog(logLevel, "wipe-guard: %s", line)
}

// WipeGuardBackup 写前快照（write_file / edit_file 落盘前调用；失败不阻断写入）。
func (a *App) WipeGuardBackup(call wipeguard.BackupCall) (wipeguard.BackupResult, error) {
	return wipeGuardService.Backup(call)
}

// WipeGuardList 备份记录（按工作区过滤；前端按文件分组渲染时间线）。
func (a *App) WipeGuardList(ws string) ([]wipeguard.IndexRow, error) { return wipeGuardService.List(ws) }

// WipeGuardRestore 还原一条备份到工作区（用户手动 + danger 确认；路径越界拒绝）。
func (a *App) WipeGuardRestore(entryID, ws string) (string, error) {
	return wipeGuardService.Restore(entryID, ws)
}

// WipeGuardClear 清空整个备份根（存储清理条目与手动入口共用）。
func (a *App) WipeGuardClear() error { return wipeGuardService.ClearAll() }

// WipeGuardStatus 当前工作区的快照层派生形态（git / cas / preimage + 理由）。
func (a *App) WipeGuardStatus(ws string) wipeguard.ModeInfo { return wipeGuardService.Mode(ws) }

// WipeGuardSnapshot 做一次定期状态快照（前端 10 分钟一拍；开关关闭返回 skipped）。
func (a *App) WipeGuardSnapshot(ws string) (wipeguard.SnapshotResult, error) {
	return wipeGuardService.Snapshot(ws)
}

// WipeGuardSnapshotList 快照清单（tar / manifest）。
func (a *App) WipeGuardSnapshotList(ws string) ([]wipeguard.SnapshotEntry, error) {
	return wipeGuardService.SnapshotList(ws)
}

// WipeGuardSnapshotRestore 还原一份快照（tar 解包 / manifest 重组；用户手动）。
func (a *App) WipeGuardSnapshotRestore(ws, name string) (string, error) {
	return wipeGuardService.SnapshotRestore(ws, name)
}
