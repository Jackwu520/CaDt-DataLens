package main

// 根目录保留的 Git 浅集成测试（插件测试已随 internal/plugins 下沉）。

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitRollbackForReal(t *testing.T) {
	// 在本仓库里做真实回滚测试
	target := filepath.Join("docs", "plugins", "examples", "bak-json", "main.js")
	orig, err := os.ReadFile(target)
	if err != nil {
		t.Skip("示例文件不存在")
	}
	defer func() {
		_ = os.WriteFile(target, orig, 0o644)
		_ = exec.Command("git", "checkout", "HEAD", "--", target).Run()
	}()

	// 修改后回滚
	if err := os.WriteFile(target, []byte("// modified"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := NewApp().GitRollbackFor(".", []string{target}, nil); err != nil {
		t.Fatalf("回滚失败: %v", err)
	}
	after, _ := os.ReadFile(target)
	if string(after) != string(orig) {
		t.Fatal("回滚后内容未还原")
	}

	// 路径穿越拒绝
	if err := NewApp().GitRollbackFor(".", []string{".." + string(filepath.Separator) + ".." + string(filepath.Separator) + "go.mod"}, nil); err == nil {
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