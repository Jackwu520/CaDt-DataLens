package main

// 补丁库生命周期测试：内容去重、空补丁/失败不留档、删除完整性（含共享 meta）、
// applying 滞留自愈、索引裁剪保序。全部在 t.TempDir() 里跑，回收钩子替换成直接删除。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// useTempRecycle 把「删除进回收站」换成直接删除，避免测试往系统回收站丢东西。
func useTempRecycle(t *testing.T) {
	t.Helper()
	old := patchRecycle
	patchRecycle = func(path string) error { return os.RemoveAll(path) }
	t.Cleanup(func() { patchRecycle = old })
}

func writeFileAt(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// patchForFile 生成一个「把 two 改成 TWO」的合法补丁。
func patchForFile(rel string) string {
	return "--- a/" + rel + "\n+++ b/" + rel + "\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n"
}

// newPatchTestRoot 建临时工作区，并放一个内容为 one/two 的目标文件。
func newPatchTestRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFileAt(t, filepath.Join(root, "a.txt"), "one\ntwo\n")
	return root
}

func countPatchFiles(t *testing.T, store string) int {
	t.Helper()
	entries, err := os.ReadDir(store)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".patch") {
			n++
		}
	}
	return n
}

func TestNormalizePatchBody(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"去 BOM 与 CRLF", "\ufeffa\r\nb\r\n", "a\nb\n"},
		{"补齐尾换行", "a\nb", "a\nb\n"},
		{"去首尾空白", "\n\n  a  \n\n", "a\n"},
		{"纯空白归零", "  \n\t\n", ""},
		{"CR 单独出现也归一", "a\rb\r", "a\nb\n"},
	}
	for _, c := range cases {
		if got := normalizePatchBody(c.in); got != c.want {
			t.Fatalf("%s：normalizePatchBody(%q) = %q，预期 %q", c.name, c.in, got, c.want)
		}
	}
	// 归一后内容相同 → sha 相同（去重判据）
	if patchTextSHA(normalizePatchBody("a\r\nb")) != patchTextSHA(normalizePatchBody("a\nb\n")) {
		t.Fatal("归一后 sha 应一致")
	}
	if patchTextSHA("") != "" {
		t.Fatal("空正文的 sha 应为空串")
	}
}

func TestPatchSaveRejectsEmptyPatch(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patchStoreRoot(root)
	a := &App{}
	// 只有上下文行 → +0/−0，没有实际改动
	empty := "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n two\n"
	_, err := a.PatchSave(root, "空补丁", empty)
	if err == nil {
		t.Fatal("空补丁应被拒绝")
	}
	if pe := patchErrorOf(err); pe == nil || pe.Code != patchErrEmpty {
		t.Fatalf("错误码 = %+v，预期 %s", pe, patchErrEmpty)
	}
	if n := countPatchFiles(t, store); n != 0 {
		t.Fatalf("空补丁不应留下文件，实际 %d 个 .patch", n)
	}
	if got := readPatchIndex(store); len(got) != 0 {
		t.Fatalf("空补丁不应入索引，实际 %d 行", len(got))
	}
}

func TestPatchSavePrecheckFailureLeavesNoFile(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patchStoreRoot(root)
	a := &App{}
	// 目标路径逃出工作区根 → 文件被拦，一个 hunk 都不可应用
	escape := "--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n"
	_, err := a.PatchSave(root, "越界补丁", escape)
	if err == nil {
		t.Fatal("越界路径应被拒绝")
	}
	pe := patchErrorOf(err)
	if pe == nil || pe.Code != patchErrHunkConflict {
		t.Fatalf("错误码 = %+v，预期 %s", pe, patchErrHunkConflict)
	}
	if !strings.Contains(pe.Detail, "越界") {
		t.Fatalf("原因应指出路径越界，实际 %q", pe.Detail)
	}
	if n := countPatchFiles(t, store); n != 0 {
		t.Fatalf("不可应用的补丁不应留档，实际 %d 个 .patch", n)
	}
}

