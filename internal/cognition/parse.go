// parse.go：卷格式解析 / 格式化 / 路径归一 / meta 校验（§3.2 / §3.3）。
// 行级容错：坏行跳过并计数，不炸整卷；edit 走「解析→改→重排全卷」，顺带把手工乱行收敛成规范形。
package cognition

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// NormalizeRelPath 卷内 rel-path 的展示形：正斜杠、去前导空格与 ./（含内嵌 "." 段）、
// 去前导 /、去尾随空格，**保留原始大小写**（Windows 比对才归一小写，见 PathKey）。
// 目录条目的尾随 / 保留。
func NormalizeRelPath(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimLeft(p, " \t")
	for strings.HasPrefix(p, "./") {
		p = strings.TrimPrefix(p, "./")
	}
	p = strings.TrimLeft(p, "/")
	if !strings.Contains(p, "/./") && !strings.HasSuffix(p, "/.") {
		return strings.TrimRight(p, " \t")
	}
	// 剥内嵌 "." 段（a/./b → a/b；手写卷的常见形态，不剥会产生假 Orphan+Missing 对）
	trailing := strings.HasSuffix(p, "/")
	segs := strings.Split(p, "/")
	out := make([]string, 0, len(segs))
	for _, seg := range segs {
		if seg == "." {
			continue
		}
		out = append(out, seg)
	}
	joined := strings.Join(out, "/")
	if trailing && !strings.HasSuffix(joined, "/") {
		joined += "/"
	}
	return strings.TrimRight(joined, " \t")
}

// PathKey 比对用键：归一 + 小写。`Internal/` 与 `internal/`、`a\b.js` 与 `a/b.js` 视为同一路径——
// 否则一次扫描就会同时报出成对的 Missing + Orphan 噪音，把真正的 drift 淹没（§3.2）。
func PathKey(p string) string {
	return strings.ToLower(NormalizeRelPath(p))
}

var absPathRe = regexp.MustCompile(`^[A-Za-z]:`)
var ruleKeyRe = regexp.MustCompile(`^rule\d+$`)

// ValidateEntryPath 条目 rel-path 合法性：绝对路径、含 `..`、以 .cadt/ 开头一律拒绝（§5.1）。
// 目录条目的尾随 / 在这里合法（NormalizeRelPath 保留）。
func ValidateEntryPath(raw string) error {
	p := NormalizeRelPath(raw)
	if p == "" {
		return fmt.Errorf("路径为空")
	}
	if strings.HasPrefix(raw, "/") || absPathRe.MatchString(raw) {
		return fmt.Errorf("不允许绝对路径：%s", raw)
	}
	for _, seg := range strings.Split(strings.TrimSuffix(p, "/"), "/") {
		if seg == "" {
			return fmt.Errorf("路径含空段：%s", raw)
		}
		if seg == ".." {
			return fmt.Errorf("不允许 .. 上跳：%s", raw)
		}
	}
	low := strings.ToLower(p)
	if low == ".cadt" || strings.HasPrefix(low, ".cadt/") {
		return fmt.Errorf("认知卷不收录 .cadt 自身：%s", raw)
	}
	return nil
}

// ParseCodeVolume 解析条目卷：每行 `<rel-path><TAB>[labels...]  F: .. R: .. A: .. S: ..`。
// 字段起点 = 空格(或 rest 行首) + F/R/A/S + `:`；坏行（缺 TAB / 值内 TAB / 字段重复 / 路径非法）
// 跳过并计数，不炸整卷（§3.2 行级容错）。
func ParseCodeVolume(text string) (entries []Entry, badLines int) {
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSuffix(raw, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		entry, err := parseEntryLine(line)
		if err != nil {
			badLines++
			continue
		}
		entries = append(entries, entry)
	}
	return entries, badLines
}

func parseEntryLine(line string) (Entry, error) {
	tab := strings.IndexByte(line, '\t')
	if tab <= 0 {
		return Entry{}, fmt.Errorf("缺路径与 TAB 分隔")
	}
	path := strings.TrimRight(line[:tab], " ")
	rest := line[tab+1:]
	if strings.IndexByte(rest, '\t') >= 0 {
		return Entry{}, fmt.Errorf("值内出现 TAB（值内禁 TAB，空格代替）")
	}
	if err := ValidateEntryPath(path); err != nil {
		return Entry{}, err
	}
	entry := Entry{Path: path}
	// 字段起点扫描：pos 处是 F/R/A/S 且 rest[pos+1] == ':' 且左边是行首或空格。
	type fieldAt struct {
		key byte
		pos int
	}
	var starts []fieldAt
	for i := 0; i < len(rest); i++ {
		if rest[i] != ':' || i == 0 {
			continue
		}
		c := rest[i-1]
		if strings.IndexByte(fieldLetters, c) >= 0 && (i == 1 || rest[i-2] == ' ') {
			starts = append(starts, fieldAt{key: c, pos: i - 1})
		}
	}
	sort.Slice(starts, func(a, b int) bool { return starts[a].pos < starts[b].pos })
	seen := map[byte]bool{}
	for i, st := range starts {
		if seen[st.key] {
			return Entry{}, fmt.Errorf("字段 %c 重复", st.key)
		}
		seen[st.key] = true
		end := len(rest)
		if i+1 < len(starts) {
			end = starts[i+1].pos
		}
		value := strings.TrimSpace(rest[st.pos+2 : end])
		switch st.key {
		case 'F':
			entry.F = value
		case 'R':
			entry.R = value
		case 'A':
			entry.A = value
		case 'S':
			entry.S = value
		}
	}
	if len(starts) > 0 {
		if labels := strings.TrimSpace(rest[:starts[0].pos]); labels != "" {
			entry.Labels = strings.Fields(labels)
		}
	} else if labels := strings.TrimSpace(rest); labels != "" {
		entry.Labels = strings.Fields(labels)
	}
	return entry, nil
}

