// mcp_env.go：MCP 子进程环境清洗——先过滤父进程环境里的疑似密钥，再合并显式配置的 env。
// 不清洗的话每个 MCP server 都能白拿用户父进程的全部 token；server 是第三方代码。
package mcp

import (
	"os"
	"regexp"
	"strings"
)

// 疑似密钥的环境名一律不传给 MCP server。比 dsh 多过滤 AUTH / CREDENTIAL / PASSWD，
// 代价是误杀（如 SSH_AUTH_SOCK），用户可在 server 的 env 里显式补回。
var mcpSecretEnvPattern = regexp.MustCompile(`(?i)KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|PASSWD|AUTH`)

// mcpChildEnv 构造子进程环境：清洗后的父进程环境 + 显式配置。
// 显式 env 不受过滤——用户写什么就传什么，这是他的授权行为；同名变量显式配置覆盖继承值。
func mcpChildEnv(extra map[string]string) []string {
	extraLower := make(map[string]string, len(extra))
	for k := range extra {
		extraLower[strings.ToLower(k)] = ""
	}
	env := make([]string, 0, len(os.Environ())+len(extra))
	for _, kv := range os.Environ() {
		name, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if mcpSecretEnvPattern.MatchString(name) || strings.HasPrefix(strings.ToUpper(name), "CADT_") ||
			strings.HasPrefix(strings.ToUpper(name), "WAILS_MCP_") {
			continue // 疑似密钥 / 本应用私有变量（含宿主 MCP 凭据）：一律不传
		}
		if _, overridden := extraLower[strings.ToLower(name)]; overridden {
			continue // 显式配置将覆盖同名变量，避免重复键
		}
		env = append(env, kv)
	}
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
