package appservices

// 进程启停的真实路径测试。service_test.go 会把 procctlApplyCancel / procctlRegister 等
// 进程原语整体 mock 掉，于是漏掉了「cmd.Cancel 必须由 CommandContext 创建」这类只在真起
// 进程时才暴露的回归（症状：启动服务失败：exec: command with a non-nil Cancel was not
// created with CommandContext）。这里用测试二进制自身当子进程，零外部依赖、毫秒级退出。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	helperEnv    = "APPSERVICES_HELPER"
	helperMarker = "appservices-helper-ok"
)

// TestMain 复用测试二进制充当 helper 子进程：环境变量命中时直接打印标记并退出，
// 不进入 m.Run()，因此不会递归启动测试。
func TestMain(m *testing.M) {
	if os.Getenv(helperEnv) == "1" {
		_, _ = os.Stdout.WriteString(helperMarker + "\n")
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// TestStartRealProcess 走真实 exec 路径启动一个进程并收齐它的输出。
func TestStartRealProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("取测试二进制路径失败：%v", err)
	}
	t.Setenv(helperEnv, "1")

	r := New()
	if err := r.Register(Spec{ID: "helper", Exe: exe}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.StopAll)
	if err := r.Start("helper"); err != nil {
		t.Fatalf("启动真实进程失败：%v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		if strings.Contains(strings.Join(r.Logs("helper"), "\n"), helperMarker) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("未收到 helper 输出，当前日志：%v", r.Logs("helper"))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestStartMissingCwdFails 工作目录不存在时要在起进程之前给出可读原因，
// 而不是把 Windows 的 "The directory name is invalid" 抛给用户。
func TestStartMissingCwdFails(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "no-such-dir")
	r := New()
	if err := r.Register(Spec{ID: "svc", Exe: "python", Cwd: missing}); err != nil {
		t.Fatal(err)
	}
	err := r.Start("svc")
	if err == nil {
		t.Fatal("工作目录不存在时应启动失败")
	}
	if !strings.Contains(err.Error(), "工作目录") || !strings.Contains(err.Error(), missing) {
		t.Fatalf("错误信息应指明缺失的目录：%v", err)
	}
	st, ok := r.Status("svc")
	if !ok || st.State != StateFailed || st.LastError == "" {
		t.Fatalf("Status = %+v ok=%v", st, ok)
	}
}

// TestStartCwdIsFileFails 工作目录指向文件时同样提前拦住。
func TestStartCwdIsFileFails(t *testing.T) {
	file := filepath.Join(t.TempDir(), "not-a-dir.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := New()
	if err := r.Register(Spec{ID: "svc", Exe: "python", Cwd: file}); err != nil {
		t.Fatal(err)
	}
	err := r.Start("svc")
	if err == nil || !strings.Contains(err.Error(), "不是目录") {
		t.Fatalf("应报工作目录不是目录：%v", err)
	}
}
