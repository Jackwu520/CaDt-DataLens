package patch

// 补丁库维护：索引裁剪、内容去重、滞留状态自愈、删除回收。
//
// 索引（.cadt/patches/index.jsonl）本身是追加式 WAL：同一补丁的 proposed / applying /
// applied 各一行，读取端按 id 归并。这个结构没问题，缺的是「生命周期管理」——
// 失败重试会各落一份补丁文件、内容重复照存、删不掉，于是越用越脏（2026-11-15 实测：
// 3 次重试留下 4 个 id、3 份备份共 1.8 MB）。本文件补上这一层。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/recycle"
)

// patchRecycle 删除补丁文件时的回收钩子：生产走回收站（可恢复），测试替换成直接删除。
var PatchRecycle = recycle.Move

// patchStatusFailed 应用未收尾（滞留 applying）收敛后的终态。
const patchStatusFailed = "failed"

func patchIndexPath(store string) string { return filepath.Join(store, "index.jsonl") }

// normalizePatchBody 统一补丁正文：去 BOM、CRLF→LF、去首尾空白、补尾换行。
// 落盘内容与内容 sha 都以它为准，去重和 meta 归属才能稳定比对。
func NormalizePatchBody(text string) string {
	body := strings.TrimPrefix(text, "\ufeff")
	body = strings.ReplaceAll(body, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\r", "\n")
	body = strings.TrimSpace(body)
	if body == "" {
		return ""
	}
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	return body
}

// patchTextSHA 补丁正文的内容 sha（与 PatchSave 落盘内容一致）。
func PatchTextSHA(body string) string {
	if body == "" {
		return ""
	}
	return SHA256Hex([]byte(body))
}

// patchIndexLatest 按行序取每个 id 的最后一条（追加式索引里最后一行即最新状态）。
func PatchIndexLatest(entries []PatchIndexEntry) map[string]PatchIndexEntry {
	out := make(map[string]PatchIndexEntry, len(entries))
	for _, e := range entries {
		if e.ID == "" {
			continue
		}
		out[e.ID] = e
	}
	return out
}

// prunePatchIndex 摘掉某个 id 的全部索引行，其它行逐字保留（原子替换）。
// 只摘行、不动历史状态语义：删完这个 id 就彻底从「最近补丁」里消失。
func PrunePatchIndex(store, id string) (int, error) {
	if store == "" || id == "" {
		return 0, nil
	}
	path := patchIndexPath(store)
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	lines := strings.Split(string(raw), "\n")
	kept := make([]string, 0, len(lines))
	removed := 0
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			kept = append(kept, line)
			continue
		}
		var e PatchIndexEntry
		if json.Unmarshal([]byte(trimmed), &e) == nil && e.ID == id {
			removed++
			continue
		}
		kept = append(kept, line)
	}
	if removed == 0 {
		return 0, nil
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	if _, err := f.WriteString(strings.Join(kept, "\n")); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return 0, err
	}
	return removed, nil
}

// findPatchBySHA 在同一 root 下找「内容 sha 相同且补丁文件仍在」的旧补丁。
// 找到就复用，不再新建文件——以前每次重试都落一份新 .patch。
func FindPatchBySHA(store, root, sha string) *PatchIndexEntry {
	if store == "" || sha == "" {
		return nil
	}
	latest := PatchIndexLatest(ReadPatchIndex(store))
	for _, e := range latest {
		if e.PatchPath == "" {
			continue
		}
		if !samePatchRoot(e.Root, root) {
			continue
		}
		raw, err := os.ReadFile(e.PatchPath)
		if err != nil {
			continue
		}
		if PatchTextSHA(NormalizePatchBody(string(raw))) != sha {
			continue
		}
		entry := e
		return &entry
	}
	return nil
}

// samePatchRoot 比较补丁归属根目录（大小写与分隔符不敏感；空根视为应用数据目录）。
func samePatchRoot(a, b string) bool {
	clean := func(p string) string {
		return strings.TrimSuffix(filepath.Clean(strings.ReplaceAll(p, "\\", "/")), "/")
	}
	return strings.EqualFold(clean(a), clean(b))
}

// removePatchMetaIfUnused 回收 meta/<sha>.json：仍有其它补丁用同一内容时保留（那份基线
// 是它们预检/撤销的依据），例如内容相同的两个补丁共享同一个 sidecar。
func RemovePatchMetaIfUnused(store, sha string) {
	if store == "" || sha == "" {
		return
	}
	for _, e := range ReadPatchIndex(store) {
		if e.PatchPath == "" {
			continue
		}
		raw, err := os.ReadFile(e.PatchPath)
		if err != nil {
			continue
		}
		if PatchTextSHA(NormalizePatchBody(string(raw))) == sha {
			return
		}
	}
	meta := filepath.Join(store, "meta", sha+".json")
	if _, err := os.Stat(meta); err == nil {
		if err := PatchRecycle(meta); err != nil {
			logf("WARN", "补丁元数据回收失败：%v", err)
		}
	}
}

// reconcilePatchStore 自愈：最后一条状态是 applying（写入前 WAL，正常收尾会再追加
// applied/partial/failed）却没有任何终态的补丁，说明上次应用中途被打断。追加一条
// failed 终态，让列表不再永远显示「应用中」。幂等：自愈后再调用不会重复追加。
func ReconcilePatchStore(root string) int {
	store := PatchStoreRoot(root)
	if store == "" {
		return 0
	}
	entries := ReadPatchIndex(store)
	if len(entries) == 0 {
		return 0
	}
	healed := 0
	for _, e := range PatchIndexLatest(entries) {
		if e.Status != "applying" {
			continue
		}
		e.Status = patchStatusFailed
		e.AppliedAt = 0
		if err := AppendPatchIndex(store, e); err != nil {
			continue
		}
		healed++
	}
	if healed > 0 {
		logf("WARN", "补丁库自愈：%d 个补丁上次应用未收尾，已标记为失败", healed)
	}
	return healed
}

// patchLockFor 拿补丁工作区跨进程锁；root 为空（补丁存应用数据目录）时不加锁。
func PatchLockFor(root string) (func(), error) {
	if strings.TrimSpace(root) == "" {
		return func() {}, nil
	}
	return lockPatchWorkspace(root, 3*time.Second)
}
