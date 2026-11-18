//go:build windows

package main

// 「还有没有别的应用窗口」这条判定的冒烟：本进程没有 wailsWindow 时应当数到 0。
// 跨进程那半边只能手工验收（开两个窗口关一个），这里守的是枚举不炸、也不把自己算进去。

import "testing"

func TestCountOtherPortableWindowsWithoutPeers(t *testing.T) {
	if got := countOtherPortableWindows(); got != 0 {
		t.Fatalf("测试进程没有应用窗口，应数到 0，实际 %d", got)
	}
}
