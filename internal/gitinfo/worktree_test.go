package gitinfo

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"datalens/internal/patch"
)

// 临时仓库：main 分支提交 a.txt + .gitignore(.cadt/)，与真实工作区形态对齐。
func worktreeTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	gitTestCmd(t, dir, "init")
	gitTestCmd(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	gitTestCmd(t, dir, "config", "user.email", "test@example.com")
	gitTestCmd(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(".cadt/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestCmd(t, dir, "add", ".gitignore", "a.txt")
	gitTestCmd(t, dir, "commit", "-m", "init")
	return dir
}

func TestDeriveSlug(t *testing.T) {
	cases := []struct {
		label  string
		key    string
		expect string
	}{
		{"refactor parser", "session-abcdef1234", "refactor-parser-cdef1234"}, // id 取末 8 位字母数字
		{"重构 解析器!", "abcdef1234", "wt-cdef1234"},                           // 中文全折成 -，Trim 后只剩 wt
		{"  ", "", "wt"},                                                      // 空 label 且无会话 id
		{"A__B--c", "", "a-b-c"},                                              // 连续非法字符折成单个 -
		{"x", "session-ABCDEF1234xyz", "x-f1234xyz"},                          // 大小写归一
	}
	for _, c := range cases {
		if got := deriveSlug(c.label, c.key); got != c.expect {
			t.Fatalf("deriveSlug(%q,%q) = %q, want %q", c.label, c.key, got, c.expect)
		}
	}
	long := deriveSlug(strings.Repeat("ab", 40), "session-abcdef1234")
	if len(long) > 32+len("-")+8 || !worktreeSlugRe.MatchString(long) {
		t.Fatalf("长 label 派生的 slug 不合白名单：%q", long)
	}
}

func TestWorktreeLifecycleAndDiff(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)

	// add：slug 派生 + 目录 + 分支
	added, err := WorktreeAdd(dir, "Refactor Parser", "session-abcdef1234")
	if err != nil {
		t.Fatal(err)
	}
	if added.Name != "refactor-parser-cdef1234" {
		t.Fatalf("slug = %q", added.Name)
	}
	if !worktreeSlugRe.MatchString(added.Name) || added.Branch != "cadt/wt/"+added.Name {
		t.Fatalf("add result = %#v", added)
	}
	if info, err := os.Stat(added.Path); err != nil || !info.IsDir() {
		t.Fatalf("worktree 目录不存在：%s", added.Path)
	}
	if len(added.BaseSha) != 40 {
		t.Fatalf("baseSha = %q", added.BaseSha)
	}
	// worktree 内不含 .cadt（被忽略）——不递归嵌套的前提
	if _, err := os.Stat(filepath.Join(added.Path, ".cadt")); !os.IsNotExist(err) {
		t.Fatal("worktree 检出不应包含 .cadt/")
	}

	// list：UnderCadt 标记与分支解析
	list, err := WorktreeList(dir)
	if err != nil || !list.Available {
		t.Fatalf("list = %#v err=%v", list, err)
	}
	var wt *GitWorktreeInfo
	for i := range list.Items {
		if list.Items[i].UnderCadt {
			wt = &list.Items[i]
		}
	}
	if wt == nil || wt.Branch != "cadt/wt/"+added.Name || wt.RelPath != ".cadt/worktree/"+added.Name {
		t.Fatalf("list items = %#v", list.Items)
	}

	// 隔离性：主根与 worktree 各改一个文件互不影响
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("main edit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(added.Path, "new.txt"), []byte("hello\nworld\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(added.Path, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(added.Path, "sub", "deep.txt"), []byte("deep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// worktree 内删除 a.txt（基准里有）→ diff 应含删除段
	if err := os.Remove(filepath.Join(added.Path, "a.txt")); err != nil {
		t.Fatal(err)
	}

	// 空 diff：新创建、没改动的 worktree 导出报哨兵错误
	fresh, err := WorktreeAdd(dir, "fresh", "session-abcdef1234")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := WorktreeDiff(dir, fresh.Name, fresh.BaseSha); !errors.Is(err, ErrWorktreeNoChanges) {
		t.Fatalf("空 worktree 应报 ErrWorktreeNoChanges，got %v", err)
	}
	if err := WorktreeRemove(dir, fresh.Name, true); err != nil {
		t.Fatal(err)
	}

	// diff：修改 + 删除 + 新文件（含未跟踪）都在，主根改动不在
	diff, err := WorktreeDiff(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"+++ b/new.txt", "+hello", "+++ b/sub/deep.txt", "+++ /dev/null", "--- a/a.txt"} {
		if !strings.Contains(diff, want) {
			t.Fatalf("diff 缺少 %q：\n%s", want, diff)
		}
	}
	if strings.Contains(diff, "main edit") {
		t.Fatal("主根的改动不应出现在 worktree diff 里")
	}
	// rename 检测已禁用：不应出现 rename 头
	if strings.Contains(diff, "rename from") {
		t.Fatal("diff 不应含 rename 段（--no-renames）")
	}

	// 导出的 diff 必须能被 internal/patch 解析（回灌管线的前提）
	if _, err := patch.ParsePatchText(diff); err != nil {
		t.Fatalf("patch 引擎无法解析 worktree diff：%v\n%s", err, diff)
	}

	// baseSha 校验
	if _, err := WorktreeDiff(dir, added.Name, "not-a-sha"); err == nil {
		t.Fatal("非法 baseSha 应报错")
	}
	if _, err := WorktreeDiff(dir, "../escape", added.BaseSha); err == nil {
		t.Fatal("路径穿越名应报错")
	}

	// remove（含删分支）→ list 与 show-ref 双确认
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".cadt", "worktree", added.Name)); !os.IsNotExist(err) {
		t.Fatal("worktree 目录应已删除")
	}
	list, err = WorktreeList(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.UnderCadt {
			t.Fatalf("list 仍含隔离 worktree：%#v", item)
		}
	}
	if gitBranchRefExists(dir, "refs/heads/cadt/wt/"+added.Name) {
		t.Fatal("隔离分支应已删除")
	}
}

func TestWorktreeAddConflictSuffix(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	first, err := WorktreeAdd(dir, "demo", "session-abcdef1234")
	if err != nil {
		t.Fatal(err)
	}
	// 同 label + 同会话 id 再建：slug 冲突自动换 -2 后缀
	second, err := WorktreeAdd(dir, "demo", "session-abcdef1234")
	if err != nil {
		t.Fatal(err)
	}
	if second.Name != first.Name+"-2" {
		t.Fatalf("conflict slug = %q, want %q", second.Name, first.Name+"-2")
	}
	if err := WorktreeRemove(dir, first.Name, true); err != nil {
		t.Fatal(err)
	}
	if err := WorktreeRemove(dir, second.Name, true); err != nil {
		t.Fatal(err)
	}
}

// 依赖目录 junction：主根的 node_modules / .venv / venv 自动共享进 worktree；共享是
// 双向的（worktree 里装依赖写的就是主根目录）；删除 worktree 绝不伤主根依赖。
func TestWorktreeJunctionDeps(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	if err := os.MkdirAll(filepath.Join(dir, "node_modules", "pkg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "node_modules", "pkg", "index.js"), []byte("shared\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".venv"), 0o755); err != nil {
		t.Fatal(err)
	}
	// 不在白名单里的目录不共享（vendor 通常被 git 跟踪）
	if err := os.MkdirAll(filepath.Join(dir, "vendor"), 0o755); err != nil {
		t.Fatal(err)
	}

	added, err := WorktreeAdd(dir, "deps", "session-abcdef1234")
	if err != nil {
		t.Fatal(err)
	}
	if len(added.Deps) != 2 {
		t.Fatalf("deps = %#v, want [node_modules .venv]", added.Deps)
	}
	wtNM := filepath.Join(added.Path, "node_modules")
	if !isReparsePoint(wtNM) {
		t.Fatal("worktree node_modules 应是 junction")
	}
	// 经 junction 可读主根内容
	raw, err := os.ReadFile(filepath.Join(wtNM, "pkg", "index.js"))
	if err != nil || string(raw) != "shared\n" {
		t.Fatalf("junction 读取失败：%v %q", err, raw)
	}
	// 双向：在 worktree 侧写文件，主根可见（依赖状态共享）
	if err := os.WriteFile(filepath.Join(wtNM, "pkg", "new.js"), []byte("via-wt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "pkg", "new.js")); err != nil {
		t.Fatal("经 junction 的写入应落到主根依赖目录")
	}
	// 白名单外不共享
	if _, err := os.Lstat(filepath.Join(added.Path, "vendor")); !os.IsNotExist(err) {
		t.Fatal("vendor 不应被共享")
	}

	// stat：对 junction 内容的修改计入 worktree diff（经共享写主根，同时出现在 worktree 视角）
	if err := os.WriteFile(filepath.Join(added.Path, "a.txt"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	stat, err := WorktreeStat(dir, added.Name, added.BaseSha)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stat, "a.txt") {
		t.Fatalf("stat 应含 a.txt：\n%s", stat)
	}

	// 删除：主根依赖完好无损（junction 只摘 reparse 点）
	if err := WorktreeRemove(dir, added.Name, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "pkg", "index.js")); err != nil {
		t.Fatal("删除 worktree 不得影响主根依赖目录")
	}
	if _, err := os.Stat(filepath.Join(dir, "node_modules", "pkg", "new.js")); err != nil {
		t.Fatal("主根依赖内容不得被连带删除")
	}
	if isReparsePoint(filepath.Join(dir, "node_modules")) {
		t.Fatal("主根 node_modules 不应是 reparse 点")
	}
}

func TestWorktreePrune(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过 worktree 集成测试")
	}
	dir := worktreeTestRepo(t)
	added, err := WorktreeAdd(dir, "orphan", "session-abcdef1234")
	if err != nil {
		t.Fatal(err)
	}
	// 手动删目录（模拟用户直接删盘）：git 侧记录残留
	if err := os.RemoveAll(added.Path); err != nil {
		t.Fatal(err)
	}
	list, err := WorktreeList(dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range list.Items {
		if item.UnderCadt {
			found = true
		}
	}
	if !found {
		t.Fatal("prune 前 git 侧应仍登记该 worktree")
	}
	if err := WorktreePrune(dir); err != nil {
		t.Fatal(err)
	}
	list, err = WorktreeList(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.UnderCadt {
			t.Fatalf("prune 后仍登记失效 worktree：%#v", item)
		}
	}
	if err := WorktreeRemove(dir, added.Name, true); err == nil {
		t.Fatal("prune 后目录不存在，remove 应报错")
	}
	if err := WorktreePrune(dir); err != nil {
		t.Fatal(err)
	}
}

func TestWorktreeListNotInRepo(t *testing.T) {
	dir := t.TempDir()
	list, err := WorktreeList(dir)
	if err != nil || list.Available || list.Reason == "" {
		t.Fatalf("非仓库目录应优雅降级：%#v err=%v", list, err)
	}
	if _, err := WorktreeAdd(dir, "x", "session-abcdef1234"); err == nil {
		t.Fatal("非仓库目录 add 应报错")
	}
}
