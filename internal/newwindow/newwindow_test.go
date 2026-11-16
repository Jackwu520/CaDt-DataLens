package newwindow

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateDir(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		dir  string
		ok   bool
	}{
		{"空白", "  ", false},
		{"文件", file, false},
		{"不存在", filepath.Join(dir, "missing"), false},
		{"目录", " " + dir + " ", true},
	}
	for _, c := range cases {
		got, err := validateDir(c.dir)
		if c.ok && err != nil {
			t.Fatalf("%s: 意外错误 %v", c.name, err)
		}
		if !c.ok && err == nil {
			t.Fatalf("%s: 应报错", c.name)
		}
		if c.ok && got != dir {
			t.Fatalf("%s: 应返回去空白后的路径 %q，得到 %q", c.name, dir, got)
		}
	}
}

// 空输入必须在拉进程之前被拒绝，避免测试真的开出窗口。
func TestOpenFilesRejectsEmpty(t *testing.T) {
	if _, err := OpenFiles(nil); err == nil {
		t.Fatal("空列表应报错")
	}
	if _, err := OpenFiles([]string{"", "   "}); err == nil {
		t.Fatal("全空白路径应报错")
	}
}

func TestOpenDirRejectsInvalidBeforeSpawn(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := OpenDir(""); err == nil {
		t.Fatal("空目录应报错")
	}
	if err := OpenDir(file); err == nil {
		t.Fatal("文件路径应报错")
	}
	if err := OpenDir(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("不存在的目录应报错")
	}
	if err := OpenWorkspaceConversation("", "s1"); err == nil {
		t.Fatal("空目录应报错")
	}
}
