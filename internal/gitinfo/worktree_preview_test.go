package gitinfo

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// previewSkipIfUnsupported 预检不支持（git <2.38）时整组跳过——引擎对低版本是降级不是报错。
func previewSkipIfUnsupported(t *testing.T, res *GitWorktreeMergePreviewResult) {
	t.Helper()
	if res == nil {
		t.Fatal("preview result nil")
	}
	if !res.Supported {
		t.Skipf("merge-tree 预检不可用（%s），跳过", res.Reason)
	}
}

func TestPatchIDStable(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 patch-id 测试")
	}
	d1 := "diff --git a/x.txt b/x.txt\nindex 0000000..1111111 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n"
	id1a, err := PatchID(d1)
	if err != nil {
		t.Fatal(err)
	}
	if id1a == "" {
		t.Fatal("patch-id 为空")
	}
	id1b, err := PatchID(d1)
	if err != nil {
		t.Fatal(err)
	}
	if id1a != id1b {
		t.Fatalf("同一 diff 指纹不稳定：%q vs %q", id1a, id1b)
	}
	d2 := strings.Replace(d1, "+b\n", "+c\n", 1)
	id2, err := PatchID(d2)
	if err != nil {
		t.Fatal(err)
	}
	if id2 == id1a {
		t.Fatal("不同 diff 指纹相同")
	}
	if empty, err := PatchID("   \n"); err != nil || empty != "" {
		t.Fatalf("空 diff 应返回空指纹：err=%v id=%q", err, empty)
	}
}

