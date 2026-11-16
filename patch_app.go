package main

// 补丁能力的 Wails 导出层：只做参数整理、根目录解析与副作用分发，
// 真正的解析/匹配/写入在 internal/patch 的自由函数里，CLI 与界面共用同一套实现。

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/patch"
)

// 宿主注入：补丁库的 appdata 兜底目录与诊断日志都来自 main 包（appdata.go / logging.go）。
func init() {
	patch.AppDataDir = appDataRoot
	patch.Logf = writeAppLog
}

// PatchSave 落盘补丁并返回首次预览。
func (a *App) PatchSave(root, summary, text string) (*patch.PatchPreview, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, patch.NewPatchError(patch.PatchErrEmpty, "补丁内容为空")
	}
	if len(text) > patch.PatchMaxTextBytes {
		return nil, patch.NewPatchError(patch.PatchErrLimit, "补丁超过 2 MB，请拆分成多个补丁")
	}
	doc, err := patch.ParsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patch.PatchStoreRoot(root)
	if store == "" {
		return nil, patch.NewPatchError(patch.PatchErrNoBackup, "无法确定补丁存储目录")
	}
	if err := os.MkdirAll(store, 0o755); err != nil {
		return nil, &patch.PatchError{Code: patch.PatchErrNoBackup, Msg: "无法创建补丁目录", Detail: err.Error()}
	}
	body := patch.NormalizePatchBody(text)
	// 内容复用：同一 root 下已有内容完全相同的补丁时直接复用，不再新建文件。
	// 以前每次重试（预检冲突后重写 hunk）都落一份新 .patch，3 次重试就是 4 个重复补丁。
	if old := patch.FindPatchBySHA(store, root, patch.PatchTextSHA(body)); old != nil {
		return a.previewExistingPatch(old, root, doc)
	}
	id := patch.NewPatchRunID("")
	slug := patch.SlugifyPatchSummary(summary)
	patchPath := patch.UniquePatchPath(store, slug)
	if err := os.WriteFile(patchPath, []byte(body), 0o644); err != nil {
		return nil, &patch.PatchError{Code: patch.PatchErrApplyIO, Msg: "写入补丁文件失败", Detail: err.Error()}
	}

	plan, err := patch.BuildPatchPlan(doc, root, id, summary, patchPath, patch.PatchPlanOptions{})
	if err != nil {
		// 预检就失败的补丁不留档：刚写下的文件立刻删掉，避免失败重试堆积垃圾
		_ = os.Remove(patchPath)
		return nil, err
	}
	// 一个文件都不可应用（路径越界、hunk 全冲突、语法不支持）→ 不留档，直接把原因报回去：
	// 这类补丁重提交前必须重写，留下 .patch 只会攒垃圾
	if !patch.PlanHasApplicableFile(plan) {
		_ = os.Remove(patchPath)
		return nil, &patch.PatchError{Code: patch.PatchErrHunkConflict, Msg: "补丁没有任何文件可直接应用", Detail: patch.FirstPlanReason(plan)}
	}
	// 空补丁（+0/−0，也没有新增文件）没有任何价值，同样不落盘、不入索引
	if plan.Added == 0 && plan.Removed == 0 && !patch.PlanHasAddedFile(plan) {
		_ = os.Remove(patchPath)
		return nil, patch.NewPatchError(patch.PatchErrEmpty, "补丁没有任何改动（+0/−0）：未保存，请确认 hunk 是否写对")
	}
	// 记录基线（此刻的磁盘内容就是"生成时"的版本）
	files := map[string]string{}
	for _, f := range plan.Files {
		if f.Target != nil && f.Target.Exists && f.RelPath != "" {
			files[strings.ToLower(f.RelPath)] = f.Target.Hash
		}
	}
	patch.SaveSidecar(store, &patch.Sidecar{
		ID: id, Summary: summary, CreatedAt: time.Now().Unix(),
		PatchSHA: patch.SHA256Hex([]byte(body)), Root: root, Files: files,
	})
	_ = patch.AppendPatchIndex(store, patch.PatchIndexEntry{
		V: 1, ID: id, Summary: summary, FileName: filepath.Base(patchPath),
		CreatedAt: time.Now().Unix(), Root: root, Files: patch.FileNames(plan),
		Added: plan.Added, Removed: plan.Removed, Status: "proposed", PatchPath: patchPath,
	})
	patch.PutPatchPlan(plan)
	return plan.ToPreview(), nil
}

