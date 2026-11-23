package main

// mcp_samples.go：内置 MCP 示例资源的根壳——embed 路径相对包目录，
// 资源本体由 internal/mcpsamples 消费。

import (
	"embed"

	"datalens/internal/mcp"
	"datalens/internal/mcpsamples"
)

//go:embed docs/mcp-samples/tts-sapi.ps1 docs/mcp-samples/ocr-windows.ps1 docs/mcp-samples/asr-whisper.py
var mcpSampleFS embed.FS

// MCPInstallSample 覆盖内嵌 *mcpsamples.Samples 的提升方法：释放脚本 + 写盘之后，把 mcp.json
// 现状应用到运行态管理器。其它写盘路径（MCPWriteConfig / MCPSetServerEnabled）自带 ApplyConfig；
// 只有示例安装绕过 Client 直接写盘，漏了这步新 server 不进 m.servers，MCPSnapshot 的惰性启动
// 看不到它、也不发 mcp-tools-changed——表现就是「装好了列表不刷新，退出重进才出现」。
func (a *App) MCPInstallSample(id string) (map[string]interface{}, error) {
	result, err := a.Samples.MCPInstallSample(id)
	if err != nil {
		return nil, err
	}
	// 应用失败不回滚已写盘的配置（脚本与条目已落盘，重启仍生效），只记日志；前端安装后
	// 的 refreshMcpConfig 兜底拉取也会再试一次。
	if err := mcp.ApplyConfigFromDisk(a.Client); err != nil {
		writeAppLog("warn", "MCP 示例安装后应用配置失败：%v", err)
	}
	return result, nil
}

func init() {
	mcpsamples.Embedded = mcpSampleFS
	mcpsamples.Version = appVersion
	// 启动前自愈在 desktop_mcp.go 的 prepareMCPServers 里组合注入（与内置桌面 wheel 共用一个
	// mcp.PrepareServer 钩子）：脚本被存储清理删掉 / 版本升级换了目录时，按 mcp.json 里的原路径
	// 补回，否则已注册的示例服务器会初始化失败十次后放弃（见 storage specs 的 builtin-mcp-samples）。
}