// TestWorktreeMergePreviewClassification 三栏分类：冲突 / 已应用 / 可应用，一次覆盖。
// 场景矩阵（base：a.txt="a\n"）：
//   - a.txt      双方同改不同内容      → 真冲突
//   - shared.txt 双方改成完全一样内容  → 已应用（ours == theirs）
//   - new.txt    仅隔离区新增          → 可应用
//   - main-only  仅主根新增未跟踪文件  → 不在任何栏（不在 theirs 改动集）
func TestWorktreeMergePreviewClassification(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 预检集成测试")
	}
	if !gitVersionAtLeast(mergeTreeMinMajor, mergeTreeMinMinor) {
		t.Skip("git 版本过低，跳过")
	}
	dir := worktreeTestRepo(t)
	added, err := WorktreeAdd(dir, "preview test", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	wt := added.Path
	write := func(base, rel, content string) {
		if err := os.WriteFile(filepath.Join(base, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(wt, "a.txt", "wt edit\n")
	write(dir, "a.txt", "main edit\n")
	write(wt, "shared.txt", "same\n")
	write(dir, "shared.txt", "same\n")
	write(wt, "new.txt", "new\n")
	write(dir, "main-only.txt", "main only\n")

	res, err := WorktreeMergePreview(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	previewSkipIfUnsupported(t, res)

	if res.Clean {
		t.Fatalf("双方同改 a.txt 应判冲突，Clean=true；messages=%v", res.Messages)
	}
	has := func(list []string, want string) bool {
		for _, p := range list {
			if p == want {
				return true
			}
		}
		return false
	}
	if !has(res.ConflictedPaths(), "a.txt") {
		t.Fatalf("a.txt 应在真冲突栏：%v", res.Conflicted)
	}
	if len(res.Conflicted[conflictIndexOf(res, "a.txt")].Reasons) == 0 {
		t.Fatalf("冲突文件应附原因（messages 里应有 CONFLICT 行）：%v", res.Conflicted)
	}
	if !has(res.AlreadyApplied, "shared.txt") {
		t.Fatalf("shared.txt（双方同内容）应判已应用：applicable=%v already=%v", res.Applicable, res.AlreadyApplied)
	}
	if !has(res.Applicable, "new.txt") {
		t.Fatalf("new.txt（仅隔离区新增）应判可应用：%v", res.Applicable)
	}
	if has(res.Applicable, "main-only.txt") || has(res.AlreadyApplied, "main-only.txt") || has(res.ConflictedPaths(), "main-only.txt") {
		t.Fatal("main-only.txt 只在主根，不应出现在任何栏")
	}
	if res.TreeSha == "" {
		t.Fatal("TreeSha 缺失")
	}
	if res.ReportPath == "" {
		t.Fatalf("报告未落盘：%s", res.ReportErr)
	}
	data, rerr := os.ReadFile(filepath.FromSlash(res.ReportPath))
	if rerr != nil {
		t.Fatal(rerr)
	}
	for _, want := range []string{"a.txt", "shared.txt", "new.txt", "真冲突", "已应用"} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("报告缺 %q：\n%s", want, data)
		}
	}
}

func conflictIndexOf(res *GitWorktreeMergePreviewResult, path string) int {
	for i, f := range res.Conflicted {
		if f.Path == path {
			return i
		}
	}
	return -1
}

// TestWorktreeMergePreviewClean 无漂移 + 仅隔离区改动：干净合入，全部可应用。
func TestWorktreeMergePreviewClean(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git")
	}
	if !gitVersionAtLeast(mergeTreeMinMajor, mergeTreeMinMinor) {
		t.Skip("git 版本过低，跳过")
	}
	dir := worktreeTestRepo(t)
	added, err := WorktreeAdd(dir, "preview clean", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(added.Path, "b.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := WorktreeMergePreview(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	previewSkipIfUnsupported(t, res)
	if !res.Clean || len(res.Conflicted) != 0 || len(res.AlreadyApplied) != 0 || len(res.Applicable) != 1 || res.Applicable[0] != "b.txt" {
		t.Fatalf("干净场景分类不符：%#v", res)
	}
}

// TestSnapshotPreservesStagedIndex 快照绝不碰主根真 index：用户已 staged 的内容原样保留。
func TestSnapshotPreservesStagedIndex(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git")
	}
	if !gitVersionAtLeast(mergeTreeMinMajor, mergeTreeMinMinor) {
		t.Skip("git 版本过低，跳过")
	}
	dir := worktreeTestRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "b.txt") // 用户暂存区：b.txt staged
	before := gitTestCmd(t, dir, "diff", "--cached", "--name-only")

	added, err := WorktreeAdd(dir, "snap idx", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(added.Path, "n.txt"), []byte("n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("main edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := WorktreeMergePreview(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	previewSkipIfUnsupported(t, res)
	after := gitTestCmd(t, dir, "diff", "--cached", "--name-only")
	if after != before {
		t.Fatalf("预检后主根暂存区被改动：before=%q after=%q", before, after)
	}
	// HEAD 也不能动
	if head := strings.TrimSpace(gitTestCmd(t, dir, "rev-parse", "HEAD")); head != added.BaseSha {
		t.Fatalf("预检后主根 HEAD 被改动：%q vs %q", head, added.BaseSha)
	}
}

// TestWorktreeMergeApply 应用换轨：漂移合并写回 / 冲突不写 / 已应用跳过 / 删除同步 / index 不动。
// 场景：base = a.txt("a\nb\nc\nd\n") + del.txt；隔离区改 a.txt 的 c 行、新增 already.txt（与
// 主根同内容）、新增 new.txt、删 del.txt、改 conflict.txt；主根漂移 a.txt 的 d 行、同写 already.txt、
// 异写 conflict.txt、独有 keep.txt。
func TestWorktreeMergeApply(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git")
	}
	if !gitVersionAtLeast(mergeTreeMinMajor, mergeTreeMinMinor) {
		t.Skip("git 版本过低，跳过")
	}
	dir := worktreeTestRepo(t)
	// 扩充 base：a.txt 多行 + del.txt 入库（删除场景需要 base 里有这个文件）
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\nb\nc\nsep\nd\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "del.txt"), []byte("to be deleted\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "-A")
	gitTestCmd(t, dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "extend base")
	baseSha := strings.TrimSpace(gitTestCmd(t, dir, "rev-parse", "HEAD"))

	added, err := WorktreeAdd(dir, "apply test", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if added.BaseSha != baseSha {
		t.Fatalf("baseSha = %q, want %q", added.BaseSha, baseSha)
	}
	wt := added.Path
	write := func(base, rel, content string) {
		if err := os.WriteFile(filepath.Join(base, rel), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// theirs（隔离区工作区，全部不提交——与真实 export 语义一致）
	write(wt, "a.txt", "a\nb\nC-wt\nsep\nd\n")  // 第 3 行改动（与主根改动隔一行）→ 可合并
	write(wt, "conflict.txt", "wt line\n")        // 新文件
	write(wt, "already.txt", "same\n")            // 新文件
	write(wt, "new.txt", "brand new\n")           // 新文件
	if err := os.Remove(filepath.Join(wt, "del.txt")); err != nil { // 删除 base 已跟踪文件
		t.Fatal(err)
	}
	// ours（主根工作区）
	write(dir, "a.txt", "a\nb\nc\nsep\nD-main\n") // 第 5 行漂移 → 与 theirs 可合并
	write(dir, "conflict.txt", "main line\n")     // 与 theirs 同名新文件异内容 → 真冲突
	write(dir, "already.txt", "same\n")           // 与 theirs 同内容 → 已应用
	write(dir, "keep.txt", "main keep\n")         // 主根独有，不在改动集

	res, err := WorktreeMergeApply(dir, added.Name, added.BaseSha, []string{
		"a.txt", "conflict.txt", "already.txt", "new.txt", "del.txt", "../outside.txt",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Supported {
		t.Fatalf("应用不支持：%s", res.Reason)
	}
	byPath := map[string]GitMergeApplyFile{}
	for _, f := range res.Files {
		byPath[f.RelPath] = f
	}
	// a.txt：漂移合并 → applied，且两侧改动同时在场
	if f := byPath["a.txt"]; f.Status != "applied" {
		t.Fatalf("a.txt 应 applied：%+v", f)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "a.txt")); err != nil || string(data) != "a\nb\nC-wt\nsep\nD-main\n" {
		t.Fatalf("a.txt 合并结果不符：err=%v data=%q", err, data)
	}
	// already.txt：主根已包含 → skipped
	if f := byPath["already.txt"]; f.Status != "skipped" {
		t.Fatalf("already.txt 应 skipped：%+v", f)
	}
	// conflict.txt：真冲突 → 不写入
	if f := byPath["conflict.txt"]; f.Status != "conflict" {
		t.Fatalf("conflict.txt 应 conflict：%+v", f)
	}
	if data, _ := os.ReadFile(filepath.Join(dir, "conflict.txt")); string(data) != "main line\n" {
		t.Fatalf("冲突文件不应被写：%q", data)
	}
	// new.txt：新增 → 写入
	if f := byPath["new.txt"]; f.Status != "applied" || f.Deleted {
		t.Fatalf("new.txt 应 applied：%+v", f)
	}
	if data, err := os.ReadFile(filepath.Join(dir, "new.txt")); err != nil || string(data) != "brand new\n" {
		t.Fatalf("new.txt 写回不符：err=%v data=%q", err, data)
	}
	// del.txt：theirs 删除 → 主根同步删除
	if f := byPath["del.txt"]; f.Status != "applied" || !f.Deleted {
		t.Fatalf("del.txt 应同步删除：%+v", f)
	}
	if _, err := os.Stat(filepath.Join(dir, "del.txt")); !os.IsNotExist(err) {
		t.Fatal("主根 del.txt 应已删除")
	}
	// 越界路径拒绝
	if f := byPath["../outside.txt"]; f.Status != "failed" || !strings.Contains(f.Reason, "路径越界") {
		t.Fatalf("越界路径应 failed：%+v", f)
	}
	// 未选中的 keep.txt 不动
	if data, _ := os.ReadFile(filepath.Join(dir, "keep.txt")); string(data) != "main keep\n" {
		t.Fatal("未选中文件不应被写")
	}
	// index 与 HEAD 不动（应用是纯工作区写入）
	if head := strings.TrimSpace(gitTestCmd(t, dir, "rev-parse", "HEAD")); head != baseSha {
		t.Fatalf("应用后主根 HEAD 变了：%q vs %q", head, baseSha)
	}
	if staged := gitTestCmd(t, dir, "diff", "--cached", "--name-only"); strings.TrimSpace(staged) != "" {
		t.Fatalf("应用后 index 有暂存内容：%q", staged)
	}
	if res.Applied != 3 { // a.txt + new.txt + del.txt
		t.Fatalf("applied 计数 = %d", res.Applied)
	}
	if res.Skipped != 1 { // already.txt
		t.Fatalf("skipped 计数 = %d", res.Skipped)
	}
	if !strings.Contains(res.Message, "冲突") {
		t.Fatalf("应有冲突汇总消息：%q", res.Message)
	}
}

// TestWorktreeSnapshotPatchAndDiffSince：保底快照落盘 + 单文件 diff 封顶。
func TestWorktreeSnapshotPatchAndDiffSince(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git")
	}
	if !gitVersionAtLeast(mergeTreeMinMajor, mergeTreeMinMinor) {
		t.Skip("git 版本过低，跳过")
	}
	dir := worktreeTestRepo(t)
	big := ""
	for i := 0; i < 500; i++ {
		big += "line" + strconv.Itoa(i) + "\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("b1\nb2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", "-A")
	gitTestCmd(t, dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base2")
	added, err := WorktreeAdd(dir, "snap patch", "session-abcdef1234", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(added.Path, "draft.txt"), []byte("draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 无改动路径
	if _, err := os.Stat(filepath.Join(added.Path, "base.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("b1\nb2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 有改动：快照落盘且 PatchSave 语义无关（直接写文件）
	path, err := WorktreeSnapshotPatch(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(path, ".cadt/patches/worktree-snapshot-") {
		t.Fatalf("快照路径不符：%s", path)
	}
	data, rerr := os.ReadFile(filepath.FromSlash(path))
	if rerr != nil {
		t.Fatal(rerr)
	}
	if !strings.Contains(string(data), "draft.txt") {
		t.Fatalf("快照不含草稿文件：\n%s", data)
	}
	// 无改动时报 ErrWorktreeNoChanges
	if err := os.WriteFile(filepath.Join(added.Path, "draft.txt"), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	// draft.txt 改为空（与 base 无差异？base 没有 draft.txt——删除未跟踪文件后无改动）
	_ = os.Remove(filepath.Join(added.Path, "draft.txt"))
	if _, err := WorktreeSnapshotPatch(dir, added.Name, added.BaseSha); !errors.Is(err, ErrWorktreeNoChanges) {
		t.Fatalf("无改动应返回 ErrWorktreeNoChanges：%v", err)
	}
	// DiffSinceBase：单文件 diff + 截断
	if err := os.WriteFile(filepath.Join(dir, "base.txt"), []byte("b1\nb2\nb3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	d, err := WorktreeDiffSinceBase(dir, added.BaseSha, "base.txt", 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d, "+b3") {
		t.Fatalf("diff 缺改动行：%s", d)
	}
	if _, err := WorktreeDiffSinceBase(dir, added.BaseSha, "../outside", 0); err == nil {
		t.Fatal("越界路径应报错")
	}
	if _, err := WorktreeDiffSinceBase(dir, added.BaseSha, "/abs/path", 0); err == nil {
		t.Fatal("绝对路径应报错")
	}
	// 截断：把 500 行全部改写，产生上千行的 diff
	modified := ""
	for i := 0; i < 500; i++ {
		modified += "xline" + strconv.Itoa(i) + "\n"
	}
	if err := os.WriteFile(filepath.Join(dir, "big.txt"), []byte(modified), 0o644); err != nil {
		t.Fatal(err)
	}
	d2, err := WorktreeDiffSinceBase(dir, added.BaseSha, "big.txt", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d2, "已截断") || strings.Count(d2, "\n") > 12 {
		t.Fatalf("截断未生效：%d 行", strings.Count(d2, "\n"))
	}
}
