package mcp

import (
	"sync"
	"testing"
)

// 未初始化的 Client（浮窗 / 调试控制台进程）不应拉子进程，绑定方法返回未启用。
func TestClientNotInitialized(t *testing.T) {
	var c Client
	snap := c.MCPSnapshot()
	if snap.Enabled {
		t.Fatal("未初始化时不应启用")
	}
	if snap.Servers == nil {
		t.Fatal("未初始化时 Servers 应为空数组而非 nil")
	}
	if _, err := c.MCPCallTool("t", "{}"); err == nil {
		t.Fatal("未初始化时调用应报错")
	}
	if _, err := c.MCPListServerTools("s"); err == nil {
		t.Fatal("未初始化时列工具应报错")
	}
	if err := c.MCPRestartServer("s"); err == nil {
		t.Fatal("未初始化时重启应报错")
	}
}

func TestClientInitAndInvalidArgs(t *testing.T) {
	old := AppDataDir
	dir := t.TempDir()
	AppDataDir = func() string { return dir }
	t.Cleanup(func() { AppDataDir = old })

	var c Client
	if err := InitClient(&c, func(string, any) {}); err != nil {
		t.Fatalf("空配置应正常初始化: %v", err)
	}
	if c.manager() == nil {
		t.Fatal("初始化后管理器不应为 nil")
	}
	if _, err := c.MCPCallTool("t", "{bad"); err == nil {
		t.Fatal("非法 JSON 参数应报错")
	}
	if err := c.MCPSetServerEnabled("missing", true); err == nil {
		t.Fatal("不存在的服务器应报错")
	}
	CloseClient(&c)
}

// 内置示例安装绕过 Client 直接写 mcp.json：ApplyConfigFromDisk 必须把盘上的新 server 挂进
// 运行态并发 mcp-tools-changed，否则列表不刷新、要退出重进（用户实测）。
func TestApplyConfigFromDiskPicksUpNewServer(t *testing.T) {
	old := AppDataDir
	dir := t.TempDir()
	AppDataDir = func() string { return dir }
	t.Cleanup(func() { AppDataDir = old })

	var mu sync.Mutex
	var events []string
	var c Client
	if err := InitClient(&c, func(event string, _ any) {
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	}); err != nil {
		t.Fatalf("初始化失败: %v", err)
	}
	defer CloseClient(&c)

	// 模拟 mcpsamples 直接写盘（不经过 MCPWriteConfig）。
	cfg := MCPConfig{Version: mcpConfigVersion, MCPServers: map[string]MCPServerConfig{
		"new_server": {Command: "cmd", EnabledTools: []string{"tool_a"}},
	}}
	if err := WriteConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if len(c.MCPSnapshot().Servers) != 0 {
		t.Fatal("应用前不应有 server")
	}
	if err := ApplyConfigFromDisk(&c); err != nil {
		t.Fatalf("应用失败: %v", err)
	}
	snap := c.MCPSnapshot()
	if len(snap.Servers) != 1 || snap.Servers[0].Name != "new_server" {
		t.Fatalf("应用后应出现新 server：%+v", snap.Servers)
	}
	mu.Lock()
	gotEvents := append([]string(nil), events...)
	mu.Unlock()
	found := false
	for _, e := range gotEvents {
		if e == "mcp-tools-changed" {
			found = true
		}
	}
	if !found {
		t.Fatalf("应用后必须发 mcp-tools-changed 让前端刷新，实际事件：%v", gotEvents)
	}
}
