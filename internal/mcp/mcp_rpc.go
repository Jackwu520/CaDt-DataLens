// mcp_rpc.go：MCP stdio 传输的 JSON-RPC 2.0 层——逐行分帧、id 配对、通知分发。
// stdout 是协议通道：非 JSON 行容忍（丢弃 + 记警告），连续过多判定协议错乱；
// server→client 请求一律回 -32601（我们 capabilities 声明为空对象，server 不该发这些）。
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	mcpMaxLineBytes    = 8 << 20 // 单行上限：超了报协议错误而不是崩（bufio.Scanner 默认 64 KB 会静默截断大响应）
	mcpReadBufSize     = 64 << 10
	mcpMaxGarbageLines = 20 // 连续非 JSON 行容忍上限：超过判定协议错乱
	mcpStderrRingMax   = 64 << 10
)

var errConnClosed = errors.New("MCP 连接已关闭")

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string {
	return fmt.Sprintf("MCP RPC 错误 %d：%s", e.Code, e.Message)
}

// rpcMessage 同时承载请求 / 响应 / 通知：ID 为空（或 null）即通知。
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// mcpRingBuffer 环形缓冲：只留最近的 stderr 诊断，防失控 server 把内存吃穿。
type mcpRingBuffer struct {
	mu    sync.Mutex
	buf   bytes.Buffer
	limit int
}

func (r *mcpRingBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.buf.Write(p)
	if r.buf.Len() > r.limit {
		b := r.buf.Bytes()
		keep := make([]byte, r.limit)
		copy(keep, b[len(b)-r.limit:])
		r.buf.Reset()
		r.buf.Write(keep)
	}
	return len(p), nil
}

func (r *mcpRingBuffer) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.buf.String()
}

type rpcConn struct {
	writeMu sync.Mutex // stdin 写必须串行
	stdin   io.Writer

	mu        sync.Mutex
	pending   map[int64]chan *rpcMessage
	nextID    int64
	closed    chan struct{}
	closeOnce sync.Once

	onNotify func(*rpcMessage) // 通知分发（不进 pending 表）
}

func newRPCConn(stdin io.Writer, onNotify func(*rpcMessage)) *rpcConn {
	return &rpcConn{
		stdin:    stdin,
		pending:  map[int64]chan *rpcMessage{},
		closed:   make(chan struct{}),
		onNotify: onNotify,
	}
}

// serve 逐行读取并分发协议消息。返回错误仅意味着传输异常（EOF 之外）；
// 无论如何调用方都应随后调用 shutdown 唤醒所有 pending。
func (c *rpcConn) serve(r io.Reader) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, mcpReadBufSize), mcpMaxLineBytes)
	garbage := 0
	// 连续垃圾只记首行 + 结尾汇总：起不来的 server（banner / 用法说明）动辄十几行，
	// 逐行记 WARN 会把真正的失败原因挤出日志（2026-11-17 实际事故：10 次重连刷了上百行）。
	flushGarbage := func() {
		if garbage > 1 {
			logf("warn", "MCP stdout 连续丢弃 %d 行非 JSON（同类内容，首行见上一条）", garbage)
		}
		garbage = 0
	}
	defer flushGarbage()
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var msg rpcMessage
		if err := json.Unmarshal(line, &msg); err != nil {
			// 容忍对方的不规范：banner、print 调试等丢弃 + 记警告，不当协议错误中止。
			// stdout 是协议通道，污染它的是 server，我们防的是被拖死。
			garbage++
			if garbage == 1 {
				logf("warn", "MCP stdout 丢弃非 JSON 行：%s", mcpLogPreview(line, 160))
			}
			if garbage >= mcpMaxGarbageLines {
				// 错误文本已带行数，交给上层记失败原因：清掉计数免得 defer 再写一条重复的。
				garbage = 0
				return fmt.Errorf("stdout 连续 %d 行非 JSON，判定协议错乱", mcpMaxGarbageLines)
			}
			continue
		}
		flushGarbage()
		if err := c.handleMessage(&msg); err != nil {
			return err
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("MCP stdout 读取失败（单行上限 %d MB）：%w", mcpMaxLineBytes>>20, err)
	}
	return nil
}

func (c *rpcConn) handleMessage(msg *rpcMessage) error {
	if mcpIDPresent(msg.ID) {
		if msg.Method == "" {
			return c.deliverResponse(msg)
		}
		// server→client 请求：客户端未声明任何能力，回 -32601，绝不挂起。
		return c.respondError(msg.ID, -32601, "客户端不支持该方法（未声明对应 capability）")
	}
	if msg.Method != "" && c.onNotify != nil {
		c.onNotify(msg)
	}
	return nil
}

// mcpIDPresent：id 为 null 或缺省都视为通知。
func mcpIDPresent(id json.RawMessage) bool {
	if len(id) == 0 {
		return false
	}
	if string(bytes.TrimSpace(id)) == "null" {
		return false
	}
	return true
}

func (c *rpcConn) deliverResponse(msg *rpcMessage) error {
	var id int64
	if err := json.Unmarshal(msg.ID, &id); err != nil {
		return nil // 非数字 id 不是我们发的，丢弃
	}
	c.mu.Lock()
	ch, ok := c.pending[id]
	if ok {
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if ok {
		ch <- msg // 缓冲 1，绝不阻塞读循环
	}
	return nil
}

func (c *rpcConn) respondError(id json.RawMessage, code int, message string) error {
	resp := map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(id), "error": map[string]any{"code": code, "message": message}}
	if err := c.writeMsg(resp); err != nil {
		// 尽力而为的礼节性响应：写失败（进程已死）不值得中断读循环。
		logf("warn", "MCP 回写 -32601 失败：%v", err)
	}
	return nil
}

// call 发起一次请求-响应。同一连接上多个调用用不同 id 并发，靠 pending 表配对。
func (c *rpcConn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := atomic.AddInt64(&c.nextID, 1)
	ch := make(chan *rpcMessage, 1)
	c.mu.Lock()
	select {
	case <-c.closed:
		c.mu.Unlock()
		return nil, errConnClosed
	default:
	}
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	if err := c.writeMsg(req); err != nil {
		return nil, err
	}
	select {
	case msg := <-ch:
		if msg.Error != nil {
			return nil, msg.Error
		}
		return msg.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-c.closed:
		return nil, errConnClosed
	}
}

// notify 发送通知（无 id，不等响应）。
func (c *rpcConn) notify(method string, params any) error {
	return c.writeMsg(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *rpcConn) writeMsg(msg any) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("MCP 请求序列化失败：%w", err)
	}
	data = append(data, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	select {
	case <-c.closed:
		return errConnClosed
	default:
	}
	_, err = c.stdin.Write(data)
	return err
}

// shutdown 关闭连接：唤醒所有 pending 调用（返回 errConnClosed）。幂等。
func (c *rpcConn) shutdown() {
	c.closeOnce.Do(func() { close(c.closed) })
}

func (c *rpcConn) isClosed() bool {
	select {
	case <-c.closed:
		return true
	default:
		return false
	}
}

func mcpLogPreview(b []byte, n int) string {
	s := string(b)
	if len(s) > n {
		s = s[:n] + "…"
	}
	return strings.ReplaceAll(s, "\n", "\\n")
}
