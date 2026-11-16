// mcp_name_test.go：工具命名纯函数——干净名不加 hash、有损名加 12 位 hash、身份不折叠、超长截断。
package mcp

import (
	"regexp"
	"strings"
	"testing"
)

var mcpNameShapeRule = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func TestMCPNameCleanNoHash(t *testing.T) {
	// 绝大多数工具是这种可读形态：加 hash 会污染每一次工具调用的 token
	if got := mcpPublicToolName("github", "create_issue"); got != "mcp__github__create_issue" {
		t.Fatalf("干净名不应加 hash：%q", got)
	}
}

func TestMCPNameLossyGetsHash(t *testing.T) {
	cases := []struct {
		label       string
		server, raw string
	}{
		{"点号", "context7", "resolve-library-id.txt"},
		{"斜杠", "ns", "a/b"},
		{"中文", "中文服务器", "工具甲"},
		{"超长", "s", strings.Repeat("x", 200)},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			got := mcpPublicToolName(tc.server, tc.raw)
			if !mcpNameShapeRule.MatchString(got) {
				t.Fatalf("公开名必须匹配 aiToolNameRule（≤64，字母数字下划线连字符）：%q", got)
			}
			if !strings.HasSuffix(got, "_"+got[len(got)-12:]) {
				t.Fatal("hash 后缀应保留 12 位")
			}
			// 同一身份必须稳定（纯函数：会话历史与白名单跨重连有效）
			if again := mcpPublicToolName(tc.server, tc.raw); again != got {
				t.Fatalf("命名不稳定：%q vs %q", got, again)
			}
		})
	}
}

func TestMCPNameIdentitiesDoNotCollapse(t *testing.T) {
	// server "a.b" + raw "c" 与 server "a" + raw "b.c" 规范化后同串，hash 输入用原始身份才能分开
	n1 := mcpPublicToolName("a.b", "c")
	n2 := mcpPublicToolName("a", "b.c")
	if n1 == n2 {
		t.Fatalf("不同身份不得折叠为同一公开名：%q", n1)
	}
}

func TestMCPNameTruncationKeepsHash(t *testing.T) {
	server := strings.Repeat("s", 32)   // server 段上限
	raw := strings.Repeat("r", 120)     // 超长原始名
	got := mcpPublicToolName(server, raw)
	if len(got) != mcpPublicNameMax {
		t.Fatalf("截断后应恰为 64 字符：%d", len(got))
	}
	hash := got[len(got)-12:]
	for _, c := range hash {
		if !strings.ContainsRune("0123456789abcdef", c) {
			t.Fatalf("hash 应为 12 位十六进制：%q", hash)
		}
	}
}

func TestMCPNameServerBoundary(t *testing.T) {
	// serverName 32 字符是配置校验期强制的；命名函数对 32 字符内的干净名直接拼
	name := strings.Repeat("a", 32)
	if got := mcpPublicToolName(name, "tool"); got != "mcp__"+name+"__tool" {
		t.Fatalf("32 字符干净 server 名不应触发 hash：%q", got)
	}
	if len(mcpPublicToolName(name, "tool")) > mcpPublicNameMax {
		t.Fatal("超长 64 应触发截断路径")
	}
}
