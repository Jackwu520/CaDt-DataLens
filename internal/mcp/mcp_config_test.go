// mcp_config_test.go：MCP 配置读写与校验——缺文件返回空、损坏不覆盖、重复键、写入期校验、缺省语义。
package mcp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMCPReadConfigMissing(t *testing.T) {
	cfg, err := readMCPConfigAt(filepath.Join(t.TempDir(), "mcp.json"))
	if err != nil {
		t.Fatalf("缺文件应返回空配置不报错，实际：%v", err)
	}
	if len(cfg.MCPServers) != 0 {
		t.Fatalf("缺文件应得到空 servers，实际：%+v", cfg.MCPServers)
	}
}

func TestMCPReadConfigBrokenNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	broken := `{"version":1,"mcpServers":{"a":{broken`
	if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMCPConfigAt(path); err == nil {
		t.Fatal("损坏 JSON 应报错")
	}
	// 关键：损坏文件必须原样保留，绝不自动重写成空配置
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != broken {
		t.Fatal("读取失败后配置文件被改动了（会洗掉用户手写内容）")
	}
}

func TestMCPReadConfigOversize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	big := strings.Repeat("x", mcpConfigFileMax+1)
	if err := os.WriteFile(path, []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMCPConfigAt(path); err == nil || !strings.Contains(err.Error(), "超过") {
		t.Fatalf("超限应报错，实际：%v", err)
	}
}

func TestMCPReadConfigDuplicateKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(path, []byte(`{"version":1,"version":2}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMCPConfigAt(path); err == nil || !strings.Contains(err.Error(), "重复键") {
		t.Fatalf("顶层重复键应报错，实际：%v", err)
	}
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"a":{"command":"x"},"a":{"command":"y"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMCPConfigAt(path); err == nil || !strings.Contains(err.Error(), "重复键") {
		t.Fatalf("mcpServers 内重复键应报错，实际：%v", err)
	}
}

func TestMCPReadConfigUnsupportedVersion(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(path, []byte(`{"version":99,"mcpServers":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMCPConfigAt(path); err == nil || !strings.Contains(err.Error(), "版本") {
		t.Fatalf("未知版本应报错，实际：%v", err)
	}
}

func TestMCPConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp.json")
	enabled := false
	cfg := MCPConfig{Version: mcpConfigVersion, MCPServers: map[string]MCPServerConfig{
		"playwright": {Command: "npx", Args: []string{"-y", "@playwright/mcp"}, Env: map[string]string{"K": "v"},
			Enabled: &enabled, EnabledTools: []string{"browser_click"}},
		"github": {Command: "github-mcp", EnabledTools: []string{}},
	}}
	if err := writeMCPConfigAt(path, cfg); err != nil {
		t.Fatalf("写入失败：%v", err)
	}
	got, err := readMCPConfigAt(path)
	if err != nil {
		t.Fatalf("回读失败：%v", err)
	}
	if len(got.MCPServers) != 2 {
		t.Fatalf("回读 server 数不符：%d", len(got.MCPServers))
	}
	if got.MCPServers["playwright"].Command != "npx" || len(got.MCPServers["playwright"].Args) != 2 {
		t.Fatalf("回读字段不符：%+v", got.MCPServers["playwright"])
	}
	// Enabled 显式 false 必须落盘保留（不能被缺省 true 吞掉）
	if got.MCPServers["playwright"].Enabled == nil || *got.MCPServers["playwright"].Enabled {
		t.Fatal("显式 false 的 Enabled 应落盘保留")
	}
	if !mcpServerEnabled(got.MCPServers["github"]) {
		t.Fatal("Enabled 缺省应视为启用")
	}
}

func TestMCPWriteRejectsBadEntries(t *testing.T) {
	cases := []struct {
		label string
		name  string
		cfg   MCPServerConfig
		want  string
	}{
		{"名称非法字符", "bad name", MCPServerConfig{Command: "x"}, "不合法"},
		{"名称超长", strings.Repeat("a", 33), MCPServerConfig{Command: "x"}, "不合法"},
		{"缺命令", "ok", MCPServerConfig{}, "缺少启动命令"},
		{"参数超限", "ok", MCPServerConfig{Command: "x", Args: make([]string, mcpMaxArgsCount+1)}, "参数个数"},
		{"超时负值", "ok", MCPServerConfig{Command: "x", CallTimeoutMs: -1}, "毫秒"},
		{"超时超上限", "ok", MCPServerConfig{Command: "x", StartupTimeoutMs: mcpTimeoutMaxMs + 1}, "毫秒"},
		{"空工具名", "ok", MCPServerConfig{Command: "x", EnabledTools: []string{" "}}, "不能为空"},
		{"工具名非法", "ok", MCPServerConfig{Command: "x", EnabledTools: []string{"bad tool!"}}, "不合法"},
		{"工具重复勾选", "ok", MCPServerConfig{Command: "x", EnabledTools: []string{"a", "a"}}, "重复勾选"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			err := ValidateServer(tc.name, tc.cfg)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("应拒绝（含 %q），实际：%v", tc.want, err)
			}
		})
	}
}

func TestMCPValidateServerAccepts(t *testing.T) {
	// 合法条目：原始工具名允许点号（context7.resolve-library-id 一类）
	if err := ValidateServer("ctx7", MCPServerConfig{
		Command: "npx", EnabledTools: []string{"resolve-library-id", "context7.get-docs"},
	}); err != nil {
		t.Fatalf("合法条目不应报错：%v", err)
	}
}

func TestMCPCheckDuplicateKeysRejects(t *testing.T) {
	cases := []struct {
		label string
		raw   string
		want  string
	}{
		{"顶层重复", `{"a":1,"a":2}`, "重复键"},
		{"嵌套重复", `{"mcpServers":{"s":{"command":"a","command":"b"}}}`, "重复键"},
		{"数组内对象重复", `{"list":[{"x":1,"x":2}]}`, "重复键"},
		{"顶层非对象", `[1,2]`, "顶层"},
		{"尾部多余内容", `{} {}`, "多余内容"},
		{"非法 JSON", `{nope`, "JSON"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			err := mcpCheckDuplicateKeys([]byte(tc.raw))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("应拒绝（含 %q），实际：%v", tc.want, err)
			}
		})
	}
	if err := mcpCheckDuplicateKeys([]byte(`{"a":1,"b":{"c":[1,{"d":2}],"e":"x"}}`)); err != nil {
		t.Fatalf("合法 JSON 不应报错：%v", err)
	}
}

func TestMCPServerTimeoutDefaults(t *testing.T) {
	var empty MCPServerConfig
	if empty.startupTimeout() != mcpDefaultStartupTimeoutMs*time.Millisecond {
		t.Fatal("启动超时默认值不符")
	}
	if empty.callTimeout() != mcpDefaultCallTimeoutMs*time.Millisecond {
		t.Fatal("调用超时默认值不符")
	}
	if empty.closeTimeout() != mcpDefaultCloseTimeoutMs*time.Millisecond {
		t.Fatal("关闭超时默认值不符")
	}
	custom := MCPServerConfig{StartupTimeoutMs: 100, CallTimeoutMs: 200, CloseTimeoutMs: 300}
	if custom.startupTimeout() != 100*time.Millisecond ||
		custom.callTimeout() != 200*time.Millisecond ||
		custom.closeTimeout() != 300*time.Millisecond {
		t.Fatal("自定义超时不符")
	}
}