func TestPatchSaveNoApplicableHunksLeavesNoFile(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patchStoreRoot(root)
	a := &App{}
	// 上下文对不上（文件里是 one/two，补丁期望 x/y）→ 冲突，不可应用
	conflict := "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+Y\n"
	if _, err := a.PatchSave(root, "hunk 冲突", conflict); err == nil {
		t.Fatal("hunk 冲突应被拒绝")
	} else if pe := patchErrorOf(err); pe == nil || pe.Code != patchErrHunkConflict {
		t.Fatalf("错误码 = %+v，预期 %s", pe, patchErrHunkConflict)
	}
	if n := countPatchFiles(t, store); n != 0 {
		t.Fatalf("全冲突的补丁不应留档，实际 %d 个 .patch", n)
	}
	if got := readPatchIndex(store); len(got) != 0 {
		t.Fatalf("不可应用的补丁不应入索引，实际 %d 行", len(got))
	}
	// 目标文件必须原样未动
	if raw, err := os.ReadFile(filepath.Join(root, "a.txt")); err != nil || string(raw) != "one\ntwo\n" {
		t.Fatalf("目标文件被改动：%q err=%v", raw, err)
	}
}

func TestPatchSaveDedupReusesExisting(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patchStoreRoot(root)
	a := &App{}
	text := patchForFile("a.txt")
	first, err := a.PatchSave(root, "改 TWO", text)
	if err != nil {
		t.Fatalf("首次保存: %v", err)
	}
	if first.Reused {
		t.Fatal("首次保存不应标记为复用")
	}
	// 同一内容（含 CRLF 差异）再提交一次：应复用，不新建文件
	second, err := a.PatchSave(root, "改 TWO 重试", strings.ReplaceAll(text, "\n", "\r\n"))
	if err != nil {
		t.Fatalf("二次保存: %v", err)
	}
	if !second.Reused {
		t.Fatal("同内容二次保存应标记为复用")
	}
	if second.PatchID != first.PatchID || second.PatchPath != first.PatchPath {
		t.Fatalf("复用应指向旧补丁：first=%s/%s second=%s/%s",
			first.PatchID, first.PatchPath, second.PatchID, second.PatchPath)
	}
	if n := countPatchFiles(t, store); n != 1 {
		t.Fatalf("复用不应新建补丁文件，实际 %d 个 .patch", n)
	}
	if ids := len(patchIndexLatest(readPatchIndex(store))); ids != 1 {
		t.Fatalf("索引里应只有 1 个补丁 id，实际 %d", ids)
	}
}

func TestPatchDeleteRemovesEverything(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patchStoreRoot(root)
	a := &App{}
	preview, err := a.PatchSave(root, "改 TWO", patchForFile("a.txt"))
	if err != nil {
		t.Fatalf("保存: %v", err)
	}
	id := preview.PatchID
	// 造出 backup 与 meta（正常流程里应用时才写入）
	writeFileAt(t, filepath.Join(store, "backup", id, "000-a.txt"), "one\ntwo\n")
	raw, err := os.ReadFile(preview.PatchPath)
	if err != nil {
		t.Fatalf("读补丁: %v", err)
	}
	sha := patchTextSHA(normalizePatchBody(string(raw)))
	metaPath := filepath.Join(store, "meta", sha+".json")
	if _, err := os.Stat(metaPath); err != nil {
		t.Fatalf("meta 应存在：%v", err)
	}

	if err := a.PatchDelete(id, root); err != nil {
		t.Fatalf("删除: %v", err)
	}
	if _, err := os.Stat(preview.PatchPath); !os.IsNotExist(err) {
		t.Fatal("补丁文件应被删除")
	}
	if _, err := os.Stat(filepath.Join(store, "backup", id)); !os.IsNotExist(err) {
		t.Fatal("备份目录应被删除")
	}
	if _, err := os.Stat(filepath.Join(store, "manifest", id+".json")); !os.IsNotExist(err) {
		t.Fatal("manifest 应被删除")
	}
	if _, err := os.Stat(metaPath); !os.IsNotExist(err) {
		t.Fatal("独占的 meta 应被删除")
	}
	entries := readPatchIndex(store)
	if len(entries) != 0 {
		t.Fatalf("索引行应被摘干净，实际剩 %d 行", len(entries))
	}
	// 列表里也不应再有它（幽灵记录）
	list, err := a.PatchList(root, 0)
	if err != nil {
		t.Fatalf("列表: %v", err)
	}
	for _, m := range list {
		if m.ID == id {
			t.Fatal("删除后列表里仍有该补丁")
		}
	}
}

