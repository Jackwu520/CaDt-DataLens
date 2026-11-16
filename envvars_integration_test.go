package main

// 环境变量 → 命令桥子进程注入的集成用例（App 层，留在根目录）。

import (
	"strings"
	"testing"

	"datalens/internal/envvars"
)

func envTestAppRoot(t *testing.T) *App {
	t.Helper()
	t.Setenv("AppData", t.TempDir())
	return NewApp()
}

// TestRunCommandSyncInjectsEnv 验证命令桥子进程拿到注入变量（enabled 才注入）。
func TestRunCommandSyncInjectsEnv(t *testing.T) {
	app := envTestAppRoot(t)
	if err := app.SetEnvVars([]envvars.EnvVarInput{
		{Name: "CADT_ENV_TEST_ON", Value: "hello-cadt", Enabled: true},
		{Name: "CADT_ENV_TEST_OFF", Value: "should-not-appear", Enabled: false},
	}); err != nil {
		t.Fatal(err)
	}
	res, err := app.RunCommandSync("cmd", []string{"/c", "echo", "%CADT_ENV_TEST_ON%"}, "", 10000)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Stdout, "hello-cadt") {
		t.Fatalf("stdout = %q, want injected value", res.Stdout)
	}
	res, err = app.RunCommandSync("cmd", []string{"/c", "echo", "%CADT_ENV_TEST_OFF%"}, "", 10000)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Stdout, "should-not-appear") {
		t.Fatalf("disabled var leaked: %q", res.Stdout)
	}
}
