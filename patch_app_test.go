package main

// 补丁 App 层测试：走 App 方法验证参数整理与副作用（落盘 / 索引 / 回收）。
// 引擎纯函数测试在 internal/patch；测试小助手跨包无法共享，与包内同名同实现。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"datalens/internal/patch"
)

// useTempRecycle 把「删除进回收站」换成直接删除，避免测试往系统回收站丢东西。
func useTempRecycle(t *testing.T) {
	t.Helper()
	old := patch.PatchRecycle
	patch.PatchRecycle = func(path string) error { return os.RemoveAll(path) }
	t.Cleanup(func() { patch.PatchRecycle = old })
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

// writePatchTestFile / simplePatch 与 internal/patch/patch_test.go 同名同实现。
func writePatchTestFile(t *testing.T, root, rel, content string) string {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return abs
}

// 一个最小单 hunk 补丁：把 b 替换成 B
func simplePatch(rel string) string {
	return "--- a/" + rel + "\n+++ b/" + rel + "\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"
}

func TestPatchSaveRejectsEmptyPatch(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patch.PatchStoreRoot(root)
	a := &App{}
	// 只有上下文行 → +0/−0，没有实际改动
	empty := "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n two\n"
	_, err := a.PatchSave(root, "空补丁", empty)
	if err == nil {
		t.Fatal("空补丁应被拒绝")
	}
	if pe := patch.PatchErrorOf(err); pe == nil || pe.Code != patch.PatchErrEmpty {
		t.Fatalf("错误码 = %+v，预期 %s", pe, patch.PatchErrEmpty)
	}
	if n := countPatchFiles(t, store); n != 0 {
		t.Fatalf("空补丁不应留下文件，实际 %d 个 .patch", n)
	}
	if got := patch.ReadPatchIndex(store); len(got) != 0 {
		t.Fatalf("空补丁不应入索引，实际 %d 行", len(got))
	}
}

func TestPatchSavePrecheckFailureLeavesNoFile(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patch.PatchStoreRoot(root)
	a := &App{}
	// 目标路径逃出工作区根 → 文件被拦，一个 hunk 都不可应用
	escape := "--- a/../evil.txt\n+++ b/../evil.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n"
	_, err := a.PatchSave(root, "越界补丁", escape)
	if err == nil {
		t.Fatal("越界路径应被拒绝")
	}
	pe := patch.PatchErrorOf(err)
	if pe == nil || pe.Code != patch.PatchErrHunkConflict {
		t.Fatalf("错误码 = %+v，预期 %s", pe, patch.PatchErrHunkConflict)
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
	store := patch.PatchStoreRoot(root)
	a := &App{}
	// 上下文对不上（文件里是 one/two，补丁期望 x/y）→ 冲突，不可应用
	conflict := "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n x\n-y\n+Y\n"
	if _, err := a.PatchSave(root, "hunk 冲突", conflict); err == nil {
		t.Fatal("hunk 冲突应被拒绝")
	} else if pe := patch.PatchErrorOf(err); pe == nil || pe.Code != patch.PatchErrHunkConflict {
		t.Fatalf("错误码 = %+v，预期 %s", pe, patch.PatchErrHunkConflict)
	}
	if n := countPatchFiles(t, store); n != 0 {
		t.Fatalf("全冲突的补丁不应留档，实际 %d 个 .patch", n)
	}
	if got := patch.ReadPatchIndex(store); len(got) != 0 {
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
	store := patch.PatchStoreRoot(root)
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
	if ids := len(patch.PatchIndexLatest(patch.ReadPatchIndex(store))); ids != 1 {
		t.Fatalf("索引里应只有 1 个补丁 id，实际 %d", ids)
	}
}

func TestPatchDeleteRemovesEverything(t *testing.T) {
	useTempRecycle(t)
	root := newPatchTestRoot(t)
	store := patch.PatchStoreRoot(root)
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
	sha := patch.PatchTextSHA(patch.NormalizePatchBody(string(raw)))
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
	entries := patch.ReadPatchIndex(store)
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
	store := patch.PatchStoreRoot(root)
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
	_ = patch.AppendPatchIndex(store, patch.PatchIndexEntry{
		V: 1, ID: dupID, Summary: "重复的补丁", FileName: filepath.Base(dupPath),
		CreatedAt: keep.CreatedAt, Root: root, Files: []string{"a.txt"},
		Added: keep.Added, Removed: keep.Removed, Status: "proposed", PatchPath: dupPath,
	})
	sha := patch.PatchTextSHA(patch.NormalizePatchBody(string(raw)))
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
	store := patch.PatchStoreRoot(root)
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
	if got := patch.ReadPatchIndex(store); len(got) != 0 {
		t.Fatalf("预检不应写索引，实际 %d 行", len(got))
	}
	// 目标文件同样保持原样
	if raw, err := os.ReadFile(filepath.Join(root, "a.txt")); err != nil || string(raw) != "one\ntwo\n" {
		t.Fatalf("预检改动了目标文件：%q err=%v", raw, err)
	}
}

// 虚拟审阅文档没有盘上补丁文件：PatchPreviewText 直接吃拼接文本，
// 多段 diff 之间夹的自定义标题行 / 空行 / 说明行应被忽略；重预检走计划内缓存的原文。
func TestPatchPreviewTextVirtual(t *testing.T) {
	root := t.TempDir()
	writePatchTestFile(t, root, "a.txt", "a\nb\nc\n")
	writePatchTestFile(t, root, filepath.Join("dir", "b.txt"), "1\n2\n3\n")
	text := "diff — a.txt  (+1 −1)\n" +
		simplePatch("a.txt") +
		"\ndiff — dir/b.txt  (+1 −1)（无 Git 差异的文件会注明）\n" +
		"--- a/dir/b.txt\n+++ b/dir/b.txt\n@@ -1,3 +1,3 @@\n 1\n-2\n+2（改）\n 3\n" +
		"\n"
	app := &App{}
	preview, err := app.PatchPreviewText(text, root)
	if err != nil {
		t.Fatalf("PatchPreviewText: %v", err)
	}
	if len(preview.Files) != 2 {
		t.Fatalf("文件数 = %d，期望 2", len(preview.Files))
	}
	if preview.Added != 2 || preview.Removed != 2 {
		t.Fatalf("统计 = +%d -%d，期望 +2 -2", preview.Added, preview.Removed)
	}
	if !preview.External {
		t.Fatalf("虚拟文本补丁应标记 External")
	}
	if preview.PlanID == "" {
		t.Fatalf("planId 为空，无法重预检 / 应用")
	}
	// 重预检：文本补丁没有盘上文件，应走计划内缓存的 RawText
	replan, err := app.PatchRepreview(preview.PlanID, false, true)
	if err != nil {
		t.Fatalf("PatchRepreview: %v", err)
	}
	if len(replan.Files) != 2 {
		t.Fatalf("重预检文件数 = %d，期望 2", len(replan.Files))
	}
	// 忽略空白开关传了 true：行为等价（本例无空白差异），状态应全部 ok
	for _, f := range replan.Files {
		if f.Status != "ok" {
			t.Fatalf("%s 状态 = %s，期望 ok", f.RelPath, f.Status)
		}
	}
}

func TestPatchPreviewTextEmpty(t *testing.T) {
	app := &App{}
	if _, err := app.PatchPreviewText("   \n", t.TempDir()); err == nil {
		t.Fatalf("空文本应报错")
	}
}
