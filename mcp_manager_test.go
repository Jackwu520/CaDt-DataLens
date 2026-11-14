// mcp_manager_test.go：多 server 编排——惰性启动、快照发布、callTool 路由、
// 放弃重连、配置应用启停、总开关。重连策略注入微小时延保证测试快速且确定。
package main

import (
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func mcpManagerTestConfig(t *testing.T, mode string, tools []string) MCPConfig {
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("定位测试二进制失败：%v", err)
	}
	return MCPConfig{Version: mcpConfigVersion, MCPServers: map[string]MCPServerConfig{
		"fake": {Command: exe, Env: map[string]string{"MCP_FAKE_SERVER": mode}, EnabledTools: tools},
	}}
}

// newTestManager 构造注入了微小时延策略与事件收集的 manager。
func newTestManager(t *testing.T) (*mcpManager, *[]string, *sync.Mutex) {
	var mu sync.Mutex
	var events []string
	mgr := newMCPManager(func(event string, _ any) {
		mu.Lock()
		events = append(events, event)
		mu.Unlock()
	})
	mgr.policy = mcpReconnectPolicy{Enabled: true, InitialDelayMs: 10, MaxDelayMs: 20, MaxAttempts: 3}
	debugMgr = mgr
	return mgr, &events, &mu
}

func mcpWaitFor(t *testing.T, timeout time.Duration, cond func() bool, label string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等待超时：%s；快照：%+v", label, mgrSnapshotForDebug(t))
}

// mgrSnapshotForDebug 从当前测试关联的 manager 取快照（仅失败诊断用）。
var debugMgr *mcpManager

func mgrSnapshotForDebug(t *testing.T) any {
	if debugMgr == nil {
		return nil
	}
	return debugMgr.snapshot()
}

func TestMCPManagerLazyStartSnapshotCall(t *testing.T) {
	mgr, _, _ := newTestManager(t)
	defer mgr.closeAll()
	mgr.applyConfig(mcpManagerTestConfig(t, "ok", []string{"alpha", "beta"}))

	// 惰性：配置应用后不应立即连接
	if st := mgr.snapshot().Servers[0]; st.State == "connected" {
		t.Fatal("applyConfig 不应立即启动进程（首次需要工具清单才起）")
	}

	mgr.lazyStartAll()
	mcpWaitFor(t, 10*time.Second, func() bool {
		snap := mgr.snapshot()
		return len(snap.Servers) == 1 && snap.Servers[0].State == "connected" && snap.Servers[0].ToolCount == 2
	}, "server 未在预算内连接并注册工具")

	snap := mgr.snapshot()
	if !snap.Enabled || len(snap.Servers[0].Tools) != 2 {
		t.Fatalf("快照工具集不符：%+v", snap)
	}
	if snap.Servers[0].Tools[0].PublicName != "mcp__fake__alpha" && snap.Servers[0].Tools[1].PublicName != "mcp__fake__alpha" {
		t.Fatalf("公开名缺失：%+v", snap.Servers[0].Tools)
	}

	// callTool 按公开名路由到原始名
	result, err := mgr.callTool("mcp__fake__alpha", nil)
	if err != nil {
		t.Fatalf("callTool 失败：%v", err)
	}
	if !strings.Contains(result.Text, "hello from fake") {
		t.Fatalf("结果不符：%q", result.Text)
	}
	if _, err := mgr.callTool("mcp__fake__missing", nil); err == nil || !strings.Contains(err.Error(), "未知 MCP 工具") {
		t.Fatalf("未注册公开名应报未知工具：%v", err)
	}
}

