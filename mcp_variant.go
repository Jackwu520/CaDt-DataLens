//go:build mcp

package main

// mcp_variant.go：MCP 变体（`-tags mcp`，tools/rebuild-exe.ps1 -IncludeMCP）。
//
// v3 内置 MCP server 在 App.Run() 里自动启动（app_info / windows_list /
// window_control / js_eval / dom_html / dom_query / mouse_* / keyboard_*），
// 外部 MCP 客户端（Streamable HTTP）可以直接驱动应用界面；只能用环境变量配置，
// 没有运行期开关。所以该能力做成**构建变体**：标准构建（无 -tags mcp）完全不
// 含这个端点；要用的机器用 `-IncludeMCP` 出变体包。
//
// 这里在 Run 之前准备好令牌与端口：令牌随机生成并持久化到应用数据目录
// mcp-server.json（0600），端口被占用时向后探测空闲端口；连接信息写进同一个
// 文件，供外部客户端配置。js_eval 等于在页面里执行任意 JS——变体只建议在
// 受信机器上使用，不要绑定到非回环地址。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"

	"datalens/internal/atomfile"
)

// mcpVariantEnabled 供启动日志与文档判定（false 分支见 mcp_variant_default.go）。
const mcpVariantEnabled = true

const (
	mcpListenHost     = "127.0.0.1"
	mcpListenPort     = 9099
	mcpPortProbeRange = 20
	mcpServerInfoFile = "mcp-server.json"
)

func bootstrapMCPVariant() {
	root := appDataRoot()
	if root == "" {
		return
	}
	host, port, token := loadMCPServerConfig(root)
	if token == "" {
		buf := make([]byte, 24)
		if _, err := rand.Read(buf); err != nil {
			writeAppLog("warn", "MCP 令牌生成失败：%v", err)
			return
		}
		token = hex.EncodeToString(buf)
	}
	// 端口被占就向后找空闲位：v3 server 绑定失败会让 App.Run 直接报错退出。
	if !portFree(host, port) {
		found := -1
		for p := port + 1; p <= port+mcpPortProbeRange; p++ {
			if portFree(host, p) {
				found = p
				break
			}
		}
		if found < 0 {
			writeAppLog("warn", "MCP 端口探测失败：%d 起连续 %d 个端口均被占用，MCP server 不启动", port, mcpPortProbeRange)
			return
		}
		port = found
	}
	os.Setenv("WAILS_MCP_HOST", host)
	os.Setenv("WAILS_MCP_PORT", strconv.Itoa(port))
	os.Setenv("WAILS_MCP_TOKEN", token)

	endpoint := fmt.Sprintf("http://%s:%d/mcp", host, port)
	// 该文件会被外部脚本/客户端读取，内容保持 ASCII：避免读取方编码口径不一致。
	payload, err := json.MarshalIndent(struct {
		Endpoint string `json:"endpoint"`
		Port     int    `json:"port"`
		Token    string `json:"token"`
		Note     string `json:"note"`
	}{
		Endpoint: endpoint,
		Port:     port,
		Token:    token,
		Note:     "Fill endpoint/token into your MCP client (Streamable HTTP). js_eval can run arbitrary JS in the page: only use on trusted machines. Delete this file and restart the app to rotate the token.",
	}, "", "  ")
	if err == nil {
		_ = atomfile.WriteFileAtomicMode(filepath.Join(root, mcpServerInfoFile), payload, 0600)
	}
	writeAppLog("info", "MCP server 端点：%s（令牌见 %s）", endpoint, mcpServerInfoFile)
}

// loadMCPServerConfig 读回上次持久化的端口与令牌（文件缺失/损坏时用默认值重生成）。
func loadMCPServerConfig(root string) (host string, port int, token string) {
	host = mcpListenHost
	port = mcpListenPort
	raw, err := os.ReadFile(filepath.Join(root, mcpServerInfoFile))
	if err != nil {
		return host, port, ""
	}
	var saved struct {
		Port  int    `json:"port"`
		Token string `json:"token"`
	}
	if json.Unmarshal(raw, &saved) != nil {
		return host, port, ""
	}
	if saved.Port > 0 {
		port = saved.Port
	}
	return host, port, saved.Token
}

func portFree(host string, port int) bool {
	l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}
