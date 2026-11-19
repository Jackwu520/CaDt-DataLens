package windowreg

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"datalens/internal/resourcelease"
)

// 子进程 helper 模式：WINDOWREG_HELPER_MODE 非空时 TestMain 直接转入 helper，
// 不跑任何测试（防子进程递归跑全量测试，教训见 AGENTS.md）。
func TestMain(m *testing.M) {
	if os.Getenv("WINDOWREG_HELPER_MODE") != "" {
		runHelper(os.Getenv("WINDOWREG_HELPER_MODE"))
		return
	}
	os.Exit(m.Run())
}

// runHelper 是跨进程测试的子进程入口：hold-lease 持锁到 stdin EOF（模拟活窗口），
// worker 注册后循环 take 并按指定状态 ack，idle 注册后不消费（模拟卡死窗口）。
func runHelper(mode string) {
	switch mode {
	case "hold-lease":
		leasePath := os.Getenv("WINDOWREG_HELPER_LEASE")
		if leasePath == "" {
			os.Exit(3)
		}
		lease, err := resourcelease.Acquire(leasePath, resourcelease.Owner{Label: "windowreg-helper"})
		if err != nil {
			os.Exit(4)
		}
		defer lease.Release()
		// 父进程关闭 stdin 写端 = EOF，helper 退出。
		_, _ = io.Copy(io.Discard, bufio.NewReader(os.Stdin))
		os.Exit(0)
	case "worker", "idle", "take-no-ack", "take-silent":
		root := os.Getenv("WINDOWREG_HELPER_ROOT")
		windowID := os.Getenv("WINDOWREG_HELPER_WID")
		workspace := os.Getenv("WINDOWREG_HELPER_WS")
		if root == "" || windowID == "" {
			os.Exit(3)
		}
		reg, err := Register(root, Entry{WindowID: windowID, Workspace: workspace})
		if err != nil {
			os.Exit(4)
		}
		defer reg.Close()
		done := make(chan struct{})
		go func() {
			_, _ = io.Copy(io.Discard, bufio.NewReader(os.Stdin))
			close(done)
		}()
		if mode == "take-no-ack" {
			// 拿到请求立即退出（os.Exit 跳过 defer：目录残留，但租约随进程释放，
			// alive 判定依然正确）——模拟「接管后目标死亡」的 deliverOne ENOENT 分支。
			for {
				req, takeErr := reg.Take()
				if takeErr == nil && req != nil {
					os.Exit(0)
				}
				select {
				case <-done:
					os.Exit(0)
				case <-time.After(30 * time.Millisecond):
				}
			}
		}
		if mode == "take-silent" {
			// 拿到请求后保持存活、永不 ack——模拟「接管了但迟迟不回执」的信任分支。
			for {
				req, takeErr := reg.Take()
				if takeErr == nil && req != nil {
					break
				}
				select {
				case <-done:
					os.Exit(0)
				case <-time.After(30 * time.Millisecond):
				}
			}
			_, _ = io.Copy(io.Discard, bufio.NewReader(os.Stdin)) // 父进程关 stdin 即退出
			os.Exit(0)
		}
		for {
			if mode == "worker" {
				req, takeErr := reg.Take()
				if takeErr == nil && req != nil {
					_ = reg.Ack(req.ReqID, os.Getenv("WINDOWREG_HELPER_ACK"))
					os.Exit(0)
				}
			}
			select {
			case <-done:
				os.Exit(0)
			case <-time.After(30 * time.Millisecond):
			}
		}
	default:
		os.Exit(5)
	}
}

// startHelper 启动 helper 子进程并等待其注册完成（lease 被占 + meta 落盘），
// 返回关闭函数与其注册表根目录（主进程 Deliver 用同一个根）。
func startHelper(t *testing.T, mode, windowID, workspace, ackStatus string) (close func(), root string) {
	t.Helper()
	root = t.TempDir()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(),
		"WINDOWREG_HELPER_MODE="+mode,
		"WINDOWREG_HELPER_ROOT="+root,
		"WINDOWREG_HELPER_WID="+windowID,
		"WINDOWREG_HELPER_WS="+workspace,
		"WINDOWREG_HELPER_ACK="+ackStatus,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe 失败: %v", err)
	}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatalf("helper 子进程启动失败: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	leasePath := filepath.Join(root, windowID+".lease")
	metaPath := filepath.Join(root, windowID, "meta.json")
	for {
		_, occupied, probeErr := resourcelease.Probe(leasePath)
		_, metaErr := os.Stat(metaPath)
		if probeErr == nil && occupied && metaErr == nil {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("helper 未在期限内完成注册")
		}
		time.Sleep(25 * time.Millisecond)
	}
	return func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	}, root
}

