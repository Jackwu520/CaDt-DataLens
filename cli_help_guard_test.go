package main

// cli_help_guard_test.go：CLI 开关与顶层 --help 文本双向对账（纯静态扫源码，毫秒级，
// 先例 crossplatform_guard_test.go）。
//
// 正向：CLI 相关源码里的 --xxx 开关字面量必须出现在 --help 文本（launchargs.TopLevelUsage
// / convertcli.Usage / patchcli.Usage 三段拼接）——历史上一半开关是「读源码才知道」的隐藏
// 知识（--open-settings / --ai-session / --quit 等三处文档各记一部分），新开关漏写 help 在
// 这里直接红；豁免必须登记 cliGuardExempt 并写明原因。
// 反向：help 文本提到的每个 --xxx 必须在上述源码里真实存在（防文本先行漂移）。
// 短开关（-l/-c/-g/-h/-v/-t/-o/-d/-y）按词边界断言——普通 Contains 会被长开关名的子串
// （-d⊂--dir 等）满足而形同虚设（审查 P2-2）。

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// cliGuardSourceDirs 目录级列举：包内新增文件自动进对账，不靠单文件登记。
var cliGuardSourceDirs = []string{
	"internal/launchargs",
	"internal/convertcli",
	"internal/patchcli",
	"internal/installercli",
}

// cliGuardRootFiles 根包里 CLI 开关的消费分支所在文件。
var cliGuardRootFiles = []string{
	"main.go",
	"app_core.go",
}

// cliGuardExempt 非 CLI 开关的 -- 字面量 → 原因（出现在被扫源码里但不属于命令行开关）。
var cliGuardExempt = map[string]string{
	"--disable-features":      "WebView2 feature 注入串（disableMiniMenu 的浏览器参数）",
	"--remote-debugging-port": "CADT_CDP_PORT 调试辅助注入的 WebView2 参数，不是 CLI 开关",
}

// cliGuardShortFlags 已有短开关清单（新加短开关在此登记并写进 help 文本）。
var cliGuardShortFlags = []string{"-l", "-c", "-g", "-h", "-v", "-t", "-o", "-d", "-y"}

// cliGuardSources 汇总根包文件与目录下全部非测试 .go 文件。
func cliGuardSources(t *testing.T) []string {
	t.Helper()
	out := append([]string{}, cliGuardRootFiles...)
	for _, dir := range cliGuardSourceDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("读取目录失败 %s: %v", dir, err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			out = append(out, filepath.ToSlash(filepath.Join(dir, name)))
		}
	}
	return out
}

func TestCLIFlagsDocumentedInHelp(t *testing.T) {
	text := cliUsageText()
	re := regexp.MustCompile(`--[a-z][a-z0-9-]*`)
	seen := map[string]bool{}
	for _, rel := range cliGuardSources(t) {
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
		// 词边界：短开关两侧不能是字母/数字/连字符——防「--dir 的子串」假命中。
		re := regexp.MustCompile(`(^|[^a-z0-9-])` + regexp.QuoteMeta(flag) + `([^a-z0-9-]|$)`)
		if !re.MatchString(text) {
			t.Errorf("短开关 %s 未按独立词出现在顶层 --help 文本（如「--dir / -d」并列写法）", flag)
		}
	}
}
