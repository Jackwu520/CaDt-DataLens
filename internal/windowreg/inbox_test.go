package windowreg

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"datalens/internal/atomfile"
)

const testWS = `D:\Project\Alpha`

// writeRequest 直接构造一条请求文件（绕过 Deliver，供 take 侧用例）。
func writeRequest(t *testing.T, inbox string, req Request) {
	t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomfile.WriteFileAtomic(filepath.Join(inbox, req.ReqID+".json"), raw); err != nil {
		t.Fatal(err)
	}
}

func TestDeliverTakeAckOK(t *testing.T) {
	closeB, root := startHelper(t, "worker", "pid-worker1", testWS, "ok")
	defer closeB()

	got, err := Deliver(root, testWS, "sess-42", "pid-tester", 2500*time.Millisecond)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "pid-worker1" {
		t.Fatalf("Deliver 应返回复用窗口 id，得到 %q", got)
	}
}

func TestDeliverNoCandidate(t *testing.T) {
	root := t.TempDir()
	start := time.Now()
	got, err := Deliver(root, testWS, "sess-1", "pid-tester", 2500*time.Millisecond)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "" {
		t.Fatalf("无候选应返回空，得到 %q", got)
	}
	if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
		t.Fatalf("无候选应快速返回，耗时 %v", elapsed)
	}
}

func TestDeliverWithdrawsOnTimeout(t *testing.T) {
	// idle helper：注册了工作区但不消费信箱（模拟卡死窗口）。
	closeB, root := startHelper(t, "idle", "pid-idle1", testWS, "")
	defer closeB()

	got, err := Deliver(root, testWS, "sess-1", "pid-tester", 300*time.Millisecond)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "" {
		t.Fatalf("超时应返回空（调用方开新窗），得到 %q", got)
	}
	// 撤回断言：请求文件必须已从目标 inbox 删除。
	left, readErr := os.ReadDir(filepath.Join(root, "pid-idle1", "inbox"))
	if readErr != nil {
		t.Fatal(readErr)
	}
	for _, e := range left {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".json" && !hasPrefix(e.Name(), "taken-") {
			t.Fatalf("超时撤回后 inbox 不应残留请求文件: %s", e.Name())
		}
	}
}

func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }

