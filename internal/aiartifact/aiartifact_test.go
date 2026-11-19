package aiartifact

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteAndClear(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	path, err := Write("session-abc123", "call-1", "hello 工具结果")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filepath.ToSlash(path), filepath.ToSlash(Root())+"/session-abc123/") {
		t.Fatalf("落盘路径应在会话目录下：%s", path)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "hello 工具结果" {
		t.Fatalf("内容 = %q, %v", string(raw), err)
	}
	if err := ClearSession("session-abc123"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
		t.Fatalf("会话目录应被删除：%v", err)
	}
}

// 会话 id 与产物名只接受安全字符：不许 ".."、分隔符、盘符把写入引到目录外。
func TestWriteRejectsTraversal(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	for _, id := range []string{"", "..", "../x", "a/b", `a\b`, "con:1"} {
		if _, err := Write(id, "call-1", "x"); err == nil {
			t.Fatalf("会话 id %q 应被拒绝", id)
		}
	}
	for _, name := range []string{"", "..", "a/b", `a\b`} {
		if _, err := Write("session-1", name, "x"); err == nil {
			t.Fatalf("产物名 %q 应被拒绝", name)
		}
	}
}

func TestWriteRejectsOversize(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	big := strings.Repeat("x", MaxBytes+1)
	if _, err := Write("session-1", "call-1", big); err != ErrTooLarge {
		t.Fatalf("超限应返回 ErrTooLarge，得到 %v", err)
	}
}

func TestClearSessionMissingIsNoop(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	if err := ClearSession("session-never-created"); err != nil {
		t.Fatalf("删除不存在的会话目录不应报错：%v", err)
	}
	if err := ClearSession(""); err != nil {
		t.Fatalf("空 id 不应报错：%v", err)
	}
}

// 读回：写到读的往返、缺文件返回空串（重启后 UI 靠它判断「没有可显示的转录」）。
func TestReadRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	content := `{"role":"assistant","name":"","text":"开始"}` + "\n" + `{"role":"tool","name":"read_file","text":"结果"}`
	if _, err := Write("session-abc", "sub-agent1", content); err != nil {
		t.Fatal(err)
	}
	got, err := Read("session-abc", "sub-agent1")
	if err != nil {
		t.Fatalf("读回应成功：%v", err)
	}
	if got != content {
		t.Fatalf("读回 = %q", got)
	}
	// 不存在 / 非法入参
	if text, err := Read("session-abc", "sub-missing"); err != nil || text != "" {
		t.Fatalf("缺失文件应返回空串：%q, %v", text, err)
	}
	if _, err := Read("../x", "sub-1"); err == nil {
		t.Fatal("非法会话 id 应报错")
	}
	if _, err := Read("session-abc", ".."); err == nil {
		t.Fatal("非法产物名应报错")
	}
}