// startHoldLeaseChild 拉起持锁子进程，轮询到锁被占后返回（close 函数关闭 stdin 让子进程退出）。
func startHoldLeaseChild(t *testing.T, leasePath string) (close func()) {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(),
		"WINDOWREG_HELPER_MODE=hold-lease",
		"WINDOWREG_HELPER_LEASE="+leasePath,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe 失败: %v", err)
	}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatalf("helper 子进程启动失败: %v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		_, occupied, probeErr := resourcelease.Probe(leasePath)
		if probeErr == nil && occupied {
			break
		}
		if time.Now().After(deadline) {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("helper 子进程未在期限内持锁（probe err=%v occupied=%v）", probeErr, occupied)
		}
		time.Sleep(25 * time.Millisecond)
	}
	return func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	}
}

func TestNormalizeWorkspace(t *testing.T) {
	cases := []struct{ in, want string }{
		{"D:\\Foo\\Bar", "d:/foo/bar"},
		{"D:\\Foo\\Bar\\", "d:/foo/bar"},
		{"D:/Foo/Bar///", "d:/foo/bar"},
		{"D:\\中文\\路径", "d:/中文/路径"},
		{"C:\\", "c:"},
		{"", ""},
		{"/mnt/data/", "/mnt/data"},
	}
	for _, c := range cases {
		if got := NormalizeWorkspace(c.in); got != c.want {
			t.Errorf("NormalizeWorkspace(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestReqID(t *testing.T) {
	if !validReqID(newReqID()) {
		t.Fatal("newReqID 产物应通过自身校验")
	}
	if n := len(newReqID()); n != 16 {
		t.Fatalf("newReqID 长度 = %d, want 16", n)
	}
	cases := map[string]bool{
		"0123abcdef":    true,
		"ABC":           false, // 大写拒绝
		"../x":          false, // 路径注入拒绝
		"a/b":           false,
		"a\\b":          false,
		"":              false,
		"000000000000000000000000000000000": false, // 超 32 位
	}
	for s, want := range cases {
		if got := validReqID(s); got != want {
			t.Errorf("validReqID(%q) = %v, want %v", s, got, want)
		}
	}
}

func readMeta(t *testing.T, dir string) Entry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		t.Fatalf("meta.json 读取失败: %v", err)
	}
	var e Entry
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("meta.json 解析失败: %v", err)
	}
	return e
}

func TestRegisterWritesMetaAndHoldsLease(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{Workspace: `D:\Foo\Bar`})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	defer reg.Close()

	if _, err := os.Stat(filepath.Join(reg.dir, "inbox")); err != nil {
		t.Fatalf("inbox 目录未创建: %v", err)
	}
	meta := readMeta(t, reg.dir)
	if meta.WindowID != reg.WindowID() || meta.PID != os.Getpid() {
		t.Fatalf("meta 身份不符: %+v", meta)
	}
	if meta.Workspace != "d:/foo/bar" {
		t.Fatalf("meta workspace 未归一: %q", meta.Workspace)
	}
	if _, occupied, probeErr := resourcelease.Probe(reg.leasePath); probeErr != nil || !occupied {
		t.Fatalf("注册后租约应被本窗口持有（err=%v occupied=%v）", probeErr, occupied)
	}
}

func TestRegisterBusyFailsWithoutDir(t *testing.T) {
	root := t.TempDir()
	// 用 helper 子进程预占 lease，模拟「另一窗口持有同 windowId 租约」：
	// Register 必须 Acquire 失败且**不留目录**（先 lease 后目录的顺序保证）。
	leasePath := filepath.Join(root, "pid-aaaaaaaa.lease")
	closeChild := startHoldLeaseChild(t, leasePath)
	defer closeChild()

	_, err := Register(root, Entry{WindowID: "pid-aaaaaaaa"})
	if err == nil {
		t.Fatal("租约被占时 Register 应失败")
	}
	if _, statErr := os.Stat(filepath.Join(root, "pid-aaaaaaaa")); statErr == nil {
		t.Fatal("Register 失败后不应留下窗口目录（顺序断言：先 lease 后目录）")
	}
}

