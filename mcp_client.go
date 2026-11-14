// mcp_client.go：单个 MCP server 的连接桥——进程启动、initialize 握手、tools/list 分页、
// tools/call 转发与关闭确认。多 server 编排、世代交换与重连调度在 mcp_manager.go。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	mcpProtocolVersion = "2025-06-18" // 握手以 server 返回的版本为准，不硬拒
	mcpClientName      = "CaDt-DataLens"
	mcpMaxListPages    = 20         // 分页上限：游标死循环的 server 按截断处理，不挂死
	mcpMaxProbeTools   = 512        // 探测工具名上限：firehose server 不至于把面板撑爆
	mcpResultMaxBytes  = 256 << 10  // 单次调用结果截断：防一次查询打爆上下文
	mcpWaitPipeDelay   = 3 * time.Second
	mcpCloseForceWait  = 3 * time.Second
)

type mcpToolAnnotations struct {
	ReadOnlyHint    *bool `json:"readOnlyHint,omitempty"`
	DestructiveHint *bool `json:"destructiveHint,omitempty"`
	OpenWorldHint   *bool `json:"openWorldHint,omitempty"`
}

// mcpRemoteTool 是 tools/list 返回的原始工具（raw 名），面向模型的公开名由 mcp_name.go 映射。
type mcpRemoteTool struct {
	Name        string              `json:"name"`
	Description string              `json:"description,omitempty"`
	InputSchema json.RawMessage     `json:"inputSchema,omitempty"`
	Annotations *mcpToolAnnotations `json:"annotations,omitempty"`
}

// mcpCloseResult 把关闭语义拆成两个独立维度：传输关闭是否确认、清理是否出错。
// CloseConfirmed=false 意味着上次连接没关干净——必须阻止重连与替换连接，否则会叠两个实例。
type mcpCloseResult struct {
	CloseConfirmed bool
	CleanupError   string
}

type mcpStatus struct {
	State       string // closed | connecting | connected | reconnecting | failed
	Attempt     int
	MaxAttempt  int
	ToolCount   int
	NextRetryAt int64
	LastError   string
	Reason      string // failed 的原因：gave-up | reconnect-disabled | unclosed-generation
}

type mcpClient struct {
	name string // 本地配置键，namespace 的唯一来源
	cfg  MCPServerConfig

	procCtx    context.Context
	procCancel context.CancelFunc
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	jobClose   func() // Job Object 句柄释放（KILL_ON_JOB_CLOSE：关句柄 = 内核杀整组）
	waitDone   chan struct{} // cmd.Wait 返回后关闭，waitErr 随之可见
	waitErr    error

	conn      *rpcConn
	stderrLog *mcpRingBuffer

	onToolsChanged func() // notifications/tools/list_changed 回调（manager 接线）
	onLost         func(reason string) // 进程意外退出 / 读取异常结束（主动 close 时不触发）
	closing        atomic.Bool         // 主动关闭标记：区分「我们关的」和「server 自己死了」

	mu           sync.Mutex
	status       mcpStatus
	tools        map[string]mcpRemoteTool // raw 名 → 工具（当前世代）
	serverName   string                   // 远端 serverInfo.name，仅诊断展示，绝不作 namespace
	instructions string                   // server 说明书：只展示给用户看，不注入系统提示
}

func newMCPClient(name string, cfg MCPServerConfig) *mcpClient {
	return &mcpClient{name: name, cfg: cfg, waitDone: make(chan struct{})}
}