func TestDeliverMismatchRotates(t *testing.T) {
	// 主进程双注册 + 两个消费者 goroutine，确定性验证 mismatch 轮换：
	// r2 先注册（heartbeat 旧，ack ok），r1 后注册（heartbeat 最新，ack mismatch）。
	// Deliver 先投 r1 → mismatch → 轮换到 r2 → ok。
	root := t.TempDir()
	reg2, err := Register(root, Entry{WindowID: "pid-r2", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()
	time.Sleep(3 * time.Millisecond)
	reg1, err := Register(root, Entry{WindowID: "pid-r1", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg1.Close()

	consume := func(reg *Registry, status string) {
		for i := 0; i < 200; i++ {
			req, takeErr := reg.Take()
			if takeErr == nil && req != nil {
				_ = reg.Ack(req.ReqID, status)
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	go consume(reg1, "mismatch")
	go consume(reg2, "ok")

	got, err := Deliver(root, testWS, "sess-1", "pid-tester", 4*time.Second)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "pid-r2" {
		t.Fatalf("mismatch 后应轮换到 r2，得到 %q", got)
	}
}

func TestDeliverMismatchRotatesSameRoot(t *testing.T) {
	// 上一个用例验证轮换语义需要两候选同根；这里直接在主进程双注册验证（无需子进程）：
	// 主进程持锁的两个 Registry 即两个「活窗口」。
	root := t.TempDir()
	reg1, err := Register(root, Entry{WindowID: "pid-r1", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg1.Close()
	time.Sleep(3 * time.Millisecond) // 保证 heartbeat 可分先后
	reg2, err := Register(root, Entry{WindowID: "pid-r2", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg2.Close()

	// 谁的 heartbeat 新谁先被投：本测试进程不消费 r2（最新）的 inbox，
	// Deliver 在 r2 上超时撤回后轮换到 r1——同样没人消费，最终返回空。
	got, err := Deliver(root, testWS, "sess-1", "pid-tester", 400*time.Millisecond)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "" {
		t.Fatalf("全部候选不消费应返回空，得到 %q", got)
	}
	// 两个 inbox 的请求都应被撤回干净。
	for _, wid := range []string{"pid-r1", "pid-r2"} {
		left, readErr := os.ReadDir(filepath.Join(root, wid, "inbox"))
		if readErr != nil {
			t.Fatal(readErr)
		}
		for _, e := range left {
			if !e.IsDir() && filepath.Ext(e.Name()) == ".json" && !hasPrefix(e.Name(), "taken-") {
				t.Fatalf("轮换后 %s inbox 残留请求: %s", wid, e.Name())
			}
		}
	}
}

func TestDeliverTakesOverThenSucceeds(t *testing.T) {
	closeB, root := startHelper(t, "worker", "pid-worker1", testWS, "ok")
	defer closeB()
	// 正常路径与「超时瞬间刚好接管」路径最终都应返回成功：
	// worker 30ms 轮询 take + ack ok；即便预算内没读到 ack，remove 报 ENOENT
	// 走接管分支后也返回成功（宁可信任接管方不双开）。
	got, err := Deliver(root, testWS, "sess-7", "pid-tester", 1500*time.Millisecond)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "pid-worker1" {
		t.Fatalf("接管后应返回成功，得到 %q", got)
	}
}

func TestTakeExpiredDiscardsAndAcks(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{WindowID: "pid-self", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	inbox := reg.InboxDir()
	req := Request{ReqID: newReqID(), From: "pid-old", Workspace: "d:/project/alpha", SessionID: "s1", TS: time.Now().Add(-6 * time.Second).UnixMilli()}
	writeRequest(t, inbox, req)

	got, err := reg.Take()
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	if got != nil {
		t.Fatalf("过期请求应被丢弃，得到 %+v", got)
	}
	raw, readErr := os.ReadFile(filepath.Join(inbox, req.ReqID+".ack"))
	if readErr != nil {
		t.Fatalf("过期请求应写 expired 回执: %v", readErr)
	}
	var ack Ack
	if json.Unmarshal(raw, &ack) != nil || ack.Status != "expired" {
		t.Fatalf("回执状态应为 expired: %s", string(raw))
	}
}

func TestTakeClaimsAndReleasesOnAck(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{WindowID: "pid-self", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	inbox := reg.InboxDir()
	req := Request{ReqID: newReqID(), From: "pid-fresh", Workspace: "d:/project/alpha", SessionID: "s2", TS: time.Now().UnixMilli()}
	writeRequest(t, inbox, req)

	got, err := reg.Take()
	if err != nil {
		t.Fatalf("Take: %v", err)
	}
	if got == nil || got.SessionID != "s2" {
		t.Fatalf("Take 应取到请求，得到 %+v", got)
	}
	// 接管后原请求文件应消失（内容已入内存），claim 应保持持有（处理期间撤回必失败）。
	if _, err := os.Stat(filepath.Join(inbox, req.ReqID+".json")); !os.IsNotExist(err) {
		t.Fatal("接管后原请求文件应消失")
	}
	if _, err := os.Stat(filepath.Join(inbox, req.ReqID+".claim")); err != nil {
		t.Fatalf("处理期间 claim 应保持持有: %v", err)
	}
	// Ack 后 claim 释放。
	if err := reg.Ack(req.ReqID, "ok"); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if _, err := os.Stat(filepath.Join(inbox, req.ReqID+".claim")); !os.IsNotExist(err) {
		t.Fatal("Ack 后 claim 应被释放")
	}
}

func TestMutualExclusionBothWays(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{WindowID: "pid-self", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	inbox := reg.InboxDir()

	// 侧一（接管先赢）：Take 持有 claim 期间，投递方的接管/撤回登记必失败。
	req := Request{ReqID: newReqID(), From: "pid-f", Workspace: "d:/project/alpha", SessionID: "s", TS: time.Now().UnixMilli()}
	writeRequest(t, inbox, req)
	if _, err := reg.Take(); err != nil {
		t.Fatalf("Take: %v", err)
	}
	if claimed, _ := claimRequest(inbox, req.ReqID); claimed {
		t.Fatal("take 持有 claim 期间投递方接管登记应失败")
	}
	if err := reg.Ack(req.ReqID, "ok"); err != nil {
		t.Fatalf("Ack: %v", err)
	}

	// 侧二（撤回先赢）：投递方先登记 claim，take 应拿不到任何请求。
	req2 := Request{ReqID: newReqID(), From: "pid-f", Workspace: "d:/project/alpha", SessionID: "s", TS: time.Now().UnixMilli()}
	writeRequest(t, inbox, req2)
	claimed, claimErr := claimRequest(inbox, req2.ReqID)
	if claimErr != nil || !claimed {
		t.Fatalf("撤回方接管登记应成功: %v", claimErr)
	}
	got, err := reg.Take()
	if err != nil || got != nil {
		t.Fatalf("撤回先赢时 Take 应为空，得到 (%+v, %v)", got, err)
	}
	releaseClaim(inbox, req2.ReqID)
	_ = os.Remove(filepath.Join(inbox, req2.ReqID+".json"))
}

func TestAckWriteAndStaleAckCleanup(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{WindowID: "pid-self", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	inbox := reg.InboxDir()

	reqID := newReqID()
	if err := reg.Ack(reqID, "ok"); err != nil {
		t.Fatalf("Ack: %v", err)
	}
	if status, ok := readAck(inbox, reqID); !ok || status != "ok" {
		t.Fatalf("readAck 应读到 ok，得到 (%q, %v)", status, ok)
	}
	if status, _ := readAck(inbox, "zzzz"); status != "" {
		t.Fatal("无回执应返回空")
	}

	// 孤儿 ack（超龄 + 无对应 .json）应被下次 take 清理；新鲜 ack 不许动。
	stale := filepath.Join(inbox, newReqID()+".ack")
	if err := os.WriteFile(stale, []byte(`{"reqId":"x","status":"ok"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-11 * time.Second)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	fresh := filepath.Join(inbox, reqID+".ack") // 刚写的 ok 回执
	req := Request{ReqID: newReqID(), From: "pid-f", Workspace: "d:/project/alpha", SessionID: "s", TS: time.Now().UnixMilli()}
	writeRequest(t, inbox, req)
	if _, err := reg.Take(); err == nil {
		t.Log("take 返回（请求有效或空均可，本用例只验证清理）")
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("超龄孤儿 ack 应被清理")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("新鲜 ack（投递方可能正在轮询）不许被清理")
	}
}

// TestDeliverTargetDiedAfterTake 锁 P1-2 修复：接管方拿到请求后立刻死亡（无 ack），
// deliverOne 的 remove 拿到 ENOENT 后必须先判 alive——目标已死按未接管换候选，
// 返回空让投递方开新窗口（修复前会误判「已被接管」返回成功，两边都没开窗）。
func TestDeliverTargetDiedAfterTake(t *testing.T) {
	closeB, root := startHelper(t, "take-no-ack", "pid-taken-dead", testWS, "")
	defer closeB()

	got, err := Deliver(root, testWS, "sess-dead", "pid-tester", 2500*time.Millisecond)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "" {
		t.Fatalf("接管后目标死亡应返回空（投递方开新窗），得到 %q", got)
	}
}

// TestDeliverTrustTakenAliveTarget 锁信任分支：接管方活着但不回 ack，
// deliverOne 返回该 windowId（信任接管方处理，不开新窗防双开）。
func TestDeliverTrustTakenAliveTarget(t *testing.T) {
	closeB, root := startHelper(t, "take-silent", "pid-taken-silent", testWS, "")
	defer closeB()

	got, err := Deliver(root, testWS, "sess-silent", "pid-tester", 1200*time.Millisecond)
	if err != nil {
		t.Fatalf("Deliver: %v", err)
	}
	if got != "pid-taken-silent" {
		t.Fatalf("接管方存活时应信任接管返回其 windowId，得到 %q", got)
	}
}

// TestClaimRaceExactlyOneWins 锁双向互斥：50 轮接管 claim 与撤回 claim 并发
// 竞争同一请求，每轮恰好一方成功——O_EXCL 创建由内核保证互斥（这正是接管
// 不能用 remove/rename 的原因：Win10+ POSIX 语义下 remove+rename 与
// rename+rename 都实测双双成功，协议会失效）。
func TestClaimRaceExactlyOneWins(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{WindowID: "pid-race", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	inbox := reg.InboxDir()
	for round := 0; round < 50; round++ {
		reqID := newReqID()
		reqPath := filepath.Join(inbox, reqID+".json")
		writeRequest(t, inbox, Request{ReqID: reqID, From: "pid-f", Workspace: "d:/project/alpha", SessionID: "s", TS: time.Now().UnixMilli()})
		var wg sync.WaitGroup
		var takeWon, withdrawWon atomic.Bool
		wg.Add(2)
		go func() {
			defer wg.Done()
			if ok, _ := claimRequest(inbox, reqID); ok {
				takeWon.Store(true)
			}
		}()
		go func() {
			defer wg.Done()
			if ok, _ := claimRequest(inbox, reqID); ok {
				withdrawWon.Store(true)
			}
		}()
		wg.Wait()
		if takeWon.Load() == withdrawWon.Load() {
			t.Fatalf("round %d: take=%v withdraw=%v，必须恰有一方成功", round, takeWon.Load(), withdrawWon.Load())
		}
		releaseClaim(inbox, reqID)
		_ = os.Remove(reqPath)
	}
}

// TestAckOutcomeMapping 锁 ackOutcome 的映射语义：ok 成功；mismatch/expired/未知状态
// 一律「未接下、可换候选」（expired → 换候选是方案 §6 的要求）。
func TestAckOutcomeMapping(t *testing.T) {
	id, retry, err := ackOutcome("ok", "w1")
	if id != "w1" || retry || err != nil {
		t.Fatalf("ok 应返回 (w1, false, nil)，得到 (%q, %v, %v)", id, retry, err)
	}
	for _, status := range []string{"mismatch", "expired", "weird-status"} {
		id, retry, err := ackOutcome(status, "w1")
		if id != "" || !retry || err != nil {
			t.Fatalf("%s 应返回 (\"\", true, nil)，得到 (%q, %v, %v)", status, id, retry, err)
		}
	}
}

// TestAckRejectsInvalidReqID 锁 Ack 的 reqId 注入防线（分支级：validReqID 单测之外）。
func TestAckRejectsInvalidReqID(t *testing.T) {
	root := t.TempDir()
	reg, err := Register(root, Entry{WindowID: "pid-ack", Workspace: testWS})
	if err != nil {
		t.Fatal(err)
	}
	defer reg.Close()
	for _, bad := range []string{"../evil", "a/b", "ABCDEF", "", "a\b"} {
		if err := reg.Ack(bad, "ok"); err == nil {
			t.Fatalf("Ack(%q) 应拒绝非法请求 id", bad)
		}
	}
}
