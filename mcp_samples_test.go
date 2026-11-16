package main

import (
	"os"
	"strings"
	"testing"

	"datalens/internal/mcp"
)

func TestBuiltinMCPSamples(t *testing.T) {
	appDir := t.TempDir()
	oldAppDataDir := mcp.AppDataDir
	mcp.AppDataDir = func() string { return appDir }
	defer func() { mcp.AppDataDir = oldAppDataDir }()

	app := NewApp()
	list, err := app.MCPSamplesList()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != len(mcpSampleDefs) {
		t.Fatalf("示例数 = %d，期望 %d", len(list), len(mcpSampleDefs))
	}
	for _, info := range list {
		if info.Installed || info.ScriptExists {
			t.Fatalf("初始状态不应已安装/已释放：%+v", info)
		}
		if !strings.Contains(info.CommandPreview, info.ScriptPath) {
			t.Fatalf("命令预览缺脚本路径：%q", info.CommandPreview)
		}
	}

	result, err := app.MCPInstallSample("tts_sapi")
	if err != nil {
		t.Fatal(err)
	}
	if result["installed"] != true || result["publicToolName"] != "mcp__tts_sapi__tts_sapi" {
		t.Fatalf("安装结果 = %+v", result)
	}
	scriptPath, _ := result["scriptPath"].(string)
	if _, err := os.Stat(scriptPath); err != nil {
		t.Fatalf("脚本未释放：%v", err)
	}
	cfg, err := mcp.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	server, ok := cfg.MCPServers["tts_sapi"]
	if !ok {
		t.Fatal("mcp.json 未写入 tts_sapi")
	}
	if len(server.EnabledTools) != 1 || server.EnabledTools[0] != "tts_sapi" {
		t.Fatalf("示例工具未授权：%+v", server.EnabledTools)
	}
	if len(server.Args) == 0 || server.Args[len(server.Args)-1] != scriptPath {
		t.Fatalf("服务器参数未指向释放的脚本：%+v", server.Args)
	}
	if _, err := app.MCPInstallSample("tts_sapi"); err == nil {
		t.Fatal("同名服务器已存在时应拒绝安装")
	}

	asr, err := app.MCPInstallSample("asr_whisper")
	if err != nil {
		t.Fatal(err)
	}
	if keys, _ := asr["envKeys"].([]string); len(keys) != 2 {
		t.Fatalf("ASR 示例应登记两个环境变量键：%+v", asr["envKeys"])
	}
	cfg, err = mcp.ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	asrServer := cfg.MCPServers["asr_whisper"]
	for _, key := range []string{"WHISPER_CLI", "WHISPER_MODEL"} {
		if value, ok := asrServer.Env[key]; !ok || value != "" {
			t.Fatalf("环境变量 %s 应存在且为空：%+v", key, asrServer.Env)
		}
	}

	list, err = app.MCPSamplesList()
	if err != nil {
		t.Fatal(err)
	}
	installed := map[string]bool{}
	for _, info := range list {
		installed[info.ID] = info.Installed
	}
	if !installed["tts_sapi"] || !installed["asr_whisper"] || installed["ocr_windows"] {
		t.Fatalf("安装状态不对：%+v", installed)
	}
}
