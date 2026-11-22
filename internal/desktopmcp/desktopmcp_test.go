package desktopmcp

// desktopmcp_test.go：内嵌分发层的纯逻辑用例——工具清单、配置行、自愈识别、行切分。
// 都不起子进程、不碰网络，毫秒级。

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"

	"datalens/internal/mcp"
)

func TestAllToolsCoverUpstream(t *testing.T) {
	// 上游 0.8.9 的 13 个工具模块注册 21 个工具；+p2 起本地补丁加了 Find（共 22 个）。
	// 升级上游版本时这张表必须同步，否则用户在设置页看不到新工具。
	want := []string{
		"Snapshot", "Screenshot", "DisplayInventory", "Click", "Type", "Scroll", "Move",
		"Shortcut", "Wait", "WaitFor", "Find", "Clipboard", "Scrape", "MultiSelect", "MultiEdit",
		"App", "Notification", "Process", "PowerShell", "FileSystem", "Registry", "ControlStatus",
	}
	got := ToolNames()
	if len(got) != len(want) {
		t.Fatalf("工具数不一致：got %d want %d (%v)", len(got), len(want), got)
	}
	seen := map[string]bool{}
	for _, name := range got {
		if seen[name] {
			t.Fatalf("清单里有重复工具：%s", name)
		}
		seen[name] = true
	}
	for _, name := range want {
		if !seen[name] {
			t.Fatalf("缺少上游工具：%s", name)
		}
		if !HasTool(name) {
			t.Fatalf("HasTool 对 %s 返回 false", name)
		}
	}
	if HasTool("NotATool") {
		t.Fatal("HasTool 对未登记工具返回了 true")
	}
}

func TestServerConfigDefaults(t *testing.T) {
	wheel := `D:\data\builtin-desktop-mcp\0.8.9\windows_mcp-0.8.9-py3-none-any.whl`
	cfg := ServerConfig(wheel)
	if cfg.Command != "uvx" {
		t.Fatalf("command 应为 uvx，实际 %q", cfg.Command)
	}
	wantArgs := []string{"--from", wheel, "windows-mcp", "serve", "--no-control"}
	if len(cfg.Args) != len(wantArgs) {
		t.Fatalf("args 长度不符：got %v", cfg.Args)
	}
	for i, arg := range wantArgs {
		if cfg.Args[i] != arg {
			t.Fatalf("args[%d] 应为 %q，实际 %q", i, arg, cfg.Args[i])
		}
	}
	if cfg.Enabled == nil || !*cfg.Enabled {
		t.Fatal("默认应启用（Enabled=true）")
	}
	// 空数组语义是「一个都不给」，所以默认必须显式全选。
	if len(cfg.EnabledTools) != len(AllTools) {
		t.Fatalf("默认勾选数应为 %d，实际 %d", len(AllTools), len(cfg.EnabledTools))
	}
	if cfg.StartupTimeoutMs != startupTimeoutMs {
		t.Fatalf("启动超时应为 %d，实际 %d", startupTimeoutMs, cfg.StartupTimeoutMs)
	}
	if cfg.Env["WINDOWS_MCP_DISABLE_FLASH"] != "1" {
		t.Fatalf("env 缺 DISABLE_FLASH：%v", cfg.Env)
	}
	if cfg.Notes == "" {
		t.Fatal("notes 不能为空（模型唯一的使用约定来源）")
	}
}

func TestIsOurConfig(t *testing.T) {
	root := rootDir()
	if root == "" {
		t.Skip("无法定位应用数据目录")
	}
	ours := ServerConfig(WheelPath()).Args
	if !isOurConfig(mcp.MCPServerConfig{Args: ours}) {
		t.Fatal("指向释放目录的配置应被识别为我们管理的行")
	}
	// ourWheelPath 必须返回配置里的真实路径（自愈按它补文件，而不是按当前版本路径）
	got := ourWheelPath(mcp.MCPServerConfig{Args: ours})
	if got == "" {
		t.Fatal("ourWheelPath 没有解析出配置里的 wheel 路径")
	}
	want, _ := filepath.Abs(WheelPath())
	if !strings.EqualFold(got, want) {
		t.Fatalf("ourWheelPath 应返回配置里的路径 %q，实际 %q", want, got)
	}

	foreign := []string{"--from", `C:\users\x\other\windows_mcp-0.8.9-py3-none-any.whl`, "windows-mcp"}
	if isOurConfig(mcp.MCPServerConfig{Args: foreign}) {
		t.Fatal("用户自备的 wheel 路径不应被当作我们管理的行")
	}
	// 兄弟目录不能被前缀匹配误命中（<root>/builtin-desktop-mcp-evil/...）
	sibling := []string{"--from", filepath.Join(root, "builtin-desktop-mcp-evil", "x.whl"), "windows-mcp"}
	if isOurConfig(mcp.MCPServerConfig{Args: sibling}) {
		t.Fatal("兄弟目录不应被前缀匹配误判为我们管理的行")
	}
	if isOurConfig(mcp.MCPServerConfig{Args: []string{"windows-mcp@0.8.9", "serve"}}) {
		t.Fatal("没有 --from 的旧形态不应命中自愈")
	}
}

