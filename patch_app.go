package main

// 补丁能力的 Wails 导出层：只做参数整理、根目录解析与副作用分发，
// 真正的解析/匹配/写入在 patch.go 的自由函数里，CLI 与界面共用同一套实现。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// patchSidecar 记录"这份补丁是基于哪一版文件生成的"，用于检测生成后的漂移。
// 不写进 .patch 本身（保持标准格式），按补丁内容 sha256 存本地。
type patchSidecar struct {
	ID        string            `json:"id"`
	Summary   string            `json:"summary"`
	CreatedAt int64             `json:"createdAt"`
	PatchSHA  string            `json:"patchSha"`
	Root      string            `json:"root"`
	Files     map[string]string `json:"files"` // relPath(小写) -> 生成时内容 sha256
}

func patchMetaDir(store string) string { return filepath.Join(store, "meta") }

func loadPatchSidecar(store, patchSHA string) *patchSidecar {
	if store == "" || patchSHA == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(patchMetaDir(store), patchSHA+".json"))
	if err != nil {
		return nil
	}
	var sc patchSidecar
	if json.Unmarshal(b, &sc) != nil {
		return nil
	}
	return &sc
}

func savePatchSidecar(store string, sc *patchSidecar) {
	if store == "" {
		return
	}
	_ = os.MkdirAll(patchMetaDir(store), 0o755)
	b, err := json.MarshalIndent(sc, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(patchMetaDir(store), sc.PatchSHA+".json"), b, 0o644)
}

// readPatchFileText 读取 .patch 文本：剥 BOM、统一换行，并做大小限制。
func readPatchFileText(path string, limit int) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("这是一个目录：%s", filepath.Base(path))
	}
	if info.Size() > int64(limit) {
		return "", newPatchError(patchErrLimit, fmt.Sprintf("补丁文件超过 %d KB，请拆分后再用", limit/1024))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	text := strings.TrimPrefix(string(raw), "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return text, nil
}

// PatchSave 落盘补丁并返回首次预览。
func (a *App) PatchSave(root, summary, text string) (*PatchPreview, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, newPatchError(patchErrEmpty, "补丁内容为空")
	}
	if len(text) > patchMaxTextBytes {
		return nil, newPatchError(patchErrLimit, "补丁超过 2 MB，请拆分成多个补丁")
	}
	doc, err := parsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patchStoreRoot(root)
	if store == "" {
		return nil, newPatchError(patchErrNoBackup, "无法确定补丁存储目录")
	}
	if err := os.MkdirAll(store, 0o755); err != nil {
		return nil, &patchError{Code: patchErrNoBackup, Msg: "无法创建补丁目录", Detail: err.Error()}
	}
	body := normalizePatchBody(text)
	// 内容复用：同一 root 下已有内容完全相同的补丁时直接复用，不再新建文件。
	// 以前每次重试（预检冲突后重写 hunk）都落一份新 .patch，3 次重试就是 4 个重复补丁。
	if old := findPatchBySHA(store, root, patchTextSHA(body)); old != nil {
		return a.previewExistingPatch(old, root, doc)
	}
	id := newPatchRunID("")
	slug := slugifyPatchSummary(summary)
	patchPath := uniquePatchPath(store, slug)
	if err := os.WriteFile(patchPath, []byte(body), 0o644); err != nil {
		return nil, &patchError{Code: patchErrApplyIO, Msg: "写入补丁文件失败", Detail: err.Error()}
	}

	plan, err := buildPatchPlan(doc, root, id, summary, patchPath, patchPlanOptions{})
	if err != nil {
		// 预检就失败的补丁不留档：刚写下的文件立刻删掉，避免失败重试堆积垃圾
		_ = os.Remove(patchPath)
		return nil, err
	}
	// 一个文件都不可应用（路径越界、hunk 全冲突、语法不支持）→ 不留档，直接把原因报回去：
	// 这类补丁重提交前必须重写，留下 .patch 只会攒垃圾
	if !planHasApplicableFile(plan) {
		_ = os.Remove(patchPath)
		return nil, &patchError{Code: patchErrHunkConflict, Msg: "补丁没有任何文件可直接应用", Detail: firstPlanReason(plan)}
	}
	// 空补丁（+0/−0，也没有新增文件）没有任何价值，同样不落盘、不入索引
	if plan.Added == 0 && plan.Removed == 0 && !planHasAddedFile(plan) {
		_ = os.Remove(patchPath)
		return nil, newPatchError(patchErrEmpty, "补丁没有任何改动（+0/−0）：未保存，请确认 hunk 是否写对")
	}
	// 记录基线（此刻的磁盘内容就是"生成时"的版本）
	files := map[string]string{}
	for _, f := range plan.Files {
		if f.Target != nil && f.Target.Exists && f.RelPath != "" {
			files[strings.ToLower(f.RelPath)] = f.Target.Hash
		}
	}
	savePatchSidecar(store, &patchSidecar{
		ID: id, Summary: summary, CreatedAt: time.Now().Unix(),
		PatchSHA: sha256Hex([]byte(body)), Root: root, Files: files,
	})
	_ = appendPatchIndex(store, patchIndexEntry{
		V: 1, ID: id, Summary: summary, FileName: filepath.Base(patchPath),
		CreatedAt: time.Now().Unix(), Root: root, Files: fileNames(plan),
		Added: plan.Added, Removed: plan.Removed, Status: "proposed", PatchPath: patchPath,
	})
	putPatchPlan(plan)
	return plan.toPreview(), nil
}

