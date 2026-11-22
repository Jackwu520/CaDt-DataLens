package desktopmcp

// desktopmcp_test.go：内嵌分发层的纯逻辑用例——工具清单、配置行、自愈识别、行切分。
// 都不起子进程、不碰网络，毫秒级。

import (
	"strings"
	"testing"

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
	foreign := []string{"--from", `C:\users\x\other\windows_mcp-0.8.9-py3-none-any.whl`, "windows-mcp"}
	if isOurConfig(mcp.MCPServerConfig{Args: foreign}) {
		t.Fatal("用户自备的 wheel 路径不应被当作我们管理的行")
	}
	if isOurConfig(mcp.MCPServerConfig{Args: []string{"windows-mcp@0.8.9", "serve"}}) {
		t.Fatal("没有 --from 的旧形态不应命中自愈")
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