func TestPatchDeleteKeepsSharedMeta(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patchStoreRoot(root)
	a := &App{}
	keep, err := a.PatchSave(root, "保留的补丁", patchForFile("a.txt"))
	if err != nil {
		t.Fatalf("保存: %v", err)
	}
	// 伪造一份内容完全相同的第二个补丁（绕过去重：直接复制文件 + 追加索引行）
	dupPath := filepath.Join(store, "20991111-000000-dup.patch")
	raw, err := os.ReadFile(keep.PatchPath)
	if err != nil {
		t.Fatalf("读补丁: %v", err)
	}
	writeFileAt(t, dupPath, string(raw))
	dupID := "20991111-000000-0001"
	_ = appendPatchIndex(store, patchIndexEntry{
		V: 1, ID: dupID, Summary: "重复的补丁", FileName: filepath.Base(dupPath),
		CreatedAt: keep.CreatedAt, Root: root, Files: []string{"a.txt"},
		Added: keep.Added, Removed: keep.Removed, Status: "proposed", PatchPath: dupPath,
	})
	sha := patchTextSHA(normalizePatchBody(string(raw)))
	metaPath := filepath.Join(store, "meta", sha+".json")
	if _, err := os.Stat(metaPath); err != nil {
		t.Fatalf("meta 应存在：%v", err)
	}

	if err := a.PatchDelete(dupID, root); err != nil {
		t.Fatalf("删除重复补丁: %v", err)
	}
	if _, err := os.Stat(metaPath); err != nil {
		t.Fatal("还有同样内容的补丁在，meta 不能被删")
	}
	if _, err := os.Stat(keep.PatchPath); err != nil {
		t.Fatal("另一个补丁的文件不应受影响")
	}
	if _, err := os.Stat(dupPath); !os.IsNotExist(err) {
		t.Fatal("被删补丁的文件应消失")
	}

	// 再把唯一剩下的一份也删掉，meta 这时才应被回收
	if err := a.PatchDelete(keep.PatchID, root); err != nil {
		t.Fatalf("删除保留补丁: %v", err)
	}
	if _, err := os.Stat(metaPath); !os.IsNotExist(err) {
		t.Fatal("最后一个同内容补丁删掉后 meta 应被回收")
	}
}

func TestPatchPreviewTextWritesNothing(t *testing.T) {
	// 计划模式的 dry_run 走 PatchPreviewText：必须完全不落地（不建 .cadt/patches、
	// 不写索引、不生成 .patch），否则「计划模式零副作用」就不成立。
	root := newPatchTestRoot(t)
	store := patchStoreRoot(root)
	a := &App{}
	preview, err := a.PatchPreviewText(patchForFile("a.txt"), root)
	if err != nil {
		t.Fatalf("预检: %v", err)
	}
	if preview == nil || len(preview.Files) != 1 {
		t.Fatalf("预检结果异常：%+v", preview)
	}
	if !preview.Applicable {
		t.Fatalf("目标文件存在且上下文匹配，应可应用：%+v", preview.Files)
	}
	if _, err := os.Stat(store); !os.IsNotExist(err) {
		t.Fatalf("预检不应创建补丁目录：%v", err)
	}
	if n := countPatchFiles(t, store); n != 0 {
		t.Fatalf("预检不应生成 .patch，实际 %d", n)
	}
	if got := readPatchIndex(store); len(got) != 0 {
		t.Fatalf("预检不应写索引，实际 %d 行", len(got))
	}
	// 目标文件同样保持原样
	if raw, err := os.ReadFile(filepath.Join(root, "a.txt")); err != nil || string(raw) != "one\ntwo\n" {
		t.Fatalf("预检改动了目标文件：%q err=%v", raw, err)
	}
}

