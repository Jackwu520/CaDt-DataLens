//go:build windows

package main

import (
	"strings"
	"testing"

	"github.com/wailsapp/go-webview2/webviewloader"
)

// 防止修复被改回「直接设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS」——那条路会被
// go-webview2 的 preventEnvAndRegistryOverrides() 清空，参数到不了浏览器进程。
func TestDisableMiniMenuUsesInjectionPoint(t *testing.T) {
	orig := webviewloader.ExtraBrowserArguments
	defer func() { webviewloader.ExtraBrowserArguments = orig }()
	webviewloader.ExtraBrowserArguments = ""

	disableMiniMenu()

	args := webviewloader.ExtraBrowserArguments
	if args == "" {
		t.Fatal("disableMiniMenu 没有把参数写进 go-webview2 的注入点")
	}
	if !strings.HasPrefix(args, "--disable-features=") {
		t.Fatalf("注入参数格式不对：%q", args)
	}
	// 微软 WebView2Feedback#2140 给出的官方 feature 名必须都在
	for _, feature := range []string{"msWebOOUI", "msPdfOOUI"} {
		if !strings.Contains(args, feature) {
			t.Errorf("缺少官方 feature %s：%q", feature, args)
		}
	}
}