// connect 启动子进程并完成握手与工具清单拉取（启动预算内一并完成）。
// 失败返回错误；进程与连接资源由调用方随后调用 close 清理。
func (c *mcpClient) connect(ctx context.Context) error {
	c.setStatus(func(s *mcpStatus) { s.State = "connecting" })

	c.procCtx, c.procCancel = context.WithCancel(ctx)
	cmd := exec.CommandContext(c.procCtx, c.cfg.Command, c.cfg.Args...)
	if cwd := strings.TrimSpace(c.cfg.Cwd); cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = mcpChildEnv(c.cfg.Env)
	mcpHideWindow(cmd)
	cmd.Cancel = func() error { return mcpKillTree(cmd) } // ctx 取消 = 杀整棵树
	cmd.WaitDelay = mcpWaitPipeDelay                       // wrapper 子进程握管道时强制收尾

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("创建 stdout 管道失败：%w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("创建 stderr 管道失败：%w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("创建 stdin 管道失败：%w", err)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 MCP server 失败：%w", err)
	}
	c.cmd = cmd
	c.stdin = stdin
	c.stderrLog = &mcpRingBuffer{limit: mcpStderrRingMax}
	if closeJob, jobErr := mcpAttachJob(cmd); jobErr != nil {
		writeAppLog("warn", "MCP %s Job Object 附加失败（taskkill 兜底仍在）：%v", c.name, jobErr)
	} else {
		c.jobClose = closeJob
	}

	c.conn = newRPCConn(stdin, c.onNotification)
	go func() {
		if err := c.conn.serve(stdout); err != nil {
			writeAppLog("warn", "MCP %s 连接读取结束：%v", c.name, err)
		}
		if !c.closing.Load() && c.onLost != nil {
			c.onLost("stdout 读取结束（server 可能已退出）")
		}
		c.conn.shutdown() // EOF / 协议错乱 / 读错误都唤醒所有 pending
	}()
	go func() {
		_, _ = io.Copy(c.stderrLog, stderr) // 诊断专用环形缓冲，绝不与 stdout 混流
	}()
	go func() {
		c.waitErr = cmd.Wait() // Wait 只此一处；waitDone 关闭后 waitErr 可见
		close(c.waitDone)
		if !c.closing.Load() && c.onLost != nil {
			c.onLost("server 进程退出")
		}
	}()

	// 握手 + 工具清单共用启动预算
	hsCtx, hsCancel := context.WithTimeout(c.procCtx, c.cfg.startupTimeout())
	defer hsCancel()

	initParams := map[string]any{
		"protocolVersion": mcpProtocolVersion,
		"capabilities":    map[string]any{}, // 不声明 sampling/roots/elicitation，server 就不会发反向请求
		"clientInfo": map[string]any{
			"name":    mcpClientName,
			"version": strings.TrimPrefix(appVersion, "v"),
		},
	}
	raw, err := c.conn.call(hsCtx, "initialize", initParams)
	if err != nil {
		return fmt.Errorf("initialize 失败：%w", err)
	}
	var initResp struct {
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
		Instructions string `json:"instructions"`
	}
	_ = json.Unmarshal(raw, &initResp) // 容错：诊断字段解析失败不阻塞连接
	c.mu.Lock()
	c.serverName = initResp.ServerInfo.Name
	c.instructions = initResp.Instructions
	c.mu.Unlock()

	if err := c.conn.notify("notifications/initialized", map[string]any{}); err != nil {
		return fmt.Errorf("发送 initialized 通知失败：%w", err)
	}

	tools, err := c.listTools(hsCtx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.tools = tools
	c.mu.Unlock()
	c.setStatus(func(s *mcpStatus) {
		s.State = "connected"
		s.ToolCount = len(tools)
		s.LastError = ""
	})
	return nil
}

// listTools 分页拉完整工具清单；同一 server 重复列出同一原始名 → 整个列表判为无效。
func (c *mcpClient) listTools(ctx context.Context) (map[string]mcpRemoteTool, error) {
	tools := map[string]mcpRemoteTool{}
	cursor := ""
	for page := 0; ; page++ {
		if page >= mcpMaxListPages {
			writeAppLog("warn", "MCP %s tools/list 超过 %d 页，按截断处理", c.name, mcpMaxListPages)
			break
		}
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := c.conn.call(ctx, "tools/list", params)
		if err != nil {
			return nil, fmt.Errorf("tools/list 失败：%w", err)
		}
		var pageResp struct {
			Tools      []mcpRemoteTool `json:"tools"`
			NextCursor string          `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &pageResp); err != nil {
			return nil, fmt.Errorf("tools/list 响应解析失败：%w", err)
		}
		for _, t := range pageResp.Tools {
			if t.Name == "" {
				return nil, errors.New("tools/list 返回了空工具名")
			}
			if _, dup := tools[t.Name]; dup {
				return nil, fmt.Errorf("tools/list 重复列出工具 %q：整个列表判为无效", t.Name)
			}
			tools[t.Name] = t
		}
		if pageResp.NextCursor == "" {
			break
		}
		cursor = pageResp.NextCursor
	}
	return tools, nil
}

func (c *mcpClient) onNotification(msg *rpcMessage) {
	if msg.Method == "notifications/tools/list_changed" && c.onToolsChanged != nil {
		c.onToolsChanged()
	}
}

type mcpCallResult struct {
	Text    string `json:"text"`
	IsError bool   `json:"isError"`
}

// callTool 转发一次工具调用（只发原始名，公开名绝不发给 server）。
// RPC 层错误返回 error；server 侧的业务失败走 IsError（isError 结果不当异常）。
func (c *mcpClient) callTool(ctx context.Context, rawName string, args json.RawMessage) (mcpCallResult, error) {
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	params := map[string]any{"name": rawName, "arguments": json.RawMessage(args)}
	callCtx, cancel := context.WithTimeout(ctx, c.cfg.callTimeout())
	defer cancel()
	raw, err := c.conn.call(callCtx, "tools/call", params)
	if err != nil {
		return mcpCallResult{}, err
	}
	var resp struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			MimeType string `json:"mimeType"`
			Data     string `json:"data"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return mcpCallResult{}, fmt.Errorf("tools/call 响应解析失败：%w", err)
	}
	var b strings.Builder
	for _, item := range resp.Content {
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		switch item.Type {
		case "", "text":
			b.WriteString(item.Text)
		case "image", "audio":
			b.WriteString(fmt.Sprintf("[%s: %s，base64 %d 字符]", item.Type, item.MimeType, len(item.Data)))
		default:
			b.WriteString(fmt.Sprintf("[%s 内容略]", item.Type))
		}
	}
	return mcpCallResult{Text: mcpTruncateText(b.String(), mcpResultMaxBytes), IsError: resp.IsError}, nil
}

// mcpTruncateText 按字节截断但不截断 UTF-8 码点，并注明截断。
func mcpTruncateText(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return mcpTruncateUTF8(s, max) + "\n…（结果超过 256 KB 已截断）"
}

// mcpTruncateUTF8 按字节上限截断字符串，回退到码点边界。
func mcpTruncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}

// close 关闭连接并终止进程。先走优雅路径（stdin EOF），超预算再强制杀整棵树。
// CloseConfirmed=false 是硬信号：调用方必须阻止重连与替换连接。
func (c *mcpClient) close() mcpCloseResult {
	c.closing.Store(true)
	if c.stdin != nil {
		_ = c.stdin.Close() // 触发 server 优雅退出（EOF）；可能已关，忽略错误
	}
	if c.cmd == nil {
		return mcpCloseResult{CloseConfirmed: true}
	}
	select {
	case <-c.waitDone:
		c.shutdownAll()
		c.releaseJob()
		return mcpCloseResult{CloseConfirmed: true}
	case <-time.After(c.cfg.closeTimeout()):
		c.procCancel()  // 超预算：cmd.Cancel → 杀整棵树，WaitDelay 兜底管道
		c.releaseJob()  // 内核兜底：句柄关闭即杀整组（覆盖 taskkill 失败/孤儿场景）
		select {
		case <-c.waitDone:
			c.shutdownAll()
			return mcpCloseResult{CloseConfirmed: true, CleanupError: "关闭超预算，已强制终止进程树"}
		case <-time.After(mcpCloseForceWait):
			return mcpCloseResult{CloseConfirmed: false, CleanupError: "进程在关闭预算内未退出且未能强制终止"}
		}
	}
}

func (c *mcpClient) releaseJob() {
	if c.jobClose != nil {
		c.jobClose()
		c.jobClose = nil
	}
}

func (c *mcpClient) shutdownAll() {
	if c.conn != nil {
		c.conn.shutdown()
	}
	c.setStatus(func(s *mcpStatus) { s.State = "closed" })
}

func (c *mcpClient) setStatus(mutate func(*mcpStatus)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	mutate(&c.status)
}

func (c *mcpClient) setStatusFailed(reason, errText string) {
	c.setStatus(func(s *mcpStatus) {
		s.State = "failed"
		s.Reason = reason
		s.LastError = errText
	})
}

func (c *mcpClient) snapshotStatus() mcpStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

func (c *mcpClient) currentTools() map[string]mcpRemoteTool {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]mcpRemoteTool, len(c.tools))
	for k, v := range c.tools {
		out[k] = v
	}
	return out
}

