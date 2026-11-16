// mcp_rpc_test.go：JSON-RPC 层的内存管道测试——分帧、id 配对、通知、-32601、超长行、垃圾行容忍。
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// rpcTestPeer 用两条 io.Pipe 模拟 stdio：conn 的请求经 drainRequests 排空后进 requestCh，
// 测试侧写 responses 模拟 server 输出。io.Pipe 的 Write 阻塞到有人读——所以 stdin 必须
// 常驻排空，否则 call 的请求写出会卡死。
type rpcTestPeer struct {
	conn      *rpcConn
	responses *io.PipeWriter // 测试侧 → conn（server 输出）
	requests  *io.PipeReader // conn → 测试侧（conn 的 stdin）
	serveErr  chan error
	requestCh chan rpcMessage
	done      chan struct{}
}

func newRPCConnForTest(onNotify func(*rpcMessage)) (*rpcTestPeer, func()) {
	fromServerR, fromServerW := io.Pipe()
	requestsR, requestsW := io.Pipe()
	conn := newRPCConn(requestsW, onNotify)
	serveErr := make(chan error, 1)
	go func() {
		err := conn.serve(fromServerR)
		conn.shutdown() // 与生产路径一致：serve 退出（EOF/错误）必须关闭连接唤醒 pending
		serveErr <- err
	}()
	peer := &rpcTestPeer{
		conn:      conn,
		responses: fromServerW,
		requests:  requestsR,
		serveErr:  serveErr,
		requestCh: make(chan rpcMessage, 64),
		done:      make(chan struct{}),
	}
	go peer.drainRequests()
	var cleanupOnce sync.Once
	return peer, func() {
		cleanupOnce.Do(func() {
			close(peer.done)
			conn.shutdown()
			peer.requests.Close()
			fromServerW.Close()
			requestsW.Close()
		})
	}
}

func (p *rpcTestPeer) drainRequests() {
	sc := bufio.NewScanner(p.requests)
	for sc.Scan() {
		var msg rpcMessage
		if json.Unmarshal(sc.Bytes(), &msg) != nil {
			continue
		}
		select {
		case p.requestCh <- msg:
		case <-p.done:
			return
		}
	}
}

// readRequest 从排空通道取一条 conn 写出的请求（模拟 server 读自己的 stdin）。
func (p *rpcTestPeer) readRequest(t *testing.T) rpcMessage {
	t.Helper()
	select {
	case msg := <-p.requestCh:
		return msg
	case <-time.After(2 * time.Second):
		t.Fatal("2s 内未收到 conn 写出的请求")
		return rpcMessage{}
	}
}

// writeLine 模拟 server 往 stdout 写一行（自动补换行）。
func (p *rpcTestPeer) writeLine(t *testing.T, data string) {
	t.Helper()
	if !strings.HasSuffix(data, "\n") {
		data += "\n"
	}
	go func() { _, _ = p.responses.Write([]byte(data)) }() // io.Pipe 会阻塞到 conn 读走
}

// autoPong 后台对每个请求回 {"result":"pong"}（rpcerror 模式回错误）。与 readRequest
// 共用 requestCh，同一测试不要混用。
func (p *rpcTestPeer) autoPong(t *testing.T, mode string) {
	t.Helper()
	go func() {
		for {
			select {
			case msg := <-p.requestCh:
				if msg.Method == "" || !mcpIDPresent(msg.ID) {
					continue
				}
				var payload map[string]any
				if mode == "rpcerror" {
					payload = map[string]any{"error": map[string]any{"code": -32000, "message": "peer 内部错误"}}
				} else {
					payload = map[string]any{"result": "pong"}
				}
				payload["jsonrpc"] = "2.0"
				payload["id"] = msg.ID
				data, _ := json.Marshal(payload)
				_, _ = p.responses.Write(append(data, '\n'))
			case <-p.done:
				return
			}
		}
	}()
}

func TestRPCConnCallPairing(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()
	peer.autoPong(t, "ok")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := peer.conn.call(ctx, "ping", nil)
	if err != nil {
		t.Fatalf("call 失败：%v", err)
	}
	if string(result) != `"pong"` {
		t.Fatalf("结果不符：%s", result)
	}
}

func TestRPCConnConcurrentCalls(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()
	peer.autoPong(t, "ok")

	const n = 50
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := peer.conn.call(ctx, "ping", nil); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("并发 call 出错：%v", err)
	}
}

func TestRPCConnSplitLine(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()

	type callOut struct {
		result json.RawMessage
		err    error
	}
	out := make(chan callOut, 1)
	go func() {
		result, err := peer.conn.call(context.Background(), "ping", nil)
		out <- callOut{result, err}
	}()

	// 一行分两次 write 到达（模拟底层管道分片）
	full := `{"jsonrpc":"2.0","id":1,"result":"pong"}` + "\n"
	time.Sleep(50 * time.Millisecond)
	_, _ = peer.responses.Write([]byte(full[:20]))
	time.Sleep(50 * time.Millisecond)
	_, _ = peer.responses.Write([]byte(full[20:]))

	got := <-out
	if got.err != nil {
		t.Fatalf("分包后 call 失败：%v", got.err)
	}
	if string(got.result) != `"pong"` {
		t.Fatalf("分包后结果不符：%s", got.result)
	}
}