// previewExistingPatch 复用已存在的同内容补丁：重新预检并返回预览，不新建文件、不改索引。
// 返回的预览带 reused=true，调用方据此提示「内容与已有补丁相同，已复用」。
func (a *App) previewExistingPatch(old *patch.PatchIndexEntry, root string, doc *patch.PatchDoc) (*patch.PatchPreview, error) {
	plan, err := patch.BuildPatchPlan(doc, root, old.ID, old.Summary, old.PatchPath, patch.PatchPlanOptions{})
	if err != nil {
		return nil, err
	}
	patch.PutPatchPlan(plan)
	preview := plan.ToPreview()
	preview.Reused = true
	return preview, nil
}

// PatchPreviewFile 打开任意 .patch（外部补丁）：自动解析路径层级、带基线校验。
func (a *App) PatchPreviewFile(path, root string) (*patch.PatchPreview, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, patch.NewPatchError(patch.PatchErrBackend, "缺少补丁文件路径")
	}
	text, err := patch.ReadFileText(path, patch.PatchMaxTextBytes)
	if err != nil {
		return nil, err
	}
	doc, err := patch.ParsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patch.PatchStoreRoot(root)
	sha := patch.SHA256Hex([]byte(text))
	var opts patch.PatchPlanOptions
	opts.External = true
	summary := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if sc := patch.LoadSidecar(store, sha); sc != nil {
		opts.BaseHashes = sc.Files
		if sc.Summary != "" {
			summary = sc.Summary
		}
	}
	opts.StripLevel = -1
	plan, perr := patch.BuildPatchPlan(doc, root, "", summary, path, opts)
	if perr != nil {
		return nil, perr
	}
	// 若是本应用生成、后来被重新打开的补丁：按索引把 id 找回来，撤销才能用
	absPath, _ := filepath.Abs(path)
	for _, meta := range patch.CollectPatchMetas(store) {
		if meta.PatchPath == "" {
			continue
		}
		if cmp, _ := filepath.Abs(meta.PatchPath); strings.EqualFold(cmp, absPath) {
			plan.PatchID = meta.ID
			if meta.Summary != "" {
				plan.Summary = meta.Summary
			}
			break
		}
	}
	plan.External = plan.PatchID == ""
	patch.PutPatchPlan(plan)
	return plan.ToPreview(), nil
}

// PatchPreviewText 直接从补丁文本预览，用于虚拟 diff 文档（AI 审阅拼接 / Git 差异拼接）：
// 这类文档 path 为空、内容即补丁文本，没有盘上的补丁文件，不落盘、不写索引；
// 计划标记 External，与文件路径预览共用同一套预检/应用流（重预检走计划内的 rawText）。
func (a *App) PatchPreviewText(text, root string) (*patch.PatchPreview, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, patch.NewPatchError(patch.PatchErrEmpty, "补丁内容为空")
	}
	if len(text) > patch.PatchMaxTextBytes {
		return nil, patch.NewPatchError(patch.PatchErrLimit, "补丁超过 2 MB，请拆分成多个补丁")
	}
	doc, err := patch.ParsePatchText(text)
	if err != nil {
		return nil, err
	}
	// 与 PatchPreviewFile 同款：拼接文本的 a/ 前缀层级未知，走自动探测
	plan, perr := patch.BuildPatchPlan(doc, root, "", "审阅", "", patch.PatchPlanOptions{External: true, StripLevel: -1})
	if perr != nil {
		return nil, perr
	}
	plan.RawText = text
	patch.PutPatchPlan(plan)
	return plan.ToPreview(), nil
}

// PatchRepreview 用同一份补丁按新选项重新预检（勾选变化 / 允许位移 / 忽略空白）。
func (a *App) PatchRepreview(planID string, allowOffset, ignoreWhitespace bool) (*patch.PatchPreview, error) {
	old := patch.GetPatchPlan(planID)
	if old == nil {
		return nil, patch.NewPatchError(patch.PatchErrBackend, "预览已过期，请重新打开补丁")
	}
	// 文本补丁（虚拟 diff 文档）没有盘上文件，直接用计划里缓存的原文
	text, err := func() (string, error) {
		if old.RawText != "" {
			return old.RawText, nil
		}
		return patch.ReadFileText(old.PatchPath, patch.PatchMaxTextBytes)
	}()
	if err != nil {
		return nil, err
	}
	doc, err := patch.ParsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patch.PatchStoreRoot(old.Root)
	opts := patch.PatchPlanOptions{AllowOffset: allowOffset, IgnoreWhitespace: ignoreWhitespace, External: old.External}
	if sc := patch.LoadSidecar(store, patch.SHA256Hex([]byte(text))); sc != nil {
		opts.BaseHashes = sc.Files
	}
	plan, perr := patch.BuildPatchPlan(doc, old.Root, old.PatchID, old.Summary, old.PatchPath, opts)
	if perr != nil {
		return nil, perr
	}
	plan.External = old.External
	patch.PutPatchPlan(plan)
	if old.PlanID != "" {
		patch.DeletePatchPlan(old.PlanID)
	}
	return plan.ToPreview(), nil
}

