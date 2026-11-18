package resourcelease

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("RESOURCELEASE_HELPER") == "1" {
		helperMain()
		return
	}
	os.Exit(m.Run())
}

// helperMain 是子进程模式：持有一把锁并等 stdin EOF，用来验证跨进程互斥与
// 进程退出自动释放。不能让它落到 m.Run()，否则会递归跑全量测试。
func helperMain() {
	path := os.Getenv("RESOURCELEASE_HELPER_PATH")
	mode := os.Getenv("RESOURCELEASE_HELPER_MODE")
	var (
		lease *Lease
		err   error
	)
	if mode == "shared" {
		lease, err = AcquireShared(path)
	} else {
		lease, err = Acquire(path, Owner{Label: "helper"})
	}
	if err != nil {
		fmt.Println("ERR:" + err.Error())
		return
	}
	fmt.Println("LOCKED")
	_, _ = io.Copy(io.Discard, os.Stdin)
	lease.Release()
}

func startLeaseChild(t *testing.T, path, mode string) io.WriteCloser {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(),
		"RESOURCELEASE_HELPER=1",
		"RESOURCELEASE_HELPER_PATH="+path,
		"RESOURCELEASE_HELPER_MODE="+mode,
	)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("StdinPipe：%v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		t.Fatalf("StdoutPipe：%v", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		t.Fatalf("启动 helper：%v", err)
	}
	done := make(chan struct{})
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
		}
	})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("读取 helper 输出：%v", err)
	}
	if strings.TrimSpace(line) != "LOCKED" {
		t.Fatalf("helper 未拿到锁：%q", strings.TrimSpace(line))
	}
	return stdin
}

func TestAcquireRefcountAndProbe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	first, err := Acquire(path, Owner{Label: "窗口 A"})
	if err != nil {
		t.Fatalf("首次 Acquire：%v", err)
	}
	second, err := Acquire(path, Owner{Label: "窗口 B"})
	if err != nil {
		t.Fatalf("同进程第二次 Acquire 应走 refcount：%v", err)
	}
	if _, busy, err := Probe(path); err != nil || !busy {
		t.Fatalf("持有期间 Probe 应为 busy：busy=%v err=%v", busy, err)
	}
	first.Release()
	if _, busy, err := Probe(path); err != nil || !busy {
		t.Fatalf("释放一个 ref 后仍应 busy：busy=%v err=%v", busy, err)
	}
	second.Release()
	if _, busy, err := Probe(path); err != nil || busy {
		t.Fatalf("全部释放后 Probe 应为空：busy=%v err=%v", busy, err)
	}
	// 重复 Release 必须是 no-op。
	first.Release()
	second.Release()
}

func TestAcquireBlocksAcrossProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	stdin := startLeaseChild(t, path, "exclusive")
	defer stdin.Close()

	_, err := Acquire(path, Owner{Label: "parent"})
	if !IsBusy(err) {
		t.Fatalf("子进程持锁时父进程应 busy，得到 %v", err)
	}
	if owner := BusyOwner(err); owner.PID <= 0 {
		t.Fatalf("busy 应带回 owner PID，得到 %+v", owner)
	}
	if err := stdin.Close(); err != nil {
		t.Fatalf("关闭 helper stdin：%v", err)
	}
	// 子进程退出后锁应由内核释放。
	deadline := time.Now().Add(5 * time.Second)
	for {
		lease, err := Acquire(path, Owner{Label: "parent"})
		if err == nil {
			lease.Release()
			break
		}
		if !IsBusy(err) {
			t.Fatalf("子进程退出后 Acquire 失败：%v", err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("子进程退出后锁仍未释放：%v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestAcquireWaitTimeoutAndRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	stdin := startLeaseChild(t, path, "exclusive")
	start := time.Now()
	_, err := AcquireWait(path, Owner{Label: "parent"}, 100*time.Millisecond)
	if !IsBusy(err) {
		t.Fatalf("AcquireWait 应超时返回 busy，得到 %v", err)
	}
	if elapsed := time.Since(start); elapsed < 50*time.Millisecond {
		t.Fatalf("AcquireWait 超时过短：%v", elapsed)
	}
	_ = stdin.Close()
	lease, err := AcquireWait(path, Owner{Label: "parent"}, 5*time.Second)
	if err != nil {
		t.Fatalf("helper 退出后 AcquireWait 失败：%v", err)
	}
	lease.Release()
}

func TestSharedBlocksExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	first, err := AcquireShared(path)
	if err != nil {
		t.Fatalf("首个共享租约失败：%v", err)
	}
	second, err := AcquireShared(path)
	if err != nil {
		first.Release()
		t.Fatalf("第二个共享租约应走 refcount：%v", err)
	}
	if _, err := Acquire(path, Owner{}); !IsBusy(err) {
		t.Fatalf("共享租约存在时独占应 busy，得到 %v", err)
	}
	first.Release()
	if _, err := Acquire(path, Owner{}); !IsBusy(err) {
		t.Fatalf("还剩一个共享租约时独占应 busy，得到 %v", err)
	}
	second.Release()
	exclusive, err := Acquire(path, Owner{})
	if err != nil {
		t.Fatalf("共享租约释放后独占失败：%v", err)
	}
	exclusive.Release()
}

func TestSharedAcrossProcesses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	stdin := startLeaseChild(t, path, "shared")
	defer stdin.Close()

	shared, err := AcquireShared(path)
	if err != nil {
		t.Fatalf("跨进程共享租约应可共存：%v", err)
	}
	if _, err := Acquire(path, Owner{}); !IsBusy(err) {
		shared.Release()
		t.Fatalf("跨进程共享存在时独占应 busy，得到 %v", err)
	}
	shared.Release()
}

func TestOwnerMetadata(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	lease, err := Acquire(path, Owner{Label: "窗口 A"})
	if err != nil {
		t.Fatalf("Acquire：%v", err)
	}
	key, err := canonicalKey(path)
	if err != nil {
		t.Fatalf("canonicalKey：%v", err)
	}
	raw, err := os.ReadFile(key + ".owner")
	if err != nil {
		lease.Release()
		t.Fatalf("读取 owner 文件：%v", err)
	}
	var owner Owner
	if err := json.Unmarshal(raw, &owner); err != nil {
		lease.Release()
		t.Fatalf("解析 owner：%v", err)
	}
	if owner.PID != os.Getpid() || owner.Label != "窗口 A" || owner.StartedAt <= 0 {
		lease.Release()
		t.Fatalf("owner 内容不符：%+v", owner)
	}
	lease.Release()
	// owner 文件不删除；锁空时 Probe 忽略它。
	if _, err := os.Stat(key + ".owner"); err != nil {
		t.Fatalf("owner 文件应保留：%v", err)
	}
	if owner, busy, err := Probe(path); err != nil || busy {
		t.Fatalf("释放后 Probe 应为空：owner=%+v busy=%v err=%v", owner, busy, err)
	}
}

func TestAcquireEmptyPath(t *testing.T) {
	if _, err := Acquire("", Owner{}); err == nil || IsBusy(err) {
		t.Fatalf("空路径应返回非 busy 错误，得到 %v", err)
	}
}

func TestBusyErrorUnwrap(t *testing.T) {
	err := error(&BusyError{Owner: Owner{PID: 42}})
	if !IsBusy(err) {
		t.Fatal("IsBusy 应识别 BusyError")
	}
	var direct *BusyError
	if !errors.As(err, &direct) || direct.Owner.PID != 42 {
		t.Fatalf("errors.As 失败：%v", err)
	}
}

func TestAcquireNoShareRejectsLocalRefs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	lease, err := Acquire(path, Owner{Label: "writer"})
	if err != nil {
		t.Fatalf("Acquire：%v", err)
	}
	if _, err := AcquireNoShare(path, Owner{Label: "delete"}); !IsBusy(err) {
		t.Fatalf("本进程已有 ref 时 AcquireNoShare 应 busy，得到 %v", err)
	}
	lease.Release()
	exclusive, err := AcquireNoShare(path, Owner{Label: "delete"})
	if err != nil {
		t.Fatalf("释放后 AcquireNoShare 失败：%v", err)
	}
	exclusive.Release()
}

func TestSharedBlockedByLocalExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	exclusive, err := Acquire(path, Owner{Label: "clear"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AcquireShared(path); !IsBusy(err) {
		exclusive.Release()
		t.Fatalf("同进程独占存在时共享锁应 busy，得到 %v", err)
	}
	exclusive.Release()
	shared, err := AcquireShared(path)
	if err != nil {
		t.Fatalf("释放后共享锁失败：%v", err)
	}
	shared.Release()
}

func TestNoShareBlocksLaterLocalAcquire(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lease.test")
	ns, err := AcquireNoShare(path, Owner{Label: "clear"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(path, Owner{}); !IsBusy(err) {
		ns.Release()
		t.Fatalf("NoShare 持有期间 Acquire 应 busy，得到 %v", err)
	}
	if _, err := AcquireWait(path, Owner{}, 100*time.Millisecond); !IsBusy(err) {
		ns.Release()
		t.Fatalf("NoShare 持有期间 AcquireWait 应 busy，得到 %v", err)
	}
	if _, err := AcquireShared(path); !IsBusy(err) {
		ns.Release()
		t.Fatalf("NoShare 持有期间 AcquireShared 应 busy，得到 %v", err)
	}
	ns.Release()
	l, err := Acquire(path, Owner{})
	if err != nil {
		t.Fatalf("释放后 Acquire 失败：%v", err)
	}
	l.Release()
}
