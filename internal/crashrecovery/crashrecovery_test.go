package crashrecovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// withDeadProbe / withLiveProbe 替换存活探针（defer 恢复）。
func withDeadProbe(t *testing.T) {
	t.Helper()
	processAliveFn = func(int) bool { return false }
	t.Cleanup(func() { processAliveFn = processAlive })
}

func TestTakeAbandonedDeadOwner(t *testing.T) {
	withDeadProbe(t)
	dir := t.TempDir()
	if err := markAliveAt(dir, "main", "logs/x.txt"); err != nil {
		t.Fatal(err)
	}
	m, crashed := takeAbandonedAt(dir)
	if !crashed || m == nil {
		t.Fatal("属主已死的标记应被取走")
	}
	if m.Mode != "main" || m.Log != "logs/x.txt" || m.PID != os.Getpid() {
		t.Fatalf("标记内容不符：%+v", m)
	}
	// 取走 = 文件已删
	entries, _ := os.ReadDir(filepath.Join(dir, markerDirName))
	if len(entries) != 0 {
		t.Fatalf("取走后目录应清空，剩 %d 项", len(entries))
	}
	// 再取一次：没有更多遗留
	if _, crashed := takeAbandonedAt(dir); crashed {
		t.Fatal("不应重复取走")
	}
}

func TestTakeAbandonedLiveOwnerKept(t *testing.T) {
	dir := t.TempDir()
	if err := markAliveAt(dir, "main", ""); err != nil {
		t.Fatal(err)
	}
	// 属主（本测试进程）还活着：另一实例在跑，标记必须保留
	m, crashed := takeAbandonedAt(dir)
	if crashed || m != nil {
		t.Fatalf("属主活着的标记不应被取走：%+v", m)
	}
	entries, err := os.ReadDir(filepath.Join(dir, markerDirName))
	if err != nil || len(entries) != 1 {
		t.Fatalf("标记文件应保留（err=%v，剩 %d 项）", err, len(entries))
	}
}

func TestMarkExitedRemovesOnlyOwn(t *testing.T) {
	dir := t.TempDir()
	if err := markAliveAt(dir, "main", ""); err != nil {
		t.Fatal(err)
	}
	// 手工放一个「别人」的标记（不同 pid + 不同 startedAt）
	foreign := filepath.Join(dir, markerDirName, "pid-999999-111.json")
	_ = os.WriteFile(foreign, []byte(`{"pid":999999,"startedAt":"2000-01-01T00:00:00Z","mode":"main"}`), 0o644)

	markExitedAt(dir, ownSession.pid, ownSession.startedAt)
	entries, _ := os.ReadDir(filepath.Join(dir, markerDirName))
	if len(entries) != 1 {
		t.Fatalf("只应剩别人的标记，剩 %d 项", len(entries))
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatal("别人的标记不应被摘除")
	}
}

func TestTakeAbandonedCorruptMarker(t *testing.T) {
	withDeadProbe(t)
	dir := t.TempDir()
	d := filepath.Join(dir, markerDirName)
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
	// 刚写下的残缺文件：留给写它的进程，不判垃圾
	fresh := filepath.Join(d, "pid-1-1.json")
	_ = os.WriteFile(fresh, []byte("{oops"), 0o644)
	if m, crashed := takeAbandonedAt(dir); crashed || m != nil {
		t.Fatal("新鲜的残缺标记不应被取走")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("新鲜的残缺标记不应被删")
	}
	// 老化的残缺文件：顺手清掉，避免永久堆积
	old := time.Now().Add(-2 * markerFreshWindow)
	if err := os.Chtimes(fresh, old, old); err != nil {
		t.Fatal(err)
	}
	if _, crashed := takeAbandonedAt(dir); crashed {
		t.Fatal("残缺标记不是崩溃证据，不应返回会话")
	}
	if _, err := os.Stat(fresh); !os.IsNotExist(err) {
		t.Fatal("老化的残缺标记应被清掉")
	}
}

func TestTakeAbandonedEmptyRoot(t *testing.T) {
	if m, crashed := takeAbandonedAt(""); crashed || m != nil {
		t.Fatal("空根应安全 no-op")
	}
}

func TestMarkerJSONRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := markAliveAt(dir, "float", ""); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, markerDirName))
	if len(entries) != 1 {
		t.Fatalf("应恰好一个标记文件，实得 %d", len(entries))
	}
	data, err := os.ReadFile(filepath.Join(dir, markerDirName, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var m Marker
	if json.Unmarshal(data, &m) != nil || m.Mode != "float" || m.PID != os.Getpid() {
		t.Fatalf("标记内容不符：%s", data)
	}
	if entries[0].Name() == "" || filepath.Ext(entries[0].Name()) != ".json" {
		t.Fatalf("文件名形态不对：%s", entries[0].Name())
	}
}