func fileNames(plan *patchPlan) []string {
	out := make([]string, 0, len(plan.Files))
	for _, f := range plan.Files {
		out = append(out, f.RelPath)
	}
	return out
}

// planHasAddedFile 补丁里是否有新建文件（+0/−0 但新建空文件时 Added/Removed 也可能是 0）。
func planHasAddedFile(plan *patchPlan) bool {
	for _, f := range plan.Files {
		if f != nil && f.Kind == "add" {
			return true
		}
	}
	return false
}

// planHasApplicableFile 是否存在可直接应用的 hunk（status=ok）。
// 全为 blocked/conflict/unsupported 时这份补丁必然要重写，不该落盘。
func planHasApplicableFile(plan *patchPlan) bool {
	for _, f := range plan.Files {
		if f != nil && f.Status == "ok" {
			return true
		}
	}
	return false
}

// firstPlanReason 取第一个失败文件的可读原因（附相对路径），给模型定位用。
func firstPlanReason(plan *patchPlan) string {
	for _, f := range plan.Files {
		if f == nil || f.Status == "ok" {
			continue
		}
		rel := f.RelPath
		if rel == "" {
			rel = "(路径未知)"
		}
		if f.Reason != "" {
			return rel + "：" + f.Reason
		}
		return rel + "：无法应用"
	}
	return ""
}

// previewExistingPatch 复用已存在的同内容补丁：重新预检并返回预览，不新建文件、不改索引。
// 返回的预览带 reused=true，调用方据此提示「内容与已有补丁相同，已复用」。
func (a *App) previewExistingPatch(old *patchIndexEntry, root string, doc *patchDoc) (*PatchPreview, error) {
	plan, err := buildPatchPlan(doc, root, old.ID, old.Summary, old.PatchPath, patchPlanOptions{})
	if err != nil {
		return nil, err
	}
	putPatchPlan(plan)
	preview := plan.toPreview()
	preview.Reused = true
	return preview, nil
}

// PatchPreviewFile 打开任意 .patch（外部补丁）：自动解析路径层级、带基线校验。
func (a *App) PatchPreviewFile(path, root string) (*PatchPreview, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, newPatchError(patchErrBackend, "缺少补丁文件路径")
	}
	text, err := readPatchFileText(path, patchMaxTextBytes)
	if err != nil {
		return nil, err
	}
	doc, err := parsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patchStoreRoot(root)
	sha := sha256Hex([]byte(text))
	var opts patchPlanOptions
	opts.External = true
	summary := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	if sc := loadPatchSidecar(store, sha); sc != nil {
		opts.BaseHashes = sc.Files
		if sc.Summary != "" {
			summary = sc.Summary
		}
	}
	opts.StripLevel = -1
	plan, perr := buildPatchPlan(doc, root, "", summary, path, opts)
	if perr != nil {
		return nil, perr
	}
	// 若是本应用生成、后来被重新打开的补丁：按索引把 id 找回来，撤销才能用
	absPath, _ := filepath.Abs(path)
	for _, meta := range collectPatchMetas(store) {
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
	putPatchPlan(plan)
	return plan.toPreview(), nil
}

// PatchPreviewText 直接从补丁文本预览，用于虚拟 diff 文档（AI 审阅拼接 / Git 差异拼接）：
// 这类文档 path 为空、内容即补丁文本，没有盘上的补丁文件，不落盘、不写索引；
// 计划标记 External，与文件路径预览共用同一套预检/应用流（重预检走计划内的 rawText）。
func (a *App) PatchPreviewText(text, root string) (*PatchPreview, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, newPatchError(patchErrEmpty, "补丁内容为空")
	}
	if len(text) > patchMaxTextBytes {
		return nil, newPatchError(patchErrLimit, "补丁超过 2 MB，请拆分成多个补丁")
	}
	doc, err := parsePatchText(text)
	if err != nil {
		return nil, err
	}
	// 与 PatchPreviewFile 同款：拼接文本的 a/ 前缀层级未知，走自动探测
	plan, perr := buildPatchPlan(doc, root, "", "审阅", "", patchPlanOptions{External: true, StripLevel: -1})
	if perr != nil {
		return nil, perr
	}
	plan.rawText = text
	putPatchPlan(plan)
	return plan.toPreview(), nil
}

