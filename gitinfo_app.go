package main

// gitinfo_app.go：Git 浅集成的 Wails 绑定——引擎在 internal/gitinfo，这里只转发。

import (
	"datalens/internal/gitinfo"
	"datalens/internal/watch"
)

func init() {
	// 切换/检出分支、丢弃改动、清理这类 git 操作会成批删除工作树文件（切走的那个分支
	// 独有的文件），对 watcher 而言与「大范围文件消失」无异——由发起方声明静默，
	// 不做启发式猜测（2026-11-19 举一反三排查工作区防护误报）。
	gitinfo.OnMutateWorktree = func() func() {
		watch.BeginQuiet()
		return watch.EndQuiet
	}
}


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

// GitWorktreeMergePreview export 的零副作用三方合并预检（L1 dry-run；快照/merge-tree/报告
// 落盘都在引擎内）。Supported=false 时前端降级走 PatchPreviewText/PatchSave 兜底链路。
func (a *App) GitWorktreeMergePreview(dir, name, baseSha string) (*gitinfo.GitWorktreeMergePreviewResult, error) {
	return gitinfo.WorktreeMergePreview(dir, name, baseSha)
}

// GitPatchID diff 文本的稳定指纹（L0 已应用识别的第一层，stdin 喂给 git patch-id --stable）。
func (a *App) GitPatchID(diffText string) (string, error) {
	return gitinfo.PatchID(diffText)
}

// GitWorktreeMergeApply 审批通过后的应用换轨（S2）：按三方合并结果把选中文件写回主根
// 工作区。与预检共用同一引擎（runMergeCore），应用瞬间重新跑合并保证一致性；不碰 index。
func (a *App) GitWorktreeMergeApply(dir, name, baseSha string, paths []string) (*gitinfo.GitWorktreeMergeApplyResult, error) {
	return gitinfo.WorktreeMergeApply(dir, name, baseSha, paths)
}

// GitWorktreeSnapshotPatch discard 保底快照（S3）：隔离区当前 diff 原样落盘 .cadt/patches/，
// 绕开 PatchSave 的「不可应用即删」；无改动返回 ErrWorktreeNoChanges。
func (a *App) GitWorktreeSnapshotPatch(dir, name, baseSha string) (string, error) {
	return gitinfo.WorktreeSnapshotPatch(dir, name, baseSha)
}

// GitWorktreeDiffSinceBase 主根相对基准的单文件 diff（S3 conflict_detail 按需通道，行数封顶）。
func (a *App) GitWorktreeDiffSinceBase(dir, baseSha, path string, maxLines int) (string, error) {
	return gitinfo.WorktreeDiffSinceBase(dir, baseSha, path, maxLines)
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

func (a *App) GitGraphCreateBranch(dir, name, sha string, checkout bool) (*gitinfo.GitOperationResult, error) {
	return gitinfo.GraphCreateBranch(dir, name, sha, checkout)
}

func (a *App) GitGraphCheckoutForce(dir, ref string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.GraphCheckoutForce(dir, ref)
}

func (a *App) GitGraphCheckoutSmart(dir, ref string) (*gitinfo.GitOperationResult, error) {
	return gitinfo.GraphCheckoutSmart(dir, ref)
}

func (a *App) GitGraphCommitFiles(dir, sha string) ([]gitinfo.GitGraphFileChange, error) {
	return gitinfo.GraphCommitFiles(dir, sha)
}

func (a *App) GitGraphCommitBody(dir, sha string) (string, error) {
	return gitinfo.GraphCommitBody(dir, sha)
}
