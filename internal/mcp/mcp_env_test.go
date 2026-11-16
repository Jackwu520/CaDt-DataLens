// mcp_env_test.go：MCP 子进程环境清洗的表驱动测试。
package mcp

import "testing"

func TestMCPChildEnvScrub(t *testing.T) {
	// 布景：父进程环境里的典型密钥与运行必需变量
	t.Setenv("GITHUB_TOKEN", "gh_secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws_secret")
	t.Setenv("DB_PASSWORD", "db_secret")
	t.Setenv("SSH_AUTH_SOCK", "/tmp/agent.sock") // 误杀案例：匹配 AUTH
	t.Setenv("MY_API_KEY", "key_secret")
	t.Setenv("PATH", `C:\Windows\system32`)
	t.Setenv("TEMP", `C:\Temp`)
	t.Setenv("CADT_PRIVATE_FLAG", "1") // 本应用私有变量

	env := mcpChildEnv(nil)
	envMap := map[string]string{}
	for _, kv := range env {
		name, value, ok := splitEnvKV(kv)
		if !ok {
			continue
		}
		envMap[name] = value
	}

	// 被过滤：疑似密钥 + 本应用私有变量
	for _, name := range []string{"GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "MY_API_KEY", "SSH_AUTH_SOCK", "CADT_PRIVATE_FLAG"} {
		if _, kept := envMap[name]; kept {
			t.Errorf("疑似密钥 %q 应被过滤，却传给了子进程", name)
		}
	}
	// 保留：运行必需
	if envMap["PATH"] != `C:\Windows\system32` {
		t.Errorf("PATH 应保留，实际：%q", envMap["PATH"])
	}
	if envMap["TEMP"] != `C:\Temp` {
		t.Errorf("TEMP 应保留，实际：%q", envMap["TEMP"])
	}
}

func TestMCPChildEnvExplicitOverrides(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "gh_secret")
	t.Setenv("PATH", `C:\Windows\system32`)

	env := mcpChildEnv(map[string]string{
		"GITHUB_TOKEN": "explicit_token", // 显式 env 不受过滤（用户的授权行为）
		"PATH":         `D:\custom`,      // 显式覆盖继承值且不产生重复键
	})
	countToken, countPath := 0, 0
	for _, kv := range env {
		name, value, _ := splitEnvKV(kv)
		switch name {
		case "GITHUB_TOKEN":
			countToken++
			if value != "explicit_token" {
				t.Errorf("显式 token 应覆盖继承值，实际：%q", value)
			}
		case "PATH":
			countPath++
			if value != `D:\custom` {
				t.Errorf("显式 PATH 应覆盖继承值，实际：%q", value)
			}
		}
	}
	if countToken != 1 {
		t.Errorf("GITHUB_TOKEN 应恰好出现一次，实际 %d 次", countToken)
	}
	if countPath != 1 {
		t.Errorf("PATH 应恰好出现一次，实际 %d 次", countPath)
	}
}

func splitEnvKV(kv string) (name, value string, ok bool) {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i], kv[i+1:], true
		}
	}
	return "", "", false
}
