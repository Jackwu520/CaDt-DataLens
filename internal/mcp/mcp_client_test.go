// mcp_client_test.go：连接桥的进程级测试——假 server 用 go test 二进制自调用（见 mcp_fakeserver_test.go）。
package mcp

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// mcpTestServerConfig 用测试二进制自己当 MCP server：Command = os.Executable()，
// mode 经 env 显式传入（显式 env 不受清洗过滤，见 mcp_env.go）。
func mcpTestServerConfig(t *testing.T, mode string, mutate func(*MCPServerConfig)) MCPServerConfig {
	t.Helper()
	// 防递归护栏：子进程带着 MCP_FAKE_SERVER 却仍在跑测试，说明 TestMain 没接住
	// （典型原因：mcp_fakeserver_test.go 没和 MCP 测试同包）。此时必须立刻失败，
	// 否则每层测试都会再拉起一层子进程，进程树指数增长拖垮整机。
	if active := os.Getenv("MCP_FAKE_SERVER"); active != "" {
		t.Fatalf("测试进程带着 MCP_FAKE_SERVER=%s 在跑测试：假 server 的 TestMain 未生效，拒绝递归拉起", active)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("定位测试二进制失败：%v", err)
	}
	cfg := MCPServerConfig{
		Command: exe,
		Env:     map[string]string{"MCP_FAKE_SERVER": mode},
	}
	if mutate != nil {
		mutate(&cfg)
	}
	return cfg
}

func mcpConnectForTest(t *testing.T, mode string, mutate func(*MCPServerConfig)) *mcpClient {
	t.Helper()
	client := newMCPClient("test-server", mcpTestServerConfig(t, mode, mutate))
	if err := client.connect(context.Background()); err != nil {
		t.Fatalf("connect 失败：%v", err)
	}
	t.Cleanup(func() { client.close() })
	return client
}

func TestMCPClientConnectListCall(t *testing.T) {
	client := mcpConnectForTest(t, "ok", nil)

	tools := client.currentTools()
	if len(tools) != 2 {
		t.Fatalf("工具数应为 2，实际 %d：%+v", len(tools), tools)
	}
	if _, ok := tools["alpha"]; !ok {
		t.Fatalf("缺少工具 alpha：%+v", tools)
	}
	st := client.snapshotStatus()
	if st.State != "connected" || st.ToolCount != 2 {
		t.Fatalf("状态应为 connected/2，实际：%+v", st)
	}

	result, err := client.CallTool(context.Background(), "alpha", nil)
	if err != nil {
		t.Fatalf("callTool 失败：%v", err)
	}
	if result.IsError {
		t.Fatal("正常调用不应 isError")
	}
	if !strings.Contains(result.Text, "hello from fake") {
		t.Fatalf("结果文本不符：%q", result.Text)
	}

	// args 以 JSON 原样透传
	result, err = client.CallTool(context.Background(), "beta", []byte(`{"x":1}`))
	if err != nil {
		t.Fatalf("带参调用失败：%v", err)
	}
	if result.IsError {
		t.Fatal("带参调用不应 isError")
	}
}

func TestMCPClientPagedTools(t *testing.T) {
	client := mcpConnectForTest(t, "paged", nil)
	tools := client.currentTools()
	for _, name := range []string{"t1", "t2", "t3", "t4", "t5"} {
		if _, ok := tools[name]; !ok {
			t.Fatalf("分页工具 %s 缺失：%+v", name, tools)
		}
	}
	if len(tools) != 5 {
		t.Fatalf("分页工具总数应为 5，实际 %d", len(tools))
	}
}

func TestMCPClientDuplicateToolsRejected(t *testing.T) {
	client := newMCPClient("test-server", mcpTestServerConfig(t, "duplicate", nil))
	err := client.connect(context.Background())
	if err == nil || !strings.Contains(err.Error(), "重复列出工具") {
		t.Fatalf("重复工具名应判整个列表无效，实际：%v", err)
	}
	client.close()
}

func TestMCPClientCallIsError(t *testing.T) {
	client := mcpConnectForTest(t, "toolerr", nil)
	result, err := client.CallTool(context.Background(), "alpha", nil)
	if err != nil {
		t.Fatalf("isError 结果不当异常，call 层不应报错：%v", err)
	}
	if !result.IsError {
		t.Fatal("isError 应为 true")
	}
	if !strings.Contains(result.Text, "boom") {
		t.Fatalf("isError 结果文本应保留：%q", result.Text)
	}
}