func TestMCPManagerSkipsDisabledAndUnselected(t *testing.T) {
	mgr, _, _ := newTestManager(t)
	defer mgr.closeAll()
	disabled := false
	cfg := MCPConfig{Version: mcpConfigVersion, MCPServers: map[string]MCPServerConfig{
		"off":     {Command: "whatever", Enabled: &disabled, EnabledTools: []string{"alpha"}},
		"on-empty": {Command: "whatever", EnabledTools: []string{}}, // 勾选为空：一个都不给，也不起进程
	}}
	mgr.applyConfig(cfg)
	mgr.lazyStartAll()
	time.Sleep(300 * time.Millisecond)
	snap := mgr.snapshot()
	// 停用与空勾选的 server 不建运行态（off 不建、on-empty 建但不启动）
	if !snap.Enabled {
		t.Fatal("总开关应为启用")
	}
	for _, s := range snap.Servers {
		if s.State != "closed" {
			t.Fatalf("server %s 不应启动：%s", s.Name, s.State)
		}
		if s.ToolCount != 0 {
			t.Fatalf("server %s 不应有工具：%d", s.Name, s.ToolCount)
		}
	}
}

func TestMCPManagerGaveUpClearsTools(t *testing.T) {
	mgr, _, _ := newTestManager(t)
	defer mgr.closeAll()
	mgr.applyConfig(mcpManagerTestConfig(t, "crash", []string{"alpha"})) // 假 server 握手期即崩
	mgr.lazyStartAll()
	// 微小时延策略：3 次尝试 + 10/20ms 退避，秒级内到达 gave-up
	mcpWaitFor(t, 15*time.Second, func() bool {
		snap := mgr.snapshot()
		return len(snap.Servers) == 1 && snap.Servers[0].State == "failed" && snap.Servers[0].Reason == "gave-up"
	}, "未在预算内放弃重连")
	snap := mgr.snapshot()
	if snap.Servers[0].ToolCount != 0 || len(snap.Servers[0].Tools) != 0 {
		t.Fatalf("放弃时必须注销工具：%+v", snap.Servers[0])
	}
	// 注销后 callTool 报未知工具
	if _, err := mgr.callTool("mcp__fake__alpha", nil); err == nil {
		t.Fatal("工具注销后调用应报错")
	}
}

func TestMCPManagerApplyConfigRebuilds(t *testing.T) {
	mgr, _, _ := newTestManager(t)
	defer mgr.closeAll()
	mgr.applyConfig(mcpManagerTestConfig(t, "ok", []string{"alpha"}))
	mgr.lazyStartAll()
	mcpWaitFor(t, 10*time.Second, func() bool {
		snap := mgr.snapshot()
		return len(snap.Servers) == 1 && snap.Servers[0].ToolCount == 1
	}, "首次连接超时")

	// 仅勾选变化：不重启进程，直接用现有连接重建世代
	cfg := mcpManagerTestConfig(t, "ok", []string{"alpha", "beta"})
	mgr.applyConfig(cfg)
	mcpWaitFor(t, 10*time.Second, func() bool {
		snap := mgr.snapshot()
		return len(snap.Servers) == 1 && snap.Servers[0].ToolCount == 2
	}, "勾选变化未重建世代")

	// 配置变化（命令不同）：停旧起新
	cfg = mcpManagerTestConfig(t, "paged", []string{"t1"})
	fakeCfg := cfg.MCPServers["fake"]
	fakeCfg.Args = []string{"-mode", "paged"}
	cfg.MCPServers["fake"] = fakeCfg
	mgr.applyConfig(cfg)
	mcpWaitFor(t, 10*time.Second, func() bool {
		snap := mgr.snapshot()
		return len(snap.Servers) == 1 && snap.Servers[0].ToolCount == 1 && snap.Servers[0].State == "connected"
	}, "配置变化未重建 server")

	// 移除 server：停止并注销
	mgr.applyConfig(MCPConfig{Version: mcpConfigVersion, MCPServers: map[string]MCPServerConfig{}})
	mcpWaitFor(t, 10*time.Second, func() bool {
		snap := mgr.snapshot()
		return len(snap.Servers) == 0
	}, "移除配置后 server 未停止")
	if _, err := mgr.callTool("mcp__fake__t1", nil); err == nil {
		t.Fatal("server 移除后路由应失效")
	}
}

