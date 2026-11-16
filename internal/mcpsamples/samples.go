// mcp_samples.go：内置 MCP 示例——脚本随 exe 内嵌，按需释放到应用数据目录并合并进 mcp.json。
// 只内置脚本，不内置 Python / whisper 模型 / OCR 引擎（体积红线）；运行时由系统或用户提供。
package mcpsamples

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
	"datalens/internal/mcp"
)

// Samples 内置 MCP 示例的列出与安装。
type Samples struct{}

var (
	// Embedded 随 exe 分发的 docs/mcp-samples 资源（main/mcp_samples.go 注入）。
	Embedded fs.FS
	// Version 应用版本，用于释放目录隔离。
	Version = ""
)

type mcpSampleDef struct {
	ID            string
	Name          string
	Description   string
	Capability    string
	File          string
	Command       string
	PrepArgs      []string
	ToolName      string
	EnvKeys       []string
	Prerequisites []string
}

var mcpSampleDefs = []mcpSampleDef{
	{
		ID: "tts_sapi", Name: "Windows 语音合成（SAPI）",
		Description: "用系统 SAPI 把文本合成 WAV 文件，离线、零安装。",
		Capability:  "tts", File: "tts-sapi.ps1", Command: "pwsh",
		PrepArgs: []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, ToolName: "tts_sapi",
		Prerequisites: []string{"Windows 自带 PowerShell（pwsh 7 或 5.1）", "无需联网"},
	},
	{
		ID: "ocr_windows", Name: "Windows OCR（系统引擎）",
		Description: "用 Windows.Media.Ocr 识别图片中的文字；PDF 需先转成图片。",
		Capability:  "ocr", File: "ocr-windows.ps1", Command: "powershell",
		PrepArgs: []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, ToolName: "ocr_windows",
		Prerequisites: []string{"Windows PowerShell 5.1（WinRT 投影）", "对应语言的 OCR 语言包（中文需安装）"},
	},
	{
		ID: "asr_whisper", Name: "whisper.cpp 语音识别",
		Description: "用本机 whisper.cpp 把音频转成文字。",
		Capability:  "asr", File: "asr-whisper.py", Command: "python",
		PrepArgs: []string{"-u"}, ToolName: "asr_whisper",
		EnvKeys:       []string{"WHISPER_CLI", "WHISPER_MODEL"},
		Prerequisites: []string{"Python 3.9+", "whisper.cpp（whisper-cli.exe）", "ggml 模型（自备，不随应用分发）"},
	},
}

// MCPSampleInfo 给设置页与 AI 的示例元数据；Installed 只看 mcp.json 是否有同名服务器。
type MCPSampleInfo struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Capability     string   `json:"capability"`
	ServerName     string   `json:"serverName"`
	ToolName       string   `json:"toolName"`
	PublicToolName string   `json:"publicToolName"`
	Prerequisites  []string `json:"prerequisites"`
	EnvKeys        []string `json:"envKeys"`
	Installed      bool     `json:"installed"`
	ScriptPath     string   `json:"scriptPath"`
	ScriptExists   bool     `json:"scriptExists"`
	CommandPreview string   `json:"commandPreview"`
	ClientEnabled  bool     `json:"clientEnabled"`
}

func mcpSampleByID(id string) (mcpSampleDef, bool) {
	key := strings.TrimSpace(id)
	for _, def := range mcpSampleDefs {
		if def.ID == key {
			return def, true
		}
	}
	return mcpSampleDef{}, false
}

func mcpSamplesRoot() string {
	if path := mcp.ConfigFilePath(); path != "" {
		return filepath.Dir(path)
	}
	return appdata.Root()
}

func mcpSamplesDir() string {
	root := mcpSamplesRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "builtin-mcp-samples", Version)
}

func mcpSampleScriptPath(def mcpSampleDef) string {
	dir := mcpSamplesDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, def.File)
}

func mcpSamplePublicToolName(def mcpSampleDef) string {
	return "mcp__" + def.ServerName() + "__" + def.ToolName
}

// ServerName 示例的服务器名与 ID 一致（都是合法 MCP 名）。
func (d mcpSampleDef) ServerName() string { return d.ID }

func mcpSampleCommandPreview(def mcpSampleDef, scriptPath string) string {
	parts := []string{def.Command}
	parts = append(parts, def.PrepArgs...)
	parts = append(parts, scriptPath)
	for i, part := range parts {
		if strings.ContainsAny(part, " \t") {
			parts[i] = `"` + part + `"`
		}
	}
	return strings.Join(parts, " ")
}

