package vercmp

import (
	"strconv"
	"strings"
)

// Compare 比较数字版本号（可带 v 前缀、按点分隔的 1–3 段），返回 -1/0/1。
func Compare(a, b string) int {
	parse := func(v string) []int {
		v = strings.TrimPrefix(strings.TrimSpace(v), "v")
		parts := strings.Split(v, ".")
		out := make([]int, 0, 3)
		for _, part := range parts {
			n, _ := strconv.Atoi(part)
			out = append(out, n)
		}
		return out
	}
	ap, bp := parse(a), parse(b)
	for i := 0; i < 3; i++ {
		av, bv := 0, 0
		if i < len(ap) {
			av = ap[i]
		}
		if i < len(bp) {
			bv = bp[i]
		}
		if av != bv {
			if av > bv {
				return 1
			}
			return -1
		}
	}
	return 0
}
