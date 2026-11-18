package search

import (
	"unicode"
	"unicode/utf8"
)

// fuzzyMaxWindow 模糊命中窗口的字符上限：子序列首尾相隔超过这个字符数的行
// 视为「无意义的分散命中」直接丢弃——既保住结果质量，也防止 preview 被长行撑爆。
const fuzzyMaxWindow = 200

// fuzzyRuneEq 比较两个字符是否等价（默认折叠大小写，只处理 unicode.ToLower）。
func fuzzyRuneEq(a, b rune, caseSensitive bool) bool {
	if a == b {
		return true
	}
	if caseSensitive {
		return false
	}
	return unicode.ToLower(a) == unicode.ToLower(b)
}

// fuzzyFind 在单行文本里按「子序列」查找 needle（fzf 式）：needle 的字符按顺序
// 出现即可，中间允许夹任意字符。返回收紧后的最小窗口 [start, end)（字节偏移）。
// 先正向贪婪找到最早的匹配结束点，再从该点反向收紧起点，复杂度 O(len(line))。
func fuzzyFind(line, needle string, caseSensitive bool) (int, int, bool) {
	if needle == "" || line == "" {
		return 0, 0, false
	}
	hi := 0
	for _, nr := range needle {
		found := false
		for hi < len(line) {
			hr, size := utf8.DecodeRuneInString(line[hi:])
			hi += size
			if fuzzyRuneEq(hr, nr, caseSensitive) {
				found = true
				break
			}
		}
		if !found {
			return 0, 0, false
		}
	}
	end := hi
	// 反向收紧：正向成功意味着每个 needle 字符在窗口内都有候选位置，
	// 这里为每个字符取最靠后的可用位置，把起点压到最小窗口。
	lo := end
	rest := needle
	for len(rest) > 0 {
		nr, size := utf8.DecodeLastRuneInString(rest)
		rest = rest[:len(rest)-size]
		found := false
		for lo > 0 {
			hr, rsize := utf8.DecodeLastRuneInString(line[:lo])
			lo -= rsize
			if fuzzyRuneEq(hr, nr, caseSensitive) {
				found = true
				break
			}
		}
		if !found {
			return 0, 0, false
		}
	}
	if !fuzzyWindowBounded(line[lo:end]) {
		return 0, 0, false
	}
	return lo, end, true
}

// fuzzySubsequence 只判断 needle 是否按顺序出现在 s 里（不收紧窗口），
// 用于文件名命中的分档判断。
func fuzzySubsequence(s, needle string, caseSensitive bool) bool {
	if needle == "" || s == "" {
		return false
	}
	si := 0
	for _, nr := range needle {
		found := false
		for si < len(s) {
			hr, size := utf8.DecodeRuneInString(s[si:])
			si += size
			if fuzzyRuneEq(hr, nr, caseSensitive) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

func fuzzyWindowBounded(window string) bool {
	n := 0
	for range window {
		n++
		if n > fuzzyMaxWindow {
			return false
		}
	}
	return true
}