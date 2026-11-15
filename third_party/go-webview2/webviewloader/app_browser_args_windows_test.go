//go:build windows && !native_webview2loader

package webviewloader

import (
	"os"
	"testing"
)

// COM 通道：environmentOptions.AdditionalBrowserArguments() 的返回值就是
// 传给 WebView2 的 additionalBrowserArguments，必须带上应用注入的参数。
func TestEnvironmentOptionsCarriesInjectedArgs(t *testing.T) {
	orig := ExtraBrowserArguments
	defer func() { ExtraBrowserArguments = orig }()
	ExtraBrowserArguments = "--disable-features=msWebOOUI,msPdfOOUI"

	o := &environmentOptions{}
	WithAdditionalBrowserArguments("--disable-features=msSmartScreenProtection")(o)

	want := "--disable-features=msSmartScreenProtection,msWebOOUI,msPdfOOUI"
	if got := o.AdditionalBrowserArguments(); got != want {
		t.Fatalf("AdditionalBrowserArguments() = %q, want %q", got, want)
	}
}

// 环境变量通道：上游每次创建环境都会把该变量置空，补丁必须把注入值写回来
// （native_webview2loader 路径依赖这条通道）。
func TestPreventEnvOverridesKeepsInjectedArgs(t *testing.T) {
	const key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
	origArgs := ExtraBrowserArguments
	prevEnv, hadEnv := os.LookupEnv(key)
	defer func() {
		ExtraBrowserArguments = origArgs
		if hadEnv {
			os.Setenv(key, prevEnv)
		} else {
			os.Unsetenv(key)
		}
	}()

	ExtraBrowserArguments = "--disable-features=msWebOOUI,msPdfOOUI"
	os.Setenv(key, "")
	preventEnvAndRegistryOverrides()

	if got := os.Getenv(key); got != ExtraBrowserArguments {
		t.Fatalf("环境变量 = %q, want %q", got, ExtraBrowserArguments)
	}
}
