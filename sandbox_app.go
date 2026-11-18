package main

import "datalens/internal/sandbox"

// AI 子代理沙箱授权的检查与清理（docs/finished-plans/subagent-sandbox.md §4 阶段 D）。
//
// workspace-write 会在写根目录上留下三样东西：能力 SID 的 allow ACE、Everyone 的
// FILE_DELETE_CHILD deny、Low 完整性标签。前两者跨会话复用（standing），标签更是永久的；
// `icacls` 撤不掉（S-1-4-x-y 是派生 SID，解析失败报 1332），所以清理只能走这里。
//
// 只为「用户想还原目录权限」而设：日常使用不必清理，授权是复用缓存。

// SandboxScan 报告某个工作区目录上残留的沙箱授权痕迹（只读）。
func (a *App) SandboxScan(root string) (*sandbox.GrantState, error) {
	return sandbox.Scan(root)
}

// SandboxRevoke 清掉某个工作区目录上的沙箱授权痕迹（能力 ACE、ambient-delete deny、
// 无其它能力授权时的 Low 标签）。只删「完全匹配本应用签名」的条目，其余 ACE 原样保留。
func (a *App) SandboxRevoke(root string) (*sandbox.GrantState, error) {
	return sandbox.Revoke(root)
}