// 版本升级后 mcp.json 仍指旧目录：自愈必须按**配置里的路径**补回，而不是当前版本路径
// （2026-11-23 审查 H1）。这里用可注入的临时根验证真实写盘行为。
func TestEnsureServerWheelUsesConfiguredPath(t *testing.T) {
	dir := t.TempDir()
	oldWheel := filepath.Join(dir, "builtin-desktop-mcp", "0.8.9", WheelName)
	cfg := mcp.MCPServerConfig{Args: []string{"--from", oldWheel, "windows-mcp", "serve", "--no-control"}}

	if _, err := os.Stat(oldWheel); err == nil {
		t.Fatal("前置条件不成立：旧路径不该已存在")
	}
	// 换到临时根，注入假 wheel 内容，验证真实写盘（不动真实应用数据目录）
	prevRoot := testRootOverride
	prevFS := Embedded
	testRootOverride = dir
	Embedded = fstest.MapFS{wheelEmbedPath: &fstest.MapFile{Data: []byte("fake-wheel-bytes")}}
	defer func() {
		testRootOverride = prevRoot
		Embedded = prevFS
	}()

	EnsureServerWheel(cfg)

	got, err := os.ReadFile(oldWheel)
	if err != nil {
		t.Fatalf("自愈应按配置里的旧路径补回 wheel，但 %s 不存在：%v", oldWheel, err)
	}
	if string(got) != "fake-wheel-bytes" {
		t.Fatalf("补回的内容不对：%q", got)
	}
}

// 资源未注入时必须返回错误而不是 panic（fs.ReadFile(nil,…) 会崩）。
func TestWriteEmbeddedWheelWithoutFS(t *testing.T) {
	prevFS := Embedded
	Embedded = nil
	defer func() { Embedded = prevFS }()
	if err := writeEmbeddedWheel(filepath.Join(t.TempDir(), "x.whl")); err == nil {
		t.Fatal("Embedded 为 nil 时应返回错误")
	}
}

// 回调在锁内串行执行：两条流并发写进度不得丢更新（-race 下也不会报数据竞争）。
func TestRunStreamingSerializesCallback(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	var concurrent int32
	cmd := exec.Command("cmd", "/c", "echo a& echo b& echo c")
	err := runStreaming(cmd, func(line string) {
		if atomic.AddInt32(&concurrent, 1) > 1 {
			t.Error("回调被并发执行：stdout/stderr 的进度写入会出现 data race")
		}
		mu.Lock()
		seen = append(seen, line)
		mu.Unlock()
		atomic.AddInt32(&concurrent, -1)
	})
	if err != nil {
		t.Fatalf("runStreaming 失败：%v", err)
	}
	if len(seen) != 3 {
		t.Fatalf("应看到 3 行输出，实际 %d：%v", len(seen), seen)
	}
}

func TestSplitAnyLine(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []string
	}{
		{"换行", "a\nb\n", []string{"a", "b"}},
		{"回车覆盖", "10%\r20%\r100%\n", []string{"10%", "20%", "100%"}},
		{"CRLF", "a\r\nb\r\n", []string{"a", "b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			scanAnyLines(strings.NewReader(tc.input), func(line string) { got = append(got, line) })
			if len(got) != len(tc.want) {
				t.Fatalf("行数不符：got %v want %v", got, tc.want)
			}
			for i, want := range tc.want {
				if got[i] != want {
					t.Fatalf("第 %d 行应为 %q，实际 %q", i, want, got[i])
				}
			}
		})
	}
}

func TestBuildPlanShape(t *testing.T) {
	plan := BuildPlan()
	if plan.Version != Version {
		t.Fatalf("version 不符：%q", plan.Version)
	}
	if plan.ServerName != ServerName {
		t.Fatalf("serverName 不符：%q", plan.ServerName)
	}
	if len(plan.Tools) != len(AllTools) {
		t.Fatalf("计划里的工具数应为 %d，实际 %d", len(AllTools), len(plan.Tools))
	}
	if len(plan.EnabledTools) != len(AllTools) {
		t.Fatal("计划默认勾选应为全量")
	}
	if plan.Command != "uvx" {
		t.Fatalf("command 不符：%q", plan.Command)
	}
}
