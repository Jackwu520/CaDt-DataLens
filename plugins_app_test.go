package main

// plugins_app_test.go：插件配置钩子 ↔ config.json 接线的冒烟守卫。
// 5cad98b 把插件配置读写改成窄钩子后，包内测试换成了内存 testCfg，
// 「经根壳 init 接线真正落盘 config.json，且与 openMode 合并写互不覆盖」这条链路不再有覆盖。

import (
	"os"
	"testing"

	"datalens/internal/appconfig"
)

func TestPluginsConfigWiringRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	app := NewApp()
	if err := app.SetOpenMode("window"); err != nil {
		t.Fatal(err)
	}
	// 经根壳接线写插件配置：同一份 config.json 的合并写不得丢掉 openMode
	if err := app.SetPluginsPathMode("appdata"); err != nil {
		t.Fatal(err)
	}
	if err := app.SetDataSource("github"); err != nil {
		t.Fatal(err)
	}
	// openMode 已禁用 window（2026-11-21 用户裁定），写入后读取回落 tab；
	// 这里验证的是合并写不丢字段：tab 恒定 + 插件两项照常落盘
	if got := appconfig.OpenMode(); got != "tab" {
		t.Fatalf("写插件配置后 openMode = %q，期望 tab（window 已禁用）", got)
	}
	if got := app.GetPluginsPathMode(); got != "appdata" {
		t.Fatalf("pluginsPathMode = %q，期望 appdata", got)
	}
	if got := app.GetDataSource(); got != "github" {
		t.Fatalf("dataSource = %q，期望 github", got)
	}
	// 落盘核对：Read 每次都从磁盘读，字段齐 = 接线真写进了 config.json
	if _, err := os.Stat(appconfig.Path()); err != nil {
		t.Fatalf("config.json 未落盘: %v", err)
	}
	cfg := appconfig.Read()
	if cfg.OpenMode != "tab" || cfg.PluginsPathMode != "appdata" || cfg.DataSource != "github" {
		t.Fatalf("config.json 内容 = %+v", cfg)
	}
}