func TestRPCConnNotificationSkipsPending(t *testing.T) {
	notifyCh := make(chan string, 4)
	peer, cleanup := newRPCConnForTest(func(msg *rpcMessage) {
		notifyCh <- msg.Method
	})
	defer cleanup()

	type callOut struct {
		result json.RawMessage
		err    error
	}
	out := make(chan callOut, 1)
	go func() {
		result, err := peer.conn.call(context.Background(), "ping", nil)
		out <- callOut{result, err}
	}()
	time.Sleep(50 * time.Millisecond)
	// 通知先到（无 id），随后响应到达：通知不该进 pending 表，也不干扰配对
	peer.writeLine(t, `{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`)
	peer.writeLine(t, `{"jsonrpc":"2.0","id":1,"result":"pong"}`)

	got := <-out
	if got.err != nil {
		t.Fatalf("通知伴随 call 失败：%v", got.err)
	}
	select {
	case method := <-notifyCh:
		if method != "notifications/tools/list_changed" {
			t.Fatalf("通知方法不符：%s", method)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("未收到通知回调")
	}
}

func TestRPCConnServerRequestGets32601(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()

	peer.writeLine(t, `{"jsonrpc":"2.0","id":99,"method":"sampling/createMessage","params":{}}`)
	msg := peer.readRequest(t)
	if msg.Error == nil || msg.Error.Code != -32601 {
		t.Fatalf("server→client 请求应回 -32601，实际：%+v", msg.Error)
	}
}

func TestRPCConnTooLongLine(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()

	// 一行超过 8 MB：serve 报错退出，连接关闭，pending 调用得到 errConnClosed
	huge := make([]byte, mcpMaxLineBytes+16)
	for i := range huge {
		huge[i] = 'x'
	}
	go func() { _, _ = peer.responses.Write(huge) }()

	select {
	case err := <-peer.serveErr:
		if err == nil || !strings.Contains(err.Error(), "读取失败") {
			t.Fatalf("超长行应导致 serve 报读取错误，实际：%v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("超长行未触发 serve 退出")
	}
	_, err := peer.conn.call(context.Background(), "ping", nil)
	if err != errConnClosed {
		t.Fatalf("连接关闭后 call 应返回 errConnClosed，实际：%v", err)
	}
}

func TestRPCConnGarbageTolerated(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()

	peer.writeLine(t, "hello banner")
	peer.writeLine(t, "[INFO] debug")
	peer.writeLine(t, "{not json")
	peer.writeLine(t, `{"jsonrpc":"2.0","id":1,"result":"pong"}`)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result, err := peer.conn.call(ctx, "ping", nil)
	if err != nil {
		t.Fatalf("垃圾行应被容忍，call 失败：%v", err)
	}
	if string(result) != `"pong"` {
		t.Fatalf("结果不符：%s", result)
	}
}

func TestRPCConnGarbageFlood(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()

	for i := 0; i < mcpMaxGarbageLines; i++ {
		peer.writeLine(t, "garbage line")
	}
	select {
	case err := <-peer.serveErr:
		if err == nil || !strings.Contains(err.Error(), "协议错乱") {
			t.Fatalf("连续 %d 行垃圾应判定协议错乱，实际：%v", mcpMaxGarbageLines, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("垃圾行洪泛未触发 serve 退出")
	}
	if _, err := peer.conn.call(context.Background(), "ping", nil); err != errConnClosed {
		t.Fatalf("协议错乱后 call 应返回 errConnClosed，实际：%v", err)
	}
}

func TestRPCConnCallAfterShutdown(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()

	peer.conn.shutdown()
	if _, err := peer.conn.call(context.Background(), "ping", nil); err != errConnClosed {
		t.Fatalf("shutdown 后 call 应返回 errConnClosed，实际：%v", err)
	}
}

func TestRPCConnPendingWakeupOnShutdown(t *testing.T) {
	peer, cleanup := newRPCConnForTest(nil)
	defer cleanup()

	type callOut struct {
		result json.RawMessage
		err    error
	}
	out := make(chan callOut, 1)
	go func() {
		result, err := peer.conn.call(context.Background(), "ping", nil)
		out <- callOut{result, err}
	}()
	time.Sleep(50 * time.Millisecond)
	cleanup() // shutdown：挂着的 call 应立刻被唤醒而不是泄漏
	select {
	case got := <-out:
		if got.err != errConnClosed {
			t.Fatalf("shutdown 应唤醒 pending call 为 errConnClosed，实际：%v", got.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pending call 未被 shutdown 唤醒")
	}
}
