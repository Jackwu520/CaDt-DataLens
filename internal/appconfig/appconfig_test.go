package appconfig

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigPathUnderAppData(t *testing.T) {
	base := t.TempDir()
	t.Setenv("AppData", base)
	root := filepath.Join(base, "CandySweet", "CaDt-DataLens")
	if got, want := Path(), filepath.Join(root, "config.json"); got != want {
		t.Fatalf("config.json 路径不符: %q != %q", got, want)
	}
	if got := Read(); got.OpenMode != "tab" || got.PluginsPathMode != "portable" {
		t.Fatalf("默认配置不符: %+v", got)
	}
}

func TestSaveReadRoundTrip(t *testing.T) {
	t.Setenv("AppData", t.TempDir())
	cfg := Read()
	cfg.OpenMode = "window"
	cfg.DeveloperMode = true
	cfg.DisabledPlugins = []string{"demo"}
	if err := Save(cfg); err != nil {
		t.Fatal(err)
	}
	got := Read()
	if got.OpenMode != "window" || !got.DeveloperMode || len(got.DisabledPlugins) != 1 || got.DisabledPlugins[0] != "demo" {
		t.Fatalf("读回配置不符: %+v", got)
	}
	if _, err := os.Stat(Path()); err != nil {
		t.Fatalf("config.json 未写入: %v", err)
	}
}
