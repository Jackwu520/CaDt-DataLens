// crashrecovery_app.go：崩溃自愈的壳接线（crashrecovery 包只做检测，清理动作在这里）。
//
// 上次 GUI 会话异常退出（panic / 强杀 / 断电）时 session-alive 标记会遗留；本次启动取走
// 标记，自动执行一轮「清除缓存」，把崩溃残留的脏状态在用户碰到之前收掉。起因：
// 2026-11-23 全局搜索 panic 闪退，触发文件就躺在工作区 .cadt/tmp 里、下次一搜再崩，
// 见 docs/reports/incident-2026-11-23-search-panic-crash.md。
//
// 分两段执行（app 段此刻工作区根还不知道，工作区段等登记）：
//   - app 段：启动空档直清（run-temp / session-index / ai-logs 等）；webview-cache 被进程
//     锁不住的这个空档由 Clear 转 pending、紧跟着的 ApplyPending 本轮就执行掉；
//   - 工作区段（ws-worklog / ws-tmp）：WindowRegister 登记根目录后清，幂等去重。
//
// 标记本体在 main.go 写/摘（仅 GUI 实例；转发进程与 headless 模式不参与）。
package main

import (
	"path/filepath"
	"sync"
	"sync/atomic"

	"datalens/internal/crashrecovery"
)

// crashCleanPending 本轮会话仍有待清的工作区段（取到遗留标记后置位）。
var crashCleanPending atomic.Bool

// crashCleanedRoots 已清过的工作区根：WindowRegister 可能对同一根重复触发，去重免刷屏。
var crashCleanedRoots sync.Map

// runCrashRecoveryAtStartup 执行崩溃自愈的 app 段。必须在 application.New 之后调用：
// 转发场景会在 New 里 os.Exit，绝不能让转发进程抢走遗留标记去清理——运行中的主实例
// 还占着这些缓存（session-index 的派生库、ai-logs 等）。
func runCrashRecoveryAtStartup() {
	marker, crashed := crashrecovery.TakeAbandoned()
	if !crashed {
		return
	}
	writeAppLog("warn", "检测到上次会话异常退出（mode=%s pid=%d 启动于 %s，日志 %s），执行崩溃自愈清理",
		marker.Mode, marker.PID, marker.StartedAt, marker.Log)
	report := storageService.Clear(storageService.CacheIDs(), "")
	for _, r := range report.Results {
		// 工作区段（根为空）与转 pending 的 webview 段在这里是 no-op / 排期，不算失败
		if r.Reason != "" {
			writeAppLog("warn", "崩溃自愈：%s 未完成（%s）", r.Label, r.Reason)
		}
	}
	writeAppLog("info", "崩溃自愈：缓存清理完成，释放 %d 字节（成功 %d 项，转下次启动 %d 项）",
		report.Freed, report.Succeeded, len(report.Scheduled))
	if len(report.Failed) > 0 {
		writeAppLog("warn", "崩溃自愈：部分条目失败 %v，可到设置 → 存储与清理手动处理", report.Failed)
	}
	crashCleanPending.Store(true)
}

// runCrashWorkspaceRecovery 崩溃自愈的工作区段：工作区登记时清 ws-worklog / ws-tmp。
// 只清一次（按根去重），同一会话里后来打开的其他工作区各自清各自的。
func runCrashWorkspaceRecovery(workspace string) {
	if !crashCleanPending.Load() || workspace == "" {
		return
	}
	key := filepath.Clean(workspace)
	if _, loaded := crashCleanedRoots.LoadOrStore(key, true); loaded {
		return
	}
	report := storageService.Clear(storageService.WorkspaceCacheIDs(), workspace)
	writeAppLog("info", "崩溃自愈：工作区缓存清理完成（%s），释放 %d 字节", filepath.Base(workspace), report.Freed)
}
