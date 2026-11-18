//go:build windows

package tray

// 托盘消息窗口的生命周期冒烟：能建起来、能干净退出。
// 图标本身是否真的出现在通知区取决于 Explorer 在不在，测不了（也不该在这里测），
// 这里守的是「窗口类注册 / CreateWindowEx / 消息循环 / 销毁」这条链没写坏。

import (
	"testing"
	"time"
)

var procIsWindow = trayUser32.NewProc("IsWindow")

func TestTrayWindowLifecycle(t *testing.T) {
	if !Supported() {
		t.Fatal("Windows 上必须支持托盘")
	}
	tr := New(Options{Tooltip: "测试托盘"})
	tr.Show()
	hwnd := tr.hwnd.Load()
	if hwnd == 0 {
		t.Fatal("托盘消息窗口没建起来（窗口类注册或 CreateWindowEx 失败）")
	}
	if ok, _, _ := procIsWindow.Call(hwnd); ok == 0 {
		t.Fatalf("托盘消息窗口句柄无效：%v", hwnd)
	}
	// 让托盘线程把 NIM_ADD 走完；Explorer 不在时它会失败并记日志，不算测试失败
	time.Sleep(120 * time.Millisecond)
	if !tr.visible.Load() {
		t.Logf("图标没能挂到通知区（多半是没有 Explorer 的会话），只验证窗口生命周期")
	} else {
		t.Logf("图标已挂到通知区")
	}

	tr.Hide()
	tr.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ok, _, _ := procIsWindow.Call(hwnd); ok == 0 {
			return // 窗口已销毁，消息循环随之退出
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("Close 之后托盘消息窗口仍然存在")
}

func TestUtf16IntoTruncatesAndTerminates(t *testing.T) {
	var buf [4]uint16
	utf16Into(buf[:], "显示主窗口与退出")
	if buf[3] != 0 {
		t.Fatalf("截断后必须以 NUL 结尾：%v", buf)
	}
	if buf[0] != uint16('显') {
		t.Fatalf("首字符不对：%v", buf)
	}
	var full [64]uint16
	utf16Into(full[:], "退出")
	if full[0] != uint16('退') || full[1] != uint16('出') || full[2] != 0 {
		t.Fatalf("正常写入结果不对：%v", full[:4])
	}
}
