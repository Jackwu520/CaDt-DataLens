package main

// 关闭行为（最小化到托盘 / 直接退出）的判定守卫。
//
// 这里只钉「什么情况下允许藏窗口」这一条：藏错了的后果比退出更严重——窗口和任务栏
// 按钮一起消失，用户找不到程序，只能去任务管理器结束进程。多窗口下藏错还会在通知区
// 堆出一串图标，每个只能唤回自己那个窗口。

import (
	"os"
	"testing"

	"datalens/internal/appconfig"
)

func TestShouldHideOnClose(t *testing.T) {
	cases := []struct {
		name         string
		action       string
		portable     bool
		force        bool
		quitRequest  bool
		shuttingDown bool
		otherWindows int
		want         bool
	}{
		{"默认直接退出", appconfig.CloseActionExit, true, false, false, false, 0, false},
		{"空配置按退出处理", "", true, false, false, false, 0, false},
		{"托盘 + 唯一窗口", appconfig.CloseActionTray, true, false, false, false, 0, true},
		{"托盘 + 还有别的窗口（多窗口逐个关）", appconfig.CloseActionTray, true, false, false, false, 1, false},
		{"托盘 + 还有两个窗口", appconfig.CloseActionTray, true, false, false, false, 2, false},
		{"托盘但本进程是附属窗口（浮窗/调试台）", appconfig.CloseActionTray, false, false, false, false, 0, false},
		{"托盘但正在强制退出", appconfig.CloseActionTray, true, true, false, false, 0, false},
		{"托盘但用户点了退出", appconfig.CloseActionTray, true, false, true, false, 0, false},
		{"托盘但系统正在关机", appconfig.CloseActionTray, true, false, false, true, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldHideOnClose(tc.action, tc.portable, tc.force, tc.quitRequest, tc.shuttingDown, tc.otherWindows)
			if got != tc.want {
				t.Fatalf("shouldHideOnClose(%q, portable=%v, force=%v, quit=%v, shutdown=%v, others=%d) = %v，期望 %v",
					tc.action, tc.portable, tc.force, tc.quitRequest, tc.shuttingDown, tc.otherWindows, got, tc.want)
			}
		})
	}
}

// 应用窗口身份只认「不是 AI 浮窗 / 调试控制台」——不能看 --new-window：
// 窗口模式下双击文件拉起的进程不带它（newwindow.OpenFiles 也是裸参数）。
func TestIsPortableWindowProcess(t *testing.T) {
	old := os.Args
	t.Cleanup(func() { os.Args = old })

	for _, tc := range []struct {
		args []string
		want bool
	}{
		{[]string{"CaDt-DataLens.exe"}, true},
		{[]string{"CaDt-DataLens.exe", "D:\\data\\a.json"}, true}, // 窗口模式双击文件：不带 --new-window
		{[]string{"CaDt-DataLens.exe", "--new-window"}, true},     // 空白新窗口
		{[]string{"CaDt-DataLens.exe", "--new-window", "--ai-float"}, false},
		{[]string{"CaDt-DataLens.exe", "--new-window", "--debug-console"}, false},
	} {
		os.Args = tc.args
		if got := isPortableWindowProcess(); got != tc.want {
			t.Errorf("isPortableWindowProcess(%q) = %v，期望 %v", tc.args, got, tc.want)
		}
	}
}

// 跨进程枚举时靠标题把附属窗口摘出去（标题是程序自己写死的）。
func TestIsPortableWindowTitle(t *testing.T) {
	for _, tc := range []struct {
		title string
		want  bool
	}{
		{"CaDt-DataLens", true},
		{"a.json - CaDt-DataLens", true},
		{"AI 助手 · CaDt-DataLens", false},
		{"调试控制台 · CaDt-DataLens", false},
		{"", false},
		{"   ", false},
	} {
		if got := isPortableWindowTitle(tc.title); got != tc.want {
			t.Errorf("isPortableWindowTitle(%q) = %v，期望 %v", tc.title, got, tc.want)
		}
	}
}