func TestReconcilePatchStoreHealsApplying(t *testing.T) {
	root := t.TempDir()
	store := patchStoreRoot(root)
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	stuck := "20261113-200255-4321"
	done := "20261113-200523-4253"
	_ = appendPatchIndex(store, patchIndexEntry{V: 1, ID: stuck, Summary: "卡住的", Status: "proposed"})
	_ = appendPatchIndex(store, patchIndexEntry{V: 1, ID: stuck, Summary: "卡住的", Status: "applying"})
	_ = appendPatchIndex(store, patchIndexEntry{V: 1, ID: done, Summary: "完成的", Status: "applying"})
	_ = appendPatchIndex(store, patchIndexEntry{V: 1, ID: done, Summary: "完成的", Status: "applied", AppliedAt: 1})

	if healed := reconcilePatchStore(root); healed != 1 {
		t.Fatalf("应自愈 1 个补丁，实际 %d", healed)
	}
	latest := patchIndexLatest(readPatchIndex(store))
	if latest[stuck].Status != patchStatusFailed {
		t.Fatalf("滞留 applying 应收敛为 %s，实际 %s", patchStatusFailed, latest[stuck].Status)
	}
	if latest[done].Status != "applied" {
		t.Fatalf("正常收尾的补丁状态不应被改，实际 %s", latest[done].Status)
	}
	// 幂等：再跑一次不再追加
	before := len(readPatchIndex(store))
	if healed := reconcilePatchStore(root); healed != 0 {
		t.Fatalf("二次自愈应为 0，实际 %d", healed)
	}
	if after := len(readPatchIndex(store)); after != before {
		t.Fatalf("二次自愈不应追加行：%d → %d", before, after)
	}
}

func TestPrunePatchIndexKeepsOtherLines(t *testing.T) {
	root := t.TempDir()
	store := patchStoreRoot(root)
	if err := os.MkdirAll(store, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = appendPatchIndex(store, patchIndexEntry{V: 1, ID: "aaa", Summary: "A", Status: "proposed", Mode: "atomic"})
	_ = appendPatchIndex(store, patchIndexEntry{V: 1, ID: "bbb", Summary: "B", Status: "applied", AppliedAt: 7})
	_ = appendPatchIndex(store, patchIndexEntry{V: 1, ID: "aaa", Summary: "A", Status: "applied", AppliedAt: 9})
	before := readPatchIndex(store)

	removed, err := prunePatchIndex(store, "aaa")
	if err != nil {
		t.Fatalf("裁剪: %v", err)
	}
	if removed != 2 {
		t.Fatalf("应删除 2 行，实际 %d", removed)
	}
	after := readPatchIndex(store)
	if len(after) != 1 || after[0].ID != "bbb" {
		t.Fatalf("只应留下 bbb，实际 %+v", after)
	}
	// 保留行逐字不变（包括 mode / appliedAt 等字段）
	if after[0].Mode != before[1].Mode || after[0].AppliedAt != before[1].AppliedAt {
		t.Fatalf("保留行字段被改动：%+v vs %+v", after[0], before[1])
	}
	// 幂等：再删一次没有任何改动
	if removed, err := prunePatchIndex(store, "aaa"); err != nil || removed != 0 {
		t.Fatalf("二次裁剪应无改动：removed=%d err=%v", removed, err)
	}
}
