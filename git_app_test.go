package main

// 根目录保留的 Git 浅集成测试（插件测试已随 internal/plugins 下沉）。

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestGitRollbackForReal 在隔离的临时仓库里验证回滚：已跟踪还原到 HEAD、
// 未跟踪删除、路径穿越拒绝。
//
// 2026-11-19 修正：原实现在本仓库真实工作区里改文件再 checkout——两个
// go test 实例并发（如 rebuild-exe.ps1 的测试门与手动全量测试同时跑）会互踩：
// A 写入 "// modified" 后 B 把它读成 orig，B 回滚到 HEAD 再比较必然不等；
// 且 defer 的 git checkout 会丢弃用户对该示例文件的未提交修改。
// 临时仓库走的是同一套 RollbackFor 代码路径，语义等价且零破坏。
func TestGitRollbackForReal(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("未安装 git，跳过回滚集成测试")
	}
	dir := t.TempDir()
	gitTestRun := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v 失败：%v\n%s", args, err, out)
		}
	}
	gitTestRun("init")
	gitTestRun("symbolic-ref", "HEAD", "refs/heads/main")
	gitTestRun("config", "user.email", "test@example.com")
	gitTestRun("config", "user.name", "Test")
	// 本机全局 git 可能开着 core.autocrlf：checkout 会把 LF 转成 CRLF，
	// 字节比较随之失败。仓库内显式关掉，测试结果不依赖机器 git 配置。
	gitTestRun("config", "core.autocrlf", "false")

	target := filepath.Join(dir, "main.js")
	orig := []byte("// original\n")
	if err := os.WriteFile(target, orig, 0o644); err != nil {
		t.Fatal(err)
	}
	gitTestRun("add", "main.js")
	gitTestRun("commit", "-m", "init")

	// 修改后回滚
	if err := os.WriteFile(target, []byte("// modified"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := NewApp().GitRollbackFor(dir, []string{"main.js"}, nil); err != nil {
		t.Fatalf("回滚失败: %v", err)
	}
	after, _ := os.ReadFile(target)
	// 行尾归一后比较：即便仓库配置漏网（autocrlf），也不把 CRLF/LF 差异算成回滚失败。
	if strings.ReplaceAll(string(after), "\r\n", "\n") != strings.ReplaceAll(string(orig), "\r\n", "\n") {
		t.Fatalf("回滚后内容未还原：%q", string(after))
	}

	// 未跟踪文件直接删除
	untracked := filepath.Join(dir, "new.txt")
	if err := os.WriteFile(untracked, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := NewApp().GitRollbackFor(dir, nil, []string{"new.txt"}); err != nil {
		t.Fatalf("未跟踪删除失败: %v", err)
	}
	if _, err := os.Stat(untracked); !os.IsNotExist(err) {
		t.Fatal("未跟踪文件应被删除")
	}

	// 路径穿越拒绝
	if err := NewApp().GitRollbackFor(dir, []string{".." + string(filepath.Separator) + ".." + string(filepath.Separator) + "go.mod"}, nil); err == nil {
		t.Fatal("路径穿越应被拒绝")
	}
}

func TestGitFileHistoryAndRecentLog(t *testing.T) {
	out, err := NewApp().GitFileHistoryFor(".", "frontend/src/main.js", 10)
	if err != nil {
		t.Fatalf("文件历史: %v", err)
	}
	if out == "" {
		t.Fatal("main.js 有提交历史，输出不应为空")
	}
	log, err := NewApp().GitRecentLogFor(".", 5)
	if err != nil {
		t.Fatalf("最近提交: %v", err)
	}
	if strings.Count(log, "\n") < 1 {
		t.Fatalf("最近提交应有多条: %q", log)
	}
}
