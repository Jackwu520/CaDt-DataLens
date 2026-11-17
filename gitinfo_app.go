package main

// gitinfo_app.go：Git 浅集成的 Wails 绑定——引擎在 internal/gitinfo，这里只转发。

import "datalens/internal/gitinfo"

func (a *App) GitStatusFor(dir string) (*gitinfo.GitTreeStatus, error) {
	return gitinfo.StatusFor(dir)
}

func (a *App) GitBranchesFor(dir string, includeRemote bool) (*gitinfo.GitBranchesResult, error) {
	return gitinfo.BranchesFor(dir, includeRemote)
}

func (a *App) GitCheckoutBranch(dir string, name string, remote bool) (*gitinfo.GitOperationResult, error) {
	return gitinfo.CheckoutBranch(dir, name, remote)
}

func (a *App) GitCreateBranch(dir string, name string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.CreateBranch(dir, name)
}

func (a *App) GitCheckoutRefFor(dir string, ref string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.CheckoutRef(dir, ref)
}

func (a *App) GitPullFor(dir string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.Pull(dir)
}

func (a *App) GitPushFor(dir string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.Push(dir)
}

func (a *App) GitFetchFor(dir string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.Fetch(dir)
}

func (a *App) GitCloneRepository(url string, target string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.CloneRepository(url, target)
}

func (a *App) GitCommitChanges(dir string, message string, paths []string, amend bool, push bool) (*gitinfo.GitCommitResult, error) {
	return gitinfo.CommitChanges(dir, message, paths, amend, push)
}

func (a *App) GitRollbackFor(dir string, paths []string, untracked []string) error {
	return gitinfo.RollbackFor(dir, paths, untracked)
}

func (a *App) GitFileHistoryFor(dir string, path string, limit int) (string, error) {
	return gitinfo.FileHistoryFor(dir, path, limit)
}

func (a *App) GitRecentLogFor(dir string, limit int) (string, error) {
	return gitinfo.RecentLogFor(dir, limit)
}

func (a *App) GitDiffFor(dir string, path string) (*gitinfo.GitDiffResult, error) {
	return gitinfo.DiffFor(dir, path)
}

func (a *App) GitLineMarksFor(dir string, path string, content string) (*gitinfo.GitLineMarks, error) {
	return gitinfo.LineMarksFor(dir, path, content)
}

// ===== AI 隔离 worktree（引擎在 internal/gitinfo/worktree.go；回灌审批仍走 patch 壳与前端） =====

func (a *App) GitWorktreeList(dir string) (*gitinfo.GitWorktreeListResult, error) {
	return gitinfo.WorktreeList(dir)
}

func (a *App) GitWorktreeAdd(dir, label, sessionKey string, carry bool) (*gitinfo.GitWorktreeAddResult, error) {
	return gitinfo.WorktreeAdd(dir, label, sessionKey, carry)
}

func (a *App) GitWorktreeRemove(dir, name string, deleteBranch bool) error {
	return gitinfo.WorktreeRemove(dir, name, deleteBranch)
}

func (a *App) GitWorktreePrune(dir string) error {
	return gitinfo.WorktreePrune(dir)
}

func (a *App) GitWorktreeDiff(dir, name, baseSha string) (string, error) {
	return gitinfo.WorktreeDiff(dir, name, baseSha)
}

func (a *App) GitWorktreeStat(dir, name, baseSha string) (string, error) {
	return gitinfo.WorktreeStat(dir, name, baseSha)
}

// ===== Git 图谱（引擎在 internal/gitinfo/graph.go；泳道在 Go 侧算好，前端只渲染） =====

func (a *App) GitGraphCommits(dir, ref string, limit, skip int) (*gitinfo.GitGraphPage, error) {
	return gitinfo.GraphCommits(dir, ref, limit, skip)
}

func (a *App) GitGraphRefs(dir string) (*gitinfo.GitGraphRefsResult, error) {
	return gitinfo.GraphRefs(dir)
}

func (a *App) GitGraphCheckout(dir, ref string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.GraphCheckout(dir, ref)
}

func (a *App) GitGraphReset(dir, sha, mode string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.GraphReset(dir, sha, mode)
}

func (a *App) GitGraphCherryPick(dir, sha string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.GraphCherryPick(dir, sha)
}
