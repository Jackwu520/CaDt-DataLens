package main

// crossplatform_guard_test.go：平台无关文件里不许出现 Windows 专属 API。
//
// 为什么需要这条守卫：非 Windows 的坑不是「功能缺失」而是「整包编译不过」——2026-11-17
// 第一次跑 GOOS=darwin/linux 交叉编译，三个包各自红：
//   - internal/gitinfo     直接写了 syscall 的 HideWindow / CreationFlags 字段、
//                          UTF16PtrFromString、GetFileAttributes
//   - internal/plugins     同上（含它的测试辅助函数）
//   - internal/browser     !windows 桩里参数名 h 与接收者 h 重名（比 API 更隐蔽，静态扫不到）
// 这些在 Windows 上永远是绿的，只有换平台才暴露。真正的证明是 tools/check-crossbuild.sh
// （真的编一遍，约 5 秒）；这条测试是它的毫秒级代理，拦「同一类错误」。

import (
	"go/build/constraint"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// windowsOnlyAPI 是「只存在于 Windows 的标识符」清单：出现在能编到其它平台的文件里必红。
var windowsOnlyAPI = []struct {
	re   *regexp.Regexp
	hint string
}{
	{
		re:   regexp.MustCompile(`SysProcAttr\s*\{[^}]*\b(HideWindow|CreationFlags)\b`),
		hint: "改用 executil.HideCommandWindow(cmd)（非 Windows 是空实现）",
	},
	{
		re:   regexp.MustCompile(`\bsyscall\.(UTF16PtrFromString|UTF16ToString|StringToUTF16|GetFileAttributes\w*|FILE_ATTRIBUTE_\w+|CreateProcess\w*|LoadDLL|NewLazyDLL|NewLazySystemDLL)\b`),
		hint: "把这段搬进 *_windows.go，另写 *_other.go 桩（按目录惯例成对出现）",
	},
	{
		re:   regexp.MustCompile(`"golang\.org/x/sys/windows`),
		hint: "import 只能待在 //go:build windows 的文件里",
	},
}

// crossBuildSkipDirs 不参与扫描的目录：第三方与前端，以及产物/工具目录。
var crossBuildSkipDirs = map[string]bool{
	".git": true, ".cadt": true, ".idea": true, ".zcode": true, ".workbuddy": true,
	"frontend": true, "third_party": true, "node_modules": true, "dist": true,
	"build": true, "tools": true, "scripts": true, "docs": true,
}

// fileHasWindowsTag 判断文件的构建约束是否允许 Windows 参与编译（含 `!windows` 的排除）：
// `//go:build !windows` 的文件正是要扫的非 Windows 桩，不能一律跳过。
func fileHasWindowsTag(src []byte) bool {
	header := src
	if i := strings.Index(string(src), "\npackage "); i >= 0 {
		header = src[:i]
	}
	for _, line := range strings.Split(string(header), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "//go:build") && !strings.HasPrefix(line, "// +build") {
			continue
		}
		expr, err := constraint.Parse(line)
		if err != nil {
			continue
		}
		if expr.Eval(func(tag string) bool { return tag == "windows" }) {
			return true
		}
	}
	return false
}

func lineOf(src string, idx int) int {
	return strings.Count(src[:idx], "\n") + 1
}

func TestNoWindowsOnlyAPIInCrossPlatformFiles(t *testing.T) {
	root := "."
	scanned, skipped := 0, 0
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != root && crossBuildSkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_windows.go") {
			skipped++
			return nil
		}
		src, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if fileHasWindowsTag(src) {
			skipped++
			return nil
		}
		scanned++
		text := string(src)
		for _, api := range windowsOnlyAPI {
			for _, m := range api.re.FindAllStringIndex(text, -1) {
				t.Errorf("%s:%d 平台无关文件里出现 Windows 专属 API %q\n  修法：%s\n  另：改完跑 tools/check-crossbuild.cmd 真编一遍",
					filepath.ToSlash(path), lineOf(text, m[0]), text[m[0]:m[1]], api.hint)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("扫描失败：%v", err)
	}
	// 防呆：扫描面为 0 说明规则被改坏了（例如 root 写错），别让守卫变成空跑。
	if scanned < 40 {
		t.Fatalf("只扫到 %d 个平台无关 .go 文件，扫描面异常（跳过 %d）——检查 skip 目录规则", scanned, skipped)
	}
}
