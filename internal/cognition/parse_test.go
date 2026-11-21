// parse_test.go：§8 表驱动——标准行 / 缺字段 / 目录条目 / 坏行计数 / TAB 注入 /
// 值内 ` F:` 视为字段起点 / 路径归一 / 路径非法拒绝 / meta budget 镜像校验。
package cognition

import (
	"strings"
	"testing"
)

func TestParseEntryLine(t *testing.T) {
	tests := []struct {
		name string
		line string
		want Entry
		bad  bool
	}{
		{
			name: "标准行全字段",
			line: "internal/cognition/service.go\thot fragile  F: 卷读写与租约  R: parse.go,drift.go  A: CognitionRead/Edit/Status 绑定  S: 改 lease 语义要同步 memo 清理门闩",
			want: Entry{
				Path:   "internal/cognition/service.go",
				Labels: []string{"hot", "fragile"},
				F:      "卷读写与租约",
				R:      "parse.go,drift.go",
				A:      "CognitionRead/Edit/Status 绑定",
				S:      "改 lease 语义要同步 memo 清理门闩",
			},
		},
		{name: "无标签", line: "main.go\tF: 组合根", want: Entry{Path: "main.go", F: "组合根"}},
		{name: "尾部字段缺省", line: "a.go\thot  F: x", want: Entry{Path: "a.go", Labels: []string{"hot"}, F: "x"}},
		{name: "只有路径与标签", line: "b.go\tgenerated", want: Entry{Path: "b.go", Labels: []string{"generated"}}},
		{name: "目录条目", line: "src/utils/\t  F: 工具函数目录", want: Entry{Path: "src/utils/", F: "工具函数目录"}},
		{name: "字段乱序容忍", line: "c.go\tS: 暗约束  F: 职责", want: Entry{Path: "c.go", S: "暗约束", F: "职责"}},
		{name: "值含冒号不误切", line: "d.go\tF: 格式 path:line 出处", want: Entry{Path: "d.go", F: "格式 path:line 出处"}},
		{name: "值内空格保留", line: "e.go\tR: a.go, b.go", want: Entry{Path: "e.go", R: "a.go, b.go"}},
		{name: "缺 TAB", line: "no-tab-line", bad: true},
		{name: "路径为空", line: "\tF: x", bad: true},
		{name: "值内 TAB 注入拒绝", line: "f.go\tF: a\tR: b", bad: true},
		{name: "字段重复拒绝", line: "g.go\tF: a  F: b", bad: true},
		{name: "绝对路径拒绝", line: "C:\\x\\y.go\tF: x", bad: true},
		{name: "上跳路径拒绝", line: "../outside.go\tF: x", bad: true},
		{name: "cadt 前缀拒绝", line: ".cadt/cognition/code.txt\tF: x", bad: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseEntryLine(tt.line)
			if tt.bad {
				if err == nil {
					t.Fatalf("应为坏行，却解析成功：%+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("应解析成功，却报错：%v", err)
			}
			if got.Path != tt.want.Path || got.F != tt.want.F || got.R != tt.want.R ||
				got.A != tt.want.A || got.S != tt.want.S {
				t.Fatalf("字段不符\n  got  %+v\n  want %+v", got, tt.want)
			}
			if strings.Join(got.Labels, ",") != strings.Join(tt.want.Labels, ",") {
				t.Fatalf("标签不符：got %v want %v", got.Labels, tt.want.Labels)
			}
		})
	}
}

func TestParseCodeVolumeTolerant(t *testing.T) {
	text := strings.Join([]string{
		"# 注释行",
		"",
		"a.go\tF: 好",
		"bad-line-no-tab",
		"b.go\tF: x\tR: y", // 值内 TAB → 坏行
		"c.go\tF: 好",
	}, "\n")
	entries, bad := ParseCodeVolume(text)
	if len(entries) != 2 || entries[0].Path != "a.go" || entries[1].Path != "c.go" {
		t.Fatalf("应解析出 2 条，实际 %d：%+v", len(entries), entries)
	}
	if bad != 2 {
		t.Fatalf("坏行计数应为 2，实际 %d", bad)
	}
}

func TestFormatRoundTrip(t *testing.T) {
	in := Entry{
		Path:   "src/x.py",
		Labels: []string{"hot", "fragile"},
		F:      "职责说明",
		R:      "src/y.py",
		S:      "改前先跑 make check",
	}
	line := FormatEntry(in)
	got, err := parseEntryLine(line)
	if err != nil {
		t.Fatalf("round trip 失败：%v（line=%q）", err, line)
	}
	if got.Path != in.Path || got.F != in.F || got.R != in.R || got.S != in.S ||
		strings.Join(got.Labels, ",") != strings.Join(in.Labels, ",") {
		t.Fatalf("round trip 内容不符：got %+v want %+v", got, in)
	}
}

func TestPathNormalization(t *testing.T) {
	tests := []struct {
		a, b string
	}{
		{"Internal/x.go", "internal/x.go"},
		{"a\\b.js", "a/b.js"},
		{"./a/b.js", "a/b.js"},
		{"/leading/path", "leading/path"},
		{"internal/x.go ", "internal/x.go"},
		{" internal/x.go", "internal/x.go"}, // 手写卷的前导空格（审查 P2）
		{"a/./b.go", "a/b.go"},              // 内嵌 "." 段（审查 P2）
		{"src/./dir/", "src/dir/"},          // 目录条目尾随 / 保留
	}
	for _, tt := range tests {
		if PathKey(tt.a) != PathKey(tt.b) {
			t.Errorf("PathKey(%q) != PathKey(%q)（归一失败）", tt.a, tt.b)
		}
	}
	if NormalizeRelPath("src\\dir/") != "src/dir/" {
		t.Errorf("目录条目尾随 / 应保留：%q", NormalizeRelPath("src\\dir/"))
	}
}

func TestValidateEntryPathRejects(t *testing.T) {
	for _, p := range []string{"", "D:\\abs\\x.go", "../up.go", "a/../../b.go", ".cadt/cognition/code.txt", ".cadt", "a//b.go", "/root/x"} {
		if err := ValidateEntryPath(p); err == nil {
			t.Errorf("%q 应被拒绝", p)
		}
	}
	for _, p := range []string{"main.go", "src/deep/x.go", "src/dir/", ".env"} {
		if err := ValidateEntryPath(p); err != nil {
			t.Errorf("%q 应合法：%v", p, err)
		}
	}
}

func TestParseMetaBudgetMirror(t *testing.T) {
	good := strings.Join([]string{
		"scene: code",
		BudgetLine() + "   # Go 常量镜像",
		"labels: hot fragile generated",
		"build: 按目录分批",
		"rule1: S 只收编译器看不出来的约束",
		"custom-key: 其余键忽略并原样保留",
	}, "\n")
	meta, err := ParseMeta(good)
	if err != nil {
		t.Fatalf("合法 meta 解析失败：%v", err)
	}
	if meta.Scene != "code" || meta.Labels != "hot fragile generated" || len(meta.Rules) != 1 {
		t.Fatalf("meta 字段不符：%+v", meta)
	}

	dupBudget := strings.Join([]string{"scene: code", BudgetLine(), "budget: 9999 entries / 1 bytes"}, "\n")
	if _, err := ParseMeta(dupBudget); err == nil {
		t.Fatal("改小 budget 应被拒绝")
	} else if !strings.Contains(err.Error(), BudgetLine()) {
		t.Fatalf("拒绝信息应带正确镜像行：%v", err)
	}

	if _, err := ParseMeta("scene: code\nlabels: x"); err == nil {
		t.Fatal("缺 budget 行应被拒绝")
	}
	if _, err := ParseMeta("scene: database\n" + BudgetLine()); err == nil {
		t.Fatal("非法 scene 应被拒绝")
	}
}

func TestParseIgnoreText(t *testing.T) {
	// 合法：规整尾换行 + 注释/取反/路径 glob 都放行
	out, err := ParseIgnoreText("dist/\r\n# 注释\n!keep.log\r\n")
	if err != nil {
		t.Fatalf("合法文本不应拒绝：%v", err)
	}
	if out != "dist/\n# 注释\n!keep.log\n" {
		t.Fatalf("应规整 CRLF 并保证尾换行：%q", out)
	}

	// 空文本拒绝（清空排除表应传只含注释的文本，而不是空串）
	if _, err := ParseIgnoreText("  \n"); err == nil {
		t.Fatal("空文本应拒绝")
	}

	// 非法 glob 拒绝（写入侧不静默放行，否则排除整段失效）
	long := strings.Repeat("a/\n", IgnoreLineBudget+1)
	if _, err := ParseIgnoreText(long); err == nil {
		t.Fatal("超行数预算应拒绝")
	}
	big := "#" + strings.Repeat("字", IgnoreLineLen) + "\n"
	if _, err := ParseIgnoreText(big); err == nil {
		t.Fatal("超单行长度应拒绝")
	}
}
