package mcp

import "testing"

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