// FormatEntry 单行规范形：path + TAB + labels + `  X: value`（F→R→A→S，缺省字段省略，§3.2）。
func FormatEntry(e Entry) string {
	var b strings.Builder
	b.WriteString(e.Path)
	b.WriteByte('\t')
	if len(e.Labels) > 0 {
		b.WriteString(strings.Join(e.Labels, " "))
	}
	for _, f := range []struct {
		key byte
		val string
	}{{'F', e.F}, {'R', e.R}, {'A', e.A}, {'S', e.S}} {
		if f.val == "" {
			continue
		}
		b.WriteString("  ")
		b.WriteByte(f.key)
		b.WriteString(": ")
		b.WriteString(f.val)
	}
	return b.String()
}

// FormatCodeVolume 整卷规范形（edit 重排全卷用；手写的乱行会被收敛成规范形或剔除）。
func FormatCodeVolume(entries []Entry) []byte {
	var b strings.Builder
	for _, e := range entries {
		b.WriteString(FormatEntry(e))
		b.WriteByte('\n')
	}
	return []byte(b.String())
}

// BudgetValue meta 里 budget 行的值部分（§3.2：只比对这一行的值，改大改小都算不一致）。
func BudgetValue() string {
	return fmt.Sprintf("%d entries / %d bytes", EntryBudget, ByteBudget)
}

// BudgetLine 完整镜像行（错误提示与 meta 模板用）。
func BudgetLine() string {
	return "budget: " + BudgetValue()
}

// Meta meta 卷的机器可读键（§3.3：Go 只认 scene / budget / labels / build + ruleN）。
type Meta struct {
	Scene  string // code / mixed；数据目录提醒 AI 不建
	Labels string // 标签字典（自由 token）
	Build  string // 建卷协议（按目录分批）
	Rules  []string
}

const (
	maxMetaRules     = 32
	maxMetaRuleLen   = 300
	maxMetaLabelsLen = 500
)

// ParseMeta 解析并校验 meta 文本。budget 行与 Go 常量不一致（缺失也算）即拒绝并报出正确值；
// 其余键忽略并原样保留（edit 原文写回，不重排）。
func ParseMeta(text string) (Meta, error) {
	var meta Meta
	hasBudget := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSuffix(raw, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.IndexByte(trimmed, ':')
		if colon <= 0 {
			continue // 非键值行：忽略并原样保留
		}
		key := strings.TrimSpace(trimmed[:colon])
		value := stripInlineComment(trimmed[colon+1:])
		switch {
		case key == "scene":
			meta.Scene = value
		case key == "labels":
			if len(value) > maxMetaLabelsLen {
				return Meta{}, fmt.Errorf("labels 行过长（%d > %d 字符）", len(value), maxMetaLabelsLen)
			}
			meta.Labels = value
		case key == "build":
			meta.Build = value
		case key == "budget":
			if value != BudgetValue() {
				return Meta{}, fmt.Errorf("budget 行与常量不一致：%q；应为一行 %q（放宽预算只有改 Go 常量）", value, BudgetLine())
			}
			hasBudget = true
		case ruleKeyRe.MatchString(key):
			if len(meta.Rules) >= maxMetaRules {
				return Meta{}, fmt.Errorf("rule 条数超过 %d", maxMetaRules)
			}
			if len(value) > maxMetaRuleLen {
				return Meta{}, fmt.Errorf("%s 行过长（%d > %d 字符）", key, len(value), maxMetaRuleLen)
			}
			meta.Rules = append(meta.Rules, value)
		}
	}
	if !hasBudget {
		return Meta{}, fmt.Errorf("meta 缺少 budget 行；应为一行 %q", BudgetLine())
	}
	switch meta.Scene {
	case "", "code", "mixed":
	default:
		return Meta{}, fmt.Errorf("scene 只认 code / mixed，收到 %q", meta.Scene)
	}
	return meta, nil
}

// stripInlineComment 去掉「 # ...」行尾注释（budget 行示例带注释，比对前剥掉）。
func stripInlineComment(value string) string {
	if i := strings.Index(value, " #"); i >= 0 {
		value = value[:i]
	}
	return strings.TrimSpace(value)
}

// ParseIgnoreText 校验并规整作用域排除文件文本（cognition_edit 的 ignore 参数，整卷替换，
// 与 meta 同款「非法整体拒绝」语义）：行数 ≤ IgnoreLineBudget、单行 ≤ IgnoreLineLen（rune）
// ——排除表不是条目卷，超限即拒。不校验 glob 语法：本方言字面字符一律 QuoteMeta，模式恒可
// 编译，「写错语法」最坏是排除不到（Missing 照报，模型下轮可自行修正），没有静默扩大排除的
// 风险。返回规整后的文本（CRLF 归一、保证尾换行）。
func ParseIgnoreText(text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("ignore 文本为空：要清空排除表请用只含注释的文本，或不要传 ignore 参数")
	}
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	ruleLines := 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if len([]rune(trimmed)) > IgnoreLineLen {
			return "", fmt.Errorf("ignore 第 %d 行超长（%d > %d rune）", i+1, len([]rune(trimmed)), IgnoreLineLen)
		}
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		ruleLines++
		if ruleLines > IgnoreLineBudget {
			return "", fmt.Errorf("ignore 规则行 %d 超预算 %d：排除表不是条目卷，收窄到关键目录", ruleLines-1, IgnoreLineBudget)
		}
	}
	out := strings.TrimRight(normalized, "\n") + "\n"
	return out, nil
}