func (c *mcpClient) diagnostics() (serverName, instructions, stderr string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.serverName, c.instructions, c.stderrLog.String()
}

// mcpProbeResult 探测结果。durationMs 不含清理时间——用户关心「多快能连上」。
type mcpProbeResult struct {
	Stage          string   `json:"stage"` // connect | list（空 = 成功）
	Error          string   `json:"error,omitempty"`
	Tools          []string `json:"tools,omitempty"`
	ToolCount      int      `json:"toolCount"`
	DurationMs     int64    `json:"durationMs"`
	CloseConfirmed bool     `json:"closeConfirmed"`
	CleanupError   string   `json:"cleanupError,omitempty"`
}

// mcpProbeServer 探测（设置页「测试连接」用）：总预算 10s，独立临时进程，只读——
// 不注册工具、不预留 namespace、绝不触碰活动实例。失败分阶段，用户能区分
// 「连不上」和「连上了但列不出工具」。
func mcpProbeServer(ctx context.Context, name string, cfg MCPServerConfig) mcpProbeResult {
	const budget = 10 * time.Second
	startedAt := time.Now()
	probeCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	client := newMCPClient(name, cfg)
	res := mcpProbeResult{}
	finish := func(stage, errText string) mcpProbeResult {
		cr := client.close()
		res.Stage = stage
		res.Error = errText
		res.DurationMs = time.Since(startedAt).Milliseconds()
		res.CloseConfirmed = cr.CloseConfirmed
		res.CleanupError = cr.CleanupError
		return res
	}

	if err := client.connect(probeCtx); err != nil {
		return finish("connect", err.Error())
	}
	tools := client.currentTools()
	names := make([]string, 0, len(tools))
	for n := range tools {
		names = append(names, n)
	}
	sort.Strings(names)
	if len(names) > mcpMaxProbeTools {
		names = names[:mcpMaxProbeTools]
	}
	res.Tools = names
	res.ToolCount = len(tools)
	return finish("", "")
}