func TestMCPClientCallRPCError(t *testing.T) {
	client := mcpConnectForTest(t, "rpcerr", nil)
	_, err := client.CallTool(context.Background(), "alpha", nil)
	var rpcErr *rpcError
	if err == nil {
		t.Fatal("RPC 错误应上抛")
	}
	if _, ok := err.(*rpcError); !ok {
		t.Fatalf("错误类型应为 *rpcError，实际 %T：%v", err, err)
	}
	_ = rpcErr
}

func TestMCPClientBannerTolerated(t *testing.T) {
	client := mcpConnectForTest(t, "banner", nil)
	if len(client.currentTools()) != 2 {
		t.Fatal("banner 前缀不应影响握手与工具列表")
	}
}

func TestMCPClientGarbageFloodFails(t *testing.T) {
	client := newMCPClient("test-server", mcpTestServerConfig(t, "garbage", nil))
	err := client.connect(context.Background())
	if err == nil {
		client.close()
		t.Fatal("垃圾行洪泛应导致连接失败")
	}
	client.close()
}

func TestMCPClientCrashOnInitialize(t *testing.T) {
	client := newMCPClient("test-server", mcpTestServerConfig(t, "crash", nil))
	err := client.connect(context.Background())
	if err == nil {
		client.close()
		t.Fatal("server 崩溃应导致 connect 失败")
	}
	cr := client.close()
	if !cr.CloseConfirmed {
		t.Fatalf("崩溃后的关闭应视为已确认（进程已不在），实际：%+v", cr)
	}
}

func TestMCPClientSlowStartupTimesOut(t *testing.T) {
	client := newMCPClient("test-server", mcpTestServerConfig(t, "slow", func(c *MCPServerConfig) {
		c.StartupTimeoutMs = 100 // fake server 延迟 300ms
	}))
	err := client.connect(context.Background())
	if err == nil || !strings.Contains(err.Error(), "initialize") {
		t.Fatalf("启动超时应报 initialize 失败，实际：%v", err)
	}
	client.close()
}

func TestMCPClientCloseOverBudget(t *testing.T) {
	client := mcpConnectForTest(t, "no-terminate", func(c *MCPServerConfig) {
		c.CloseTimeoutMs = 400 // fake server 拒绝退出
	})
	cr := client.close()
	if !cr.CloseConfirmed {
		t.Fatalf("强制终止后应视为确认关闭，实际：%+v", cr)
	}
	if !strings.Contains(cr.CleanupError, "超预算") {
		t.Fatalf("清理错误应注明超预算：%q", cr.CleanupError)
	}
	// 进程必须真死了（不叠实例）
	select {
	case <-client.waitDone:
	case <-time.After(10 * time.Second):
		t.Fatal("强制终止后 cmd.Wait 未返回")
	}
}

func TestMCPClientCloseTwice(t *testing.T) {
	client := mcpConnectForTest(t, "ok", nil)
	if cr := client.close(); !cr.CloseConfirmed {
		t.Fatalf("首次关闭应确认，实际：%+v", cr)
	}
	if cr := client.close(); !cr.CloseConfirmed {
		t.Fatalf("重复关闭应幂等，实际：%+v", cr)
	}
}

func TestMCPProbeServer(t *testing.T) {
	res := ProbeServer(context.Background(), "probe-server", mcpTestServerConfig(t, "ok", nil))
	if res.Error != "" {
		t.Fatalf("探测不应失败：%s", res.Error)
	}
	if res.Stage != "" {
		t.Fatalf("成功探测不应有失败阶段：%s", res.Stage)
	}
	if res.ToolCount != 2 || len(res.Tools) != 2 {
		t.Fatalf("探测工具数不符：%+v", res)
	}
	if res.DurationMs <= 0 {
		t.Fatal("探测应报告耗时")
	}
	if !res.CloseConfirmed {
		t.Fatal("探测收尾应确认关闭")
	}
}

func TestMCPProbeServerConnectFailure(t *testing.T) {
	res := ProbeServer(context.Background(), "probe-server", MCPServerConfig{
		Command: "definitely-not-exists-xyz.exe",
	})
	if res.Stage != "connect" {
		t.Fatalf("失败应标注 connect 阶段，实际：%s", res.Stage)
	}
	if res.Error == "" {
		t.Fatal("失败应有错误信息")
	}
}

func TestMCPTruncateText(t *testing.T) {
	if got := mcpTruncateText("short", 100); got != "short" {
		t.Fatalf("不超限不应截断：%q", got)
	}
	long := strings.Repeat("汉", 200000) // 400 KB UTF-8
	got := mcpTruncateText(long, mcpResultMaxBytes)
	if len(got) > mcpResultMaxBytes+200 {
		t.Fatalf("截断后长度失控：%d", len(got))
	}
	if !strings.Contains(got, "已截断") {
		t.Fatal("截断应带说明")
	}
}
