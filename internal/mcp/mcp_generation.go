// mcp_generation.go：工具世代——从 tools/list 原始清单构造面向模型的整代公开工具集。
// 原子性硬约束：要么完整世代，要么没有，绝不部分发布（模型看到「半个 server」排查成本极高）。
package mcp

import (
	"encoding/json"
	"fmt"
)

const (
	mcpDescriptionMax  = 500                        // 单条工具描述截断：远端文本进 system prompt，必须保守
	mcpPublicToolDestr = "destructiveHint 默认为 true" // 仅注释用途
)

// mcpPublicToolDef 面向模型的公开工具定义，也是 Go→前端整代快照的载荷单元。
type mcpPublicToolDef struct {
	PublicName  string          `json:"publicName"` // mcp__<server>__<raw>，纯函数映射
	Server      string          `json:"server"`     // 本地配置键
	RawName     string          `json:"rawName"`    // tools/call 只发这个名字
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
	// hints 只用于设置页角标与留痕，绝不作为审批/安全判断依据（annotations 是 hint 不是保证）
	ReadOnly    bool `json:"readOnly"`
	Destructive bool `json:"destructive"`
	OpenWorld   bool `json:"openWorld"`
}

// mcpBuildToolSet 构造单 server 的整代工具集。
// EnabledTools 里 server 已不存在的工具不算失败（server 升级移除工具是常态）：
// 跳过并记入 stale，由工具面板异步对账标黄提示；hash 碰撞才算失败并整体回滚。
func mcpBuildToolSet(server string, tools map[string]RemoteTool, enabledTools []string) (defs []mcpPublicToolDef, stale []string, err error) {
	defs = make([]mcpPublicToolDef, 0, len(enabledTools))
	seen := map[string]string{} // publicName → rawName，同一 server 内防 hash 碰撞
	for _, raw := range enabledTools {
		tool, ok := tools[raw]
		if !ok {
			stale = append(stale, raw)
			continue
		}
		pub := mcpPublicToolName(server, raw)
		if prev, dup := seen[pub]; dup {
			return nil, nil, fmt.Errorf("公开名 %q 冲突（%q 与 %q 折叠为同一名字）", pub, prev, raw)
		}
		seen[pub] = raw
		defs = append(defs, mcpPublicToolDef{
			PublicName:  pub,
			Server:      server,
			RawName:     raw,
			Description: mcpToolDescription(server, tool.Description),
			InputSchema: tool.InputSchema,
			ReadOnly:    tool.Annotations != nil && tool.Annotations.ReadOnlyHint != nil && *tool.Annotations.ReadOnlyHint,
			Destructive: tool.Annotations == nil || tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint, // 默认悲观
			OpenWorld:   tool.Annotations != nil && tool.Annotations.OpenWorldHint != nil && *tool.Annotations.OpenWorldHint,
		})
	}
	return defs, stale, nil
}

// mcpToolDescription 统一加归属前缀并截断——让模型与用户都看得出这是第三方 server 的描述。
func mcpToolDescription(server, desc string) string {
	full := "[MCP:" + server + "] " + desc
	if len(full) <= mcpDescriptionMax {
		return full
	}
	return mcpTruncateUTF8(full, mcpDescriptionMax) + "…"
}
