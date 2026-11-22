package main

// cli_help_guard_test.go：CLI 开关与顶层 --help 文本双向对账（纯静态扫源码，毫秒级，
// 先例 crossplatform_guard_test.go）。
//
// 正向：CLI 相关源码里的 --xxx 开关字面量必须出现在 --help 文本（launchargs.TopLevelUsage
// / convertcli.Usage / patchcli.Usage 三段拼接）——历史上一半开关是「读源码才知道」的隐藏
// 知识（--open-settings / --ai-session / --quit 等三处文档各记一部分），新开关漏写 help 在
// 这里直接红；豁免必须登记 cliGuardExempt 并写明原因。
// 反向：help 文本提到的每个 --xxx 必须在上述源码里真实存在（防文本先行漂移）。
// 短开关（-l/-c/-g/-h/-v/-t/-o/-d/-y）无法用同一正则可靠提取，单独正向断言。

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// cliGuardSources 参与对账的源码（CLI 开关的定义点：解析包 + 消费分支）。
var cliGuardSources = []string{
	"main.go",
	"app_core.go",
	"internal/launchargs/launchargs.go",
	"internal/convertcli/convertcli.go",
	"internal/patchcli/patchcli.go",
	"internal/installercli/installercli_windows.go",
	"internal/installercli/installercli_other.go",
}

// cliGuardExempt 非 CLI 开关的 -- 字面量 → 原因（出现在被扫源码里但不属于命令行开关）。
var cliGuardExempt = map[string]string{
	"--disable-features":       "WebView2 feature 注入串（disableMiniMenu 的浏览器参数）",
	"--remote-debugging-port": "CADT_CDP_PORT 调试辅助注入的 WebView2 参数，不是 CLI 开关",
}

// cliGuardShortFlags 已有短开关清单（新加短开关在此登记并写进 help 文本）。
var cliGuardShortFlags = []string{"-l", "-c", "-g", "-h", "-v", "-t", "-o", "-d", "-y"}

func TestCLIFlagsDocumentedInHelp(t *testing.T) {
	text := cliUsageText()
	re := regexp.MustCompile(`--[a-z][a-z0-9-]*`)
	seen := map[string]bool{}
	for _, rel := range cliGuardSources {
		src, err := os.ReadFile(filepath.FromSlash(rel))
		if err != nil {
			t.Fatalf("读取源码失败 %s: %v", rel, err)
		}
		for _, flag := range re.FindAllString(string(src), -1) {
			if _, ok := cliGuardExempt[flag]; ok {
				continue
			}
			seen[flag] = true
			if !strings.Contains(text, flag) {
				t.Errorf("开关 %s（%s）未写进顶层 --help 文本：补 launchargs.TopLevelUsage / convertcli.Usage / patchcli.Usage，不要加豁免", flag, rel)
			}
		}
	}
	if len(seen) == 0 {
		t.Fatal("源码里一个开关都没扫到：对账清单或正则失效")
	}
	for _, flag := range re.FindAllString(text, -1) {
		if !seen[flag] {
			t.Errorf("help 文本提到开关 %s，但被扫源码中没有对应字面量（文本漂移或拼错）", flag)
		}
	}
}

func TestCLIShortFlagsDocumentedInHelp(t *testing.T) {
	text := cliUsageText()
	for _, flag := range cliGuardShortFlags {
		if !strings.Contains(text, flag) {
			t.Errorf("短开关 %s 未写进顶层 --help 文本", flag)
		}
	}
}