// PatchApply 提交预览（必须带 planId）。
func (a *App) PatchApply(planID string, files []string, hunks map[string][]int, mode string) (*patch.PatchApplyResult, error) {
	plan := patch.GetPatchPlan(planID)
	if plan == nil {
		return &patch.PatchApplyResult{Code: patch.PatchErrBackend, Message: "预览已过期，请重新预览后再应用"}, nil
	}
	res, err := patch.ApplyPatchPlan(plan, files, hunks, mode)
	if err != nil {
		return nil, err
	}
	return res, nil
}

// PatchRevert 从备份还原整份补丁。
func (a *App) PatchRevert(patchID, root, onConflict string) (*patch.PatchRevertResult, error) {
	patchID = strings.TrimSpace(patchID)
	if patchID == "" {
		return &patch.PatchRevertResult{Code: patch.PatchErrBackend, Message: "缺少补丁 id"}, nil
	}
	return patch.RevertPatchByID(root, patchID, onConflict)
}

// PatchList 最近补丁列表（按时间倒序）。顺带做一次自愈：上次应用中途被打断、
// 只留下 applying 没有终态的补丁会被收敛成 failed，列表不再永远显示「应用中」。
func (a *App) PatchList(root string, limit int) ([]patch.PatchMeta, error) {
	patch.ReconcilePatchStore(root)
	store := patch.PatchStoreRoot(root)
	list := patch.CollectPatchMetas(store)
	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}
	return list, nil
}

// PatchDelete 删除补丁记录：补丁文件、备份、manifest、meta 一并送回收站，
// 并从 index.jsonl 摘掉该 id 的全部历史行（proposed/applying/applied…）。
// 已应用的补丁删除后无法再撤销，由界面二次确认。
func (a *App) PatchDelete(id, root string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return patch.NewPatchError(patch.PatchErrBackend, "缺少补丁 id")
	}
	store := patch.PatchStoreRoot(root)
	if store == "" {
		return patch.NewPatchError(patch.PatchErrNoBackup, "找不到补丁存储目录")
	}
	release, lockErr := patch.PatchLockFor(root)
	if lockErr != nil {
		return patch.NewPatchError(patch.PatchErrBusy, "另一个窗口正在处理补丁，请稍后再试")
	}
	defer release()

	entries := patch.ReadPatchIndex(store)
	patchPath := ""
	for _, e := range entries {
		if e.ID == id && e.PatchPath != "" {
			patchPath = e.PatchPath
		}
	}
	// 先算内容 sha：meta/<sha>.json 可能被同内容的其它补丁共享，不能盲删
	sha := ""
	if patchPath != "" {
		if raw, err := os.ReadFile(patchPath); err == nil {
			sha = patch.PatchTextSHA(patch.NormalizePatchBody(string(raw)))
		}
	}
	// 先摘索引再回收文件：宁可留下孤儿文件，也绝不留下指向不存在文件的幽灵记录
	if _, err := patch.PrunePatchIndex(store, id); err != nil {
		return &patch.PatchError{Code: patch.PatchErrApplyIO, Msg: "补丁索引清理失败", Detail: err.Error()}
	}
	targets := []string{
		filepath.Join(store, "backup", id),
		filepath.Join(store, "manifest", id+".json"),
	}
	if patchPath != "" {
		targets = append(targets, patchPath)
	}
	for _, path := range targets {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := patch.PatchRecycle(path); err != nil {
			// 文件回收失败不影响索引已清理的结果，记日志便于手工处理
			writeAppLog("WARN", "补丁文件回收失败（%s）：%v", path, err)
		}
	}
	patch.RemovePatchMetaIfUnused(store, sha)
	return nil
}

// PatchReadText 给补丁视图取正文（大文件时避免一次性塞进 Wails 调用参数）。
func (a *App) PatchReadText(path string) (string, error) {
	return patch.ReadFileText(path, patch.PatchMaxTextBytes)
}

// PatchWorkspaceRoot 给前端一个兜底：没开工作区时用应用数据目录存放补丁。
func (a *App) PatchStoreDir(root string) string {
	return patch.PatchStoreRoot(root)
}