func TestMCPManagerMasterSwitch(t *testing.T) {
	mgr, _, _ := newTestManager(t)
	defer mgr.closeAll()
	mgr.applyConfig(mcpManagerTestConfig(t, "ok", []string{"alpha"}))
	mgr.lazyStartAll()
	mcpWaitFor(t, 10*time.Second, func() bool {
		snap := mgr.snapshot()
		return len(snap.Servers) == 1 && snap.Servers[0].ToolCount == 1
	}, "首次连接超时")

	off := false
	mgr.applyConfig(MCPConfig{Version: mcpConfigVersion, Enabled: &off, MCPServers: mcpManagerTestConfig(t, "ok", []string{"alpha"}).MCPServers})
	mcpWaitFor(t, 5*time.Second, func() bool {
		snap := mgr.snapshot()
		return !snap.Enabled && snap.Servers[0].ToolCount == 0 && snap.Servers[0].State == "closed"
	}, "总开关关闭未生效")

	// 重新打开：惰性重启
	mgr.applyConfig(mcpManagerTestConfig(t, "ok", []string{"alpha"}))
	mgr.lazyStartAll()
	mcpWaitFor(t, 10*time.Second, func() bool {
		snap := mgr.snapshot()
		return snap.Enabled && snap.Servers[0].ToolCount == 1
	}, "总开关重开后未恢复")
}

func TestMCPReconnectPolicyDelayFor(t *testing.T) {
	p := defaultMCPReconnectPolicy()
	cases := []struct {
		attempt int
		want    time.Duration
	}{
		{1, 500 * time.Millisecond},
		{2, 1000 * time.Millisecond},
		{3, 2000 * time.Millisecond},
		{10, 30 * time.Second}, // 500ms<<9 = 256s → 封顶 30s
		{11, 30 * time.Second},
	}
	for _, tc := range cases {
		if got := p.delayFor(tc.attempt); got != tc.want {
			t.Errorf("attempt %d 应为 %v，实际 %v", tc.attempt, tc.want, got)
		}
	}
	// 溢出防护：超大 attempt 不产生负值或 0
	if d := p.delayFor(100); d <= 0 || d > 30*time.Second {
		t.Fatalf("超大 attempt 应封顶，实际 %v", d)
	}
}

func TestMCPManagerCloseAll(t *testing.T) {
	mgr, _, _ := newTestManager(t)
	mgr.applyConfig(mcpManagerTestConfig(t, "ok", []string{"alpha", "beta"}))
	mgr.lazyStartAll()
	mcpWaitFor(t, 10*time.Second, func() bool {
		return mgr.snapshot().Servers[0].State == "connected"
	}, "首次连接超时")

	done := make(chan struct{})
	go func() { mgr.closeAll(); close(done) }()
	select {
	case <-done:
	case <-time.After(mcpCloseAllBudget + 10*time.Second):
		t.Fatal("closeAll 未在预算内返回")
	}
	snap := mgr.snapshot()
	if snap.Servers[0].State != "closed" || snap.Servers[0].ToolCount != 0 {
		t.Fatalf("closeAll 后应停止并注销工具：%+v", snap.Servers[0])
	}
}

func TestMCPManagerRawToolsForPanel(t *testing.T) {
	mgr, _, _ := newTestManager(t)
	defer mgr.closeAll()
	mgr.applyConfig(mcpManagerTestConfig(t, "ok", []string{})) // 空勾选：连接器不会自动启动
	// 未连接时面板拉取：临时起只读连接
	tools, err := mgr.rawToolsForPanel("fake")
	if err != nil {
		t.Fatalf("面板拉取失败：%v", err)
	}
	if len(tools) != 2 {
		t.Fatalf("面板工具数不符：%d", len(tools))
	}
	if tools[0].Name == "" || tools[0].Description == "" {
		t.Fatalf("面板工具应含原始名与描述：%+v", tools[0])
	}
	if mgr.snapshot().Servers[0].ToolCount != 0 {
		t.Fatal("面板拉取是只读的，不得注册工具")
	}
	if _, err := mgr.rawToolsForPanel("nope"); err == nil {
		t.Fatal("不存在的 server 应报错")
	}
}