func mcpSampleServerConfig(def mcpSampleDef, scriptPath string) mcp.MCPServerConfig {
	args := append([]string{}, def.PrepArgs...)
	args = append(args, scriptPath)
	server := mcp.MCPServerConfig{
		Command:      def.Command,
		Args:         args,
		EnabledTools: []string{def.ToolName},
	}
	if len(def.EnvKeys) > 0 {
		server.Env = make(map[string]string, len(def.EnvKeys))
		for _, key := range def.EnvKeys {
			server.Env[key] = ""
		}
	}
	return server
}

func materializeMCPSample(def mcpSampleDef) (string, error) {
	raw, err := fs.ReadFile(Embedded, "docs/mcp-samples/"+def.File)
	if err != nil {
		return "", fmt.Errorf("内置示例缺失：%w", err)
	}
	path := mcpSampleScriptPath(def)
	if path == "" {
		return "", errors.New("无法定位应用数据目录")
	}
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, raw) {
		return path, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := atomfile.WriteFileAtomicMode(path, raw, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// MCPSamplesList 列出内置示例；只读，不释放脚本。
func (s *Samples) MCPSamplesList() ([]MCPSampleInfo, error) {
	cfg, err := mcp.ReadConfig()
	if err != nil {
		return nil, err
	}
	out := make([]MCPSampleInfo, 0, len(mcpSampleDefs))
	for _, def := range mcpSampleDefs {
		path := mcpSampleScriptPath(def)
		_, statErr := os.Stat(path)
		_, installed := cfg.MCPServers[def.ServerName()]
		out = append(out, MCPSampleInfo{
			ID: def.ID, Name: def.Name, Description: def.Description, Capability: def.Capability,
			ServerName: def.ServerName(), ToolName: def.ToolName, PublicToolName: mcpSamplePublicToolName(def),
			Prerequisites: def.Prerequisites, EnvKeys: def.EnvKeys,
			Installed: installed, ScriptPath: path, ScriptExists: statErr == nil,
			CommandPreview: mcpSampleCommandPreview(def, path),
			ClientEnabled:  cfg.Enabled == nil || *cfg.Enabled,
		})
	}
	return out, nil
}

// MCPInstallSample 释放示例脚本并合并进 mcp.json（同名服务器已存在时拒绝，不覆盖用户配置）。
// 会释放脚本并在本机注册服务器；调用方（设置页 / AI 审批卡）必须先向用户确认命令。
func (s *Samples) MCPInstallSample(id string) (map[string]interface{}, error) {
	def, ok := mcpSampleByID(id)
	if !ok {
		return nil, errors.New("未知内置示例：" + id)
	}
	cfg, err := mcp.ReadConfig()
	if err != nil {
		return nil, err
	}
	if cfg.MCPServers == nil {
		cfg.MCPServers = map[string]mcp.MCPServerConfig{}
	}
	if _, exists := cfg.MCPServers[def.ServerName()]; exists {
		return nil, fmt.Errorf("已存在同名 MCP 服务器 %q；请先在设置里删除或改名后再安装示例", def.ServerName())
	}
	path, err := materializeMCPSample(def)
	if err != nil {
		return nil, err
	}
	cfg.MCPServers[def.ServerName()] = mcpSampleServerConfig(def, path)
	if cfg.Version == 0 {
		cfg.Version = 1
	}
	if err := mcp.WriteConfig(cfg); err != nil {
		return nil, err
	}
	note := "示例已释放并写入 MCP 配置。"
	if len(def.EnvKeys) > 0 {
		note += "请让用户在 设置 → AI → 外部工具 → MCP 服务器 → 编辑 里填写环境变量值（" + strings.Join(def.EnvKeys, "、") + "）。"
	}
	note += "需要把它作为外部能力来源时，在「能力来源」把对应能力绑定到 " + mcpSamplePublicToolName(def) + "。"
	if cfg.Enabled != nil && !*cfg.Enabled {
		note += " MCP 客户端总开关当前是关闭的，需要用户开启。"
	}
	return map[string]interface{}{
		"installed":      true,
		"id":             def.ID,
		"name":           def.Name,
		"serverName":     def.ServerName(),
		"toolName":       def.ToolName,
		"publicToolName": mcpSamplePublicToolName(def),
		"scriptPath":     path,
		"commandPreview": mcpSampleCommandPreview(def, path),
		"envKeys":        def.EnvKeys,
		"note":           note,
	}, nil
}