// PatchRepreview 用同一份补丁按新选项重新预检（勾选变化 / 允许位移 / 忽略空白）。
func (a *App) PatchRepreview(planID string, allowOffset, ignoreWhitespace bool) (*PatchPreview, error) {
	old := getPatchPlan(planID)
	if old == nil {
		return nil, newPatchError(patchErrBackend, "预览已过期，请重新打开补丁")
	}
	// 文本补丁（虚拟 diff 文档）没有盘上文件，直接用计划里缓存的原文
	text, err := func() (string, error) {
		if old.rawText != "" {
			return old.rawText, nil
		}
		return readPatchFileText(old.PatchPath, patchMaxTextBytes)
	}()
	if err != nil {
		return nil, err
	}
	doc, err := parsePatchText(text)
	if err != nil {
		return nil, err
	}
	store := patchStoreRoot(old.Root)
	opts := patchPlanOptions{AllowOffset: allowOffset, IgnoreWhitespace: ignoreWhitespace, External: old.External}
	if sc := loadPatchSidecar(store, sha256Hex([]byte(text))); sc != nil {
		opts.BaseHashes = sc.Files
	}
	plan, perr := buildPatchPlan(doc, old.Root, old.PatchID, old.Summary, old.PatchPath, opts)
	if perr != nil {
		return nil, perr
	}
	plan.External = old.External
	putPatchPlan(plan)
	if old.PlanID != "" {
		patchPlanMu.Lock()
		delete(patchPlans, old.PlanID)
		patchPlanMu.Unlock()
	}
	return plan.toPreview(), nil
}

// PatchApply 提交预览（必须带 planId）。
func (a *App) PatchApply(planID string, files []string, hunks map[string][]int, mode string) (*PatchApplyResult, error) {
	plan := getPatchPlan(planID)
	if plan == nil {
		return &PatchApplyResult{Code: patchErrBackend, Message: "预览已过期，请重新预览后再应用"}, nil
	}
	res, err := applyPatchPlan(plan, files, hunks, mode)
	if err != nil {
		return nil, err
	}
	return res, nil
}

// PatchRevert 从备份还原整份补丁。
func (a *App) PatchRevert(patchID, root, onConflict string) (*PatchRevertResult, error) {
	patchID = strings.TrimSpace(patchID)
	if patchID == "" {
		return &PatchRevertResult{Code: patchErrBackend, Message: "缺少补丁 id"}, nil
	}
	return revertPatchByID(root, patchID, onConflict)
}

// PatchList 最近补丁列表（按时间倒序）。顺带做一次自愈：上次应用中途被打断、
// 只留下 applying 没有终态的补丁会被收敛成 failed，列表不再永远显示「应用中」。
func (a *App) PatchList(root string, limit int) ([]PatchMeta, error) {
	reconcilePatchStore(root)
	store := patchStoreRoot(root)
	list := collectPatchMetas(store)
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
		return newPatchError(patchErrBackend, "缺少补丁 id")
	}
	store := patchStoreRoot(root)
	if store == "" {
		return newPatchError(patchErrNoBackup, "找不到补丁存储目录")
	}
	release, lockErr := patchLockFor(root)
	if lockErr != nil {
		return newPatchError(patchErrBusy, "另一个窗口正在处理补丁，请稍后再试")
	}
	defer release()

	entries := readPatchIndex(store)
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
			sha = patchTextSHA(normalizePatchBody(string(raw)))
		}
	}
	// 先摘索引再回收文件：宁可留下孤儿文件，也绝不留下指向不存在文件的幽灵记录
	if _, err := prunePatchIndex(store, id); err != nil {
		return &patchError{Code: patchErrApplyIO, Msg: "补丁索引清理失败", Detail: err.Error()}
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
		if err := patchRecycle(path); err != nil {
			// 文件回收失败不影响索引已清理的结果，记日志便于手工处理
			writeAppLog("WARN", "补丁文件回收失败（%s）：%v", path, err)
		}
	}
	removePatchMetaIfUnused(store, sha)
	return nil
}

// PatchReadText 给补丁视图取正文（大文件时避免一次性塞进 Wails 调用参数）。
func (a *App) PatchReadText(path string) (string, error) {
	return readPatchFileText(path, patchMaxTextBytes)
}

// PatchWorkspaceRoot 给前端一个兜底：没开工作区时用应用数据目录存放补丁。
func (a *App) PatchStoreDir(root string) string {
	return patchStoreRoot(root)
}