func TestUpdateAndTouch(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{Workspace: ""})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	defer reg.Close()

	before := readMeta(t, reg.dir).Heartbeat
	time.Sleep(5 * time.Millisecond)
	if err := reg.Update(`E:\Work\Stuff\`); err != nil {
		t.Fatalf("Update: %v", err)
	}
	meta := readMeta(t, reg.dir)
	if meta.Workspace != "e:/work/stuff" {
		t.Fatalf("Update 后 workspace 未归一: %q", meta.Workspace)
	}
	if meta.Heartbeat <= before {
		t.Fatalf("Update 应刷新 heartbeat: %d <= %d", meta.Heartbeat, before)
	}
	time.Sleep(5 * time.Millisecond)
	if err := reg.Touch(); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	if got := readMeta(t, reg.dir).Heartbeat; got <= meta.Heartbeat {
		t.Fatalf("Touch 应刷新 heartbeat: %d <= %d", got, meta.Heartbeat)
	}
}

func TestHeartbeatLoopTouches(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	before := readMeta(t, reg.dir).Heartbeat
	reg.StartHeartbeat(40 * time.Millisecond)
	time.Sleep(140 * time.Millisecond)
	after := readMeta(t, reg.dir).Heartbeat // 必须在 Close 前读：Close 会删目录
	reg.Close()
	if after <= before {
		t.Fatalf("心跳应刷新 heartbeat: %d <= %d", after, before)
	}
}

func TestCloseRemovesEverything(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{Workspace: `D:\X`})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	reg.Close()
	reg.Close() // 幂等
	if _, err := os.Stat(reg.dir); !os.IsNotExist(err) {
		t.Fatal("Close 后窗口目录应被删除")
	}
	if _, err := os.Stat(reg.leasePath); !os.IsNotExist(err) {
		t.Fatal("Close 后 lease 文件应被删除")
	}
	if _, err := os.Stat(reg.leasePath + ".owner"); !os.IsNotExist(err) {
		t.Fatal("Close 后 owner 文件应被删除")
	}
}

func TestSweepRemovesStaleKeepsAlive(t *testing.T) {
	root := t.TempDir()
	// 活窗口（本进程持锁，Probe 的进程内 refcount 即被占）。
	reg, err := Register(root, Entry{Workspace: `D:\Keep`})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	defer reg.Close()

	// 残留目录（无人持锁）。
	ghost := filepath.Join(root, "ghost-0001")
	if err := os.MkdirAll(filepath.Join(ghost, "inbox"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Sweep(root); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if _, err := os.Stat(ghost); !os.IsNotExist(err) {
		t.Fatal("无人持锁的残留目录应被 Sweep 删除")
	}
	if _, err := os.Stat(reg.dir); err != nil {
		t.Fatalf("持锁窗口的目录应保留: %v", err)
	}
	// Sweep 顺带删掉残留的配对 lease/owner。
	for _, f := range []string{"ghost-0001.lease", "ghost-0001.lease.owner"} {
		if _, err := os.Stat(filepath.Join(root, f)); !os.IsNotExist(err) && f == "ghost-0001.lease" {
			t.Fatalf("残留 %s 应被清理", f)
		}
	}
}

func TestSweepKeepsCrossProcessAliveWindow(t *testing.T) {
	root := t.TempDir()
	leasePath := filepath.Join(root, "pid-bbbbbbbb.lease")
	closeChild := startHoldLeaseChild(t, leasePath)
	defer closeChild()

	// 跨进程活窗口的目录在（模拟另一窗口正常注册）。
	dir := filepath.Join(root, "pid-bbbbbbbb")
	if err := os.MkdirAll(filepath.Join(dir, "inbox"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := Sweep(root); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("跨进程持锁窗口的目录应保留: %v", err)
	}
	if _, err := os.Stat(leasePath); err != nil {
		t.Fatalf("跨进程持锁窗口的 lease 应保留: %v", err)
	}
}

func TestSweepSkipsOrphanLease(t *testing.T) {
	root := t.TempDir()
	orphan := filepath.Join(root, "pid-cccccccc.lease")
	if err := os.WriteFile(orphan, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Sweep(root); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if _, err := os.Stat(orphan); err != nil {
		t.Fatal("新的孤儿 lease（可能是注册中窗口）不许删")
	}
	old := time.Now().Add(-25 * time.Hour)
	if err := os.Chtimes(orphan, old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := Sweep(root); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("超龄孤儿 lease 应被兜底清理")
	}
}

func TestSweepLeavesStrayFiles(t *testing.T) {
	root := t.TempDir()
	stray := filepath.Join(root, "meta.json.tmp-123")
	if err := os.WriteFile(stray, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Sweep(root); err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatal("非窗口目录形态的散文件不许动（可能是正在写的 temp）")
	}
}

func TestSweepConcurrent(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 4; i++ {
		dir := filepath.Join(root, "ghost-"+string(rune('a'+i)))
		if err := os.MkdirAll(filepath.Join(dir, "inbox"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := Sweep(root); err != nil {
				t.Errorf("并发 Sweep: %v", err)
			}
		}()
	}
	wg.Wait()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.IsDir() {
			t.Fatalf("并发 Sweep 后残留目录: %s", e.Name())
		}
	}
}

func TestAliveRejectsBadIDs(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{"", "..", "a/b", "x.lease", "a\\b"} {
		if alive(root, id) {
			t.Errorf("alive(%q) 应拒绝", id)
		}
	}
}
