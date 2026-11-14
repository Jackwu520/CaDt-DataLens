// mcp_name.go：MCP 工具命名——(serverName, rawName) 的纯函数映射。
// 纯函数是硬要求：公开名进会话历史与权限白名单，重连/重启/配置升级后必须保持不变。
// 干净路径不加 hash（可读性），有损路径（字符替换或截断）加 12 位身份 hash 防折叠。
// 公开名绝不发给 server，也绝不被字符串反解还原（tools/call 只发原始名，路由查表）。
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
)

const mcpPublicNameMax = 64 // 与 aiToolNameRule 的 64 字符契约一致

var mcpInvalidNameChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

func mcpPublicToolName(serverName, rawName string) string {
	joined := "mcp__" + serverName + "__" + rawName
	normalized := mcpInvalidNameChars.ReplaceAllString(joined, "_")
	if normalized == joined && len(normalized) <= mcpPublicNameMax {
		return normalized
	}
	// hash 输入是原始身份而非规范化结果：两个不同身份规范化后相同也能分开
	sum := sha256.Sum256([]byte(serverName + "\x00" + rawName))
	hash := hex.EncodeToString(sum[:])[:12]
	keep := mcpPublicNameMax - 12 - 1
	if keep > len(normalized) {
		keep = len(normalized)
	}
	return normalized[:keep] + "_" + hash
}
