package patch

// 补丁落盘与删除编排：内容去重、预检失败清理、sidecar 基线、索引写入与回收。
// 根壳 patch_app.go 只保留转发；CLI 与界面共用同一套存储语义。

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SavePatch 落盘补丁并返回首次预览。
func SavePatch(root, summary, text string) (*PatchPreview, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, NewPatchError(PatchErrEmpty, "补丁内容为空")
	}
	if len(text) > PatchMaxTextBytes {
		return nil, NewPatchError(PatchErrLimit, "补丁超过 2 MB，请拆分成多个补丁")
	}
	doc, err := ParsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := PatchStoreRoot(root)
	if store == "" {
		return nil, NewPatchError(PatchErrNoBackup, "无法确定补丁存储目录")
	}
	if err := os.MkdirAll(store, 0o755); err != nil {
		return nil, &PatchError{Code: PatchErrNoBackup, Msg: "无法创建补丁目录", Detail: err.Error()}
	}
	body := NormalizePatchBody(text)
	// 内容复用：同一 root 下已有内容完全相同的补丁时直接复用，不再新建文件。
	// 以前每次重试（预检冲突后重写 hunk）都落一份新 .patch，3 次重试就是 4 个重复补丁。
	if old := FindPatchBySHA(store, root, PatchTextSHA(body)); old != nil {
		return previewExistingPatch(old, root, doc)
	}
	id := NewPatchRunID("")
	slug := SlugifyPatchSummary(summary)
	patchPath := UniquePatchPath(store, slug)
	if err := os.WriteFile(patchPath, []byte(body), 0o644); err != nil {
		return nil, &PatchError{Code: PatchErrApplyIO, Msg: "写入补丁文件失败", Detail: err.Error()}
	}

	plan, err := BuildPatchPlan(doc, root, id, summary, patchPath, PatchPlanOptions{})
	if err != nil {
		// 预检就失败的补丁不留档：刚写下的文件立刻删掉，避免失败重试堆积垃圾
		_ = os.Remove(patchPath)
		return nil, err
	}
	// 一个文件都不可应用（路径越界、hunk 全冲突、语法不支持）→ 不留档，直接把原因报回去：
	// 这类补丁重提交前必须重写，留下 .patch 只会攒垃圾
	if !PlanHasApplicableFile(plan) {
		_ = os.Remove(patchPath)
		return nil, &PatchError{Code: PatchErrHunkConflict, Msg: "补丁没有任何文件可直接应用", Detail: FirstPlanReason(plan)}
	}
	// 空补丁（+0/−0，也没有新增文件）没有任何价值，同样不落盘、不入索引
	if plan.Added == 0 && plan.Removed == 0 && !PlanHasAddedFile(plan) {
		_ = os.Remove(patchPath)
		return nil, NewPatchError(PatchErrEmpty, "补丁没有任何改动（+0/−0）：未保存，请确认 hunk 是否写对")
	}
	// 记录基线（此刻的磁盘内容就是"生成时"的版本）
	files := map[string]string{}
	for _, f := range plan.Files {
		if f.Target != nil && f.Target.Exists && f.RelPath != "" {
			files[strings.ToLower(f.RelPath)] = f.Target.Hash
		}
	}
	SaveSidecar(store, &Sidecar{
		ID: id, Summary: summary, CreatedAt: time.Now().Unix(),
		PatchSHA: SHA256Hex([]byte(body)), Root: root, Files: files,
	})
	_ = AppendPatchIndex(store, PatchIndexEntry{
		V: 1, ID: id, Summary: summary, FileName: filepath.Base(patchPath),
		CreatedAt: time.Now().Unix(), Root: root, Files: FileNames(plan),
		Added: plan.Added, Removed: plan.Removed, Status: "proposed", PatchPath: patchPath,
	})
	PutPatchPlan(plan)
	return plan.ToPreview(), nil
}

// previewExistingPatch 复用已存在的同内容补丁：重新预检并返回预览，不新建文件、不改索引。
// 返回的预览带 reused=true，调用方据此提示「内容与已有补丁相同，已复用」。
func previewExistingPatch(old *PatchIndexEntry, root string, doc *PatchDoc) (*PatchPreview, error) {
	plan, err := BuildPatchPlan(doc, root, old.ID, old.Summary, old.PatchPath, PatchPlanOptions{})
	if err != nil {
		return nil, err
	}
	PutPatchPlan(plan)
	preview := plan.ToPreview()
	preview.Reused = true
	return preview, nil
}

// DeletePatch 删除补丁记录：补丁文件、备份、manifest、meta 一并送回收站，
// 并从 index.jsonl 摘掉该 id 的全部历史行（proposed/applying/applied…）。
// 已应用的补丁删除后无法再撤销，由界面二次确认。
func DeletePatch(root, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return NewPatchError(PatchErrBackend, "缺少补丁 id")
	}
	store := PatchStoreRoot(root)
	if store == "" {
		return NewPatchError(PatchErrNoBackup, "找不到补丁存储目录")
	}
	release, lockErr := PatchLockFor(root)
	if lockErr != nil {
		return NewPatchError(PatchErrBusy, "另一个窗口正在处理补丁，请稍后再试")
	}
	defer release()

	entries := ReadPatchIndex(store)
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
			sha = PatchTextSHA(NormalizePatchBody(string(raw)))
		}
	}
	// 先摘索引再回收文件：宁可留下孤儿文件，也绝不留下指向不存在文件的幽灵记录
	if _, err := PrunePatchIndex(store, id); err != nil {
		return &PatchError{Code: PatchErrApplyIO, Msg: "补丁索引清理失败", Detail: err.Error()}
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
		if err := PatchRecycle(path); err != nil {
			// 文件回收失败不影响索引已清理的结果，记日志便于手工处理
			logf("WARN", "补丁文件回收失败（%s）：%v", path, err)
		}
	}
	RemovePatchMetaIfUnused(store, sha)
	return nil
}
