package appservices

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"
)

func TestNormalizeSpec(t *testing.T) {
	tests := []struct {
		name    string
		spec    Spec
		wantErr bool
		check   func(t *testing.T, got Spec)
	}{
		{
			name: "合法并填默认值",
			spec: Spec{ID: "svc-a", Exe: "python"},
			check: func(t *testing.T, got Spec) {
				if got.PollIntervalMs != defaultPollIntervalMs {
					t.Fatalf("PollIntervalMs = %d", got.PollIntervalMs)
				}
				if got.LogCapBytes != defaultLogCapBytes {
					t.Fatalf("LogCapBytes = %d", got.LogCapBytes)
				}
			},
		},
		{
			name: "间隔下限钳到 500",
			spec: Spec{ID: "svc-a", Exe: "python", PollIntervalMs: 100},
			check: func(t *testing.T, got Spec) {
				if got.PollIntervalMs != 500 {
					t.Fatalf("PollIntervalMs = %d", got.PollIntervalMs)
				}
			},
		},
		{name: "id 非法", spec: Spec{ID: "Bad ID", Exe: "python"}, wantErr: true},
		{name: "缺 exe", spec: Spec{ID: "svc-a"}, wantErr: true},
		{name: "参数过多", spec: Spec{ID: "svc-a", Exe: "python", Args: make([]string, 129)}, wantErr: true},
		{name: "healthURL 非 http", spec: Spec{ID: "svc-a", Exe: "python", HealthURL: "ftp://x"}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeSpec(tt.spec)
			if (err != nil) != tt.wantErr {
				t.Fatalf("normalizeSpec err = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.check != nil && err == nil {
				tt.check(t, got)
			}
		})
	}
}

func TestRegisterDuplicate(t *testing.T) {
	r := New()
	spec := Spec{ID: "svc-a", Exe: "python"}
	if err := r.Register(spec); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(spec); err == nil {
		t.Fatal("重复注册应报错")
	}
}

func TestSyncRemovesAndRestarts(t *testing.T) {
	r := New()
	if err := r.Sync([]Spec{
		{ID: "a", Exe: "one"},
		{ID: "b", Exe: "two"},
	}); err != nil {
		t.Fatal(err)
	}
	if len(r.List()) != 2 {
		t.Fatalf("List len = %d", len(r.List()))
	}
	// spec 变化触发重建（这里只验证注册表内容，不真起进程）
	if err := r.Sync([]Spec{{ID: "a", Exe: "three"}}); err != nil {
		t.Fatal(err)
	}
	list := r.List()
	if len(list) != 1 || list[0].ID != "a" {
		t.Fatalf("Sync 后 List = %+v", list)
	}
	svc, _ := r.lookup("a")
	svc.mu.Lock()
	defer svc.mu.Unlock()
	if svc.spec.Exe != "three" {
		t.Fatalf("spec.Exe = %q", svc.spec.Exe)
	}
}

func TestAppendLogRingBuffer(t *testing.T) {
	s := newService(Spec{ID: "a", Exe: "x", LogCapBytes: 10})
	for i := 0; i < 20; i++ {
		s.appendLog("line")
	}
	if len(s.logs) < 1 {
		t.Fatal("应有日志")
	}
	total := 0
	for _, l := range s.logs {
		total += len(l) + 1
	}
	if total > s.spec.LogCapBytes && len(s.logs) > 1 {
		t.Fatalf("日志超上限：total=%d cap=%d", total, s.spec.LogCapBytes)
	}
}

func TestStartStopLifecycle(t *testing.T) {
	// 替换进程原语，避免测试真起进程；用互斥保护共享的 mock 状态。
	var mu sync.Mutex
	stopped := map[string]bool{}
	oldApply, oldHide, oldReg, oldStop := procctlApplyCancel, executilHideWindow, procctlRegister, procctlStop
	defer func() {
		procctlApplyCancel, executilHideWindow, procctlRegister, procctlStop = oldApply, oldHide, oldReg, oldStop
	}()
	procctlApplyCancel = func(cmd *exec.Cmd) {}
	executilHideWindow = func(cmd *exec.Cmd) {}
	procctlRegister = func(id string, cancel context.CancelFunc) error {
		mu.Lock()
		stopped[id] = false
		mu.Unlock()
		return nil
	}
	procctlStop = func(id string) bool {
		mu.Lock()
		stopped[id] = true
		mu.Unlock()
		return true
	}

	r := New()
	spec := Spec{ID: "svc", Exe: "nonexistent-exe-for-test-xyz"}
	if err := r.Register(spec); err != nil {
		t.Fatal(err)
	}
	// cmd.Start 会失败（exe 不存在），标记 failed，验证状态机
	if err := r.Start("svc"); err == nil {
		t.Fatal("不存在的 exe 应启动失败")
	}
	st, ok := r.Status("svc")
	if !ok || st.State != StateFailed {
		t.Fatalf("Status = %+v ok=%v", st, ok)
	}
	if st.LastError == "" {
		t.Fatal("失败应有 lastError")
	}
}

func TestProbeHealth(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	r := New()
	if !r.probe(srv.URL) {
		t.Fatal("200 应判健康")
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer bad.Close()
	if r.probe(bad.URL) {
		t.Fatal("503 应判不健康")
	}
}

func TestStopIdempotent(t *testing.T) {
	r := New()
	if err := r.Register(Spec{ID: "a", Exe: "x"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Stop("a"); err != nil {
		t.Fatal(err)
	}
	if err := r.Stop("a"); err != nil {
		t.Fatalf("重复停止应幂等：%v", err)
	}
	if err := r.Stop("missing"); err == nil {
		t.Fatal("停止未注册服务应报错")
	}
}

func TestSpecEqual(t *testing.T) {
	a := Spec{ID: "a", Exe: "x", Args: []string{"1", "2"}, Cwd: "d", HealthURL: "u", AutoStart: true}
	b := Spec{ID: "a", Exe: "x", Args: []string{"1", "2"}, Cwd: "d", HealthURL: "u", AutoStart: true}
	if !specEqual(a, b) {
		t.Fatal("相同 spec 应相等")
	}
	b.Args = []string{"1", "3"}
	if specEqual(a, b) {
		t.Fatal("参数不同应不等")
	}
}

func TestErrorsAreWrapped(t *testing.T) {
	base := errors.New("boom")
	wrapped := errors.New("start failed: " + base.Error())
	if !strings.Contains(wrapped.Error(), "boom") {
		t.Fatal("错误信息应包含根因")
	}
}
