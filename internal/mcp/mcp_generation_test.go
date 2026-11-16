// mcp_generation_test.go：工具世代构建——勾选过滤、stale 对账、hash 碰撞整体回滚、hint 缺省悲观。
package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

func mcpTestRemoteTools() map[string]RemoteTool {
	ro := true
	destr := false
	open := true
	return map[string]RemoteTool{
		"read_thing":  {Name: "read_thing", Description: "读取", InputSchema: json.RawMessage(`{"type":"object"}`), Annotations: &mcpToolAnnotations{ReadOnlyHint: &ro}},
		"write_thing": {Name: "write_thing", Description: "写入", Annotations: nil}, // 无 annotations：全部取悲观默认
		"explore":     {Name: "explore", Description: "上网", Annotations: &mcpToolAnnotations{ReadOnlyHint: &ro, DestructiveHint: &destr, OpenWorldHint: &open}},
	}
}

func TestMCPBuildToolSet(t *testing.T) {
	defs, stale, err := mcpBuildToolSet("srv", mcpTestRemoteTools(), []string{"read_thing", "write_thing"})
	if err != nil {
		t.Fatalf("构建失败：%v", err)
	}
	if len(stale) != 0 {
		t.Fatalf("不应有 stale：%v", stale)
	}
	if len(defs) != 2 {
		t.Fatalf("应产出 2 个工具，实际 %d", len(defs))
	}
	byRaw := map[string]mcpPublicToolDef{}
	for _, def := range defs {
		byRaw[def.RawName] = def
	}
	if byRaw["read_thing"].PublicName != "mcp__srv__read_thing" {
		t.Fatalf("公开名不符：%q", byRaw["read_thing"].PublicName)
	}
	if !byRaw["read_thing"].ReadOnly || !byRaw["read_thing"].Destructive || byRaw["read_thing"].OpenWorld {
		// 只声明 readOnlyHint：destructive 缺省 = true（hint 语义悲观默认）
		t.Fatalf("readOnlyHint=true 的 hints 不符：%+v", byRaw["read_thing"])
	}
	if _, ok := byRaw["explore"]; ok {
		if byRaw["explore"].Destructive || !byRaw["explore"].OpenWorld {
			t.Fatalf("显式 hints 不符：%+v", byRaw["explore"])
		}
	}
	// 无 annotations：readOnly=false、destructive=true（默认悲观）、openWorld=false
	if byRaw["write_thing"].ReadOnly || !byRaw["write_thing"].Destructive {
		t.Fatalf("缺 annotations 应回落悲观默认：%+v", byRaw["write_thing"])
	}
	// 描述加归属前缀
	if !strings.HasPrefix(byRaw["read_thing"].Description, "[MCP:srv] 读取") {
		t.Fatalf("描述应有归属前缀：%q", byRaw["read_thing"].Description)
	}
}

func TestMCPBuildToolSetStale(t *testing.T) {
	defs, stale, err := mcpBuildToolSet("srv", mcpTestRemoteTools(), []string{"read_thing", "gone_tool"})
	if err != nil {
		t.Fatalf("存在 stale 不算失败（server 升级移除工具是常态）：%v", err)
	}
	if len(defs) != 1 {
		t.Fatalf("存在的工具仍应产出：%d", len(defs))
	}
	if len(stale) != 1 || stale[0] != "gone_tool" {
		t.Fatalf("stale 对账清单不符：%v", stale)
	}
}

func TestMCPBuildToolSetEmptySelection(t *testing.T) {
	// EnabledTools 空数组 = 一个都不给（刻意的安全默认）
	defs, stale, err := mcpBuildToolSet("srv", mcpTestRemoteTools(), nil)
	if err != nil || len(defs) != 0 || len(stale) != 0 {
		t.Fatalf("空勾选应得空世代：%+v %+v %v", defs, stale, err)
	}
}

func TestMCPBuildToolSetAntiCollapse(t *testing.T) {
	// 两个身份规范化后同串：12 位身份 hash 保证公开名不折叠（这正是 hash 输入用原始身份的意义）
	tools := map[string]RemoteTool{
		"a.b.c": {Name: "a.b.c", Description: "身份1"},
		"a_b_c": {Name: "a_b_c", Description: "身份2"},
	}
	defs, _, err := mcpBuildToolSet("srv", tools, []string{"a.b.c", "a_b_c"})
	if err != nil {
		t.Fatalf("规范化折叠应由 hash 分开，不应失败：%v", err)
	}
	if len(defs) != 2 || defs[0].PublicName == defs[1].PublicName {
		t.Fatalf("两个身份的公开名不得相同：%+v", defs)
	}
}

func TestMCPToolDescriptionTruncated(t *testing.T) {
	long := strings.Repeat("汉", 500)
	got := mcpToolDescription("srv", long)
	if len(got) > mcpDescriptionMax+50 {
		t.Fatalf("描述截断后长度失控：%d", len(got))
	}
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("截断应带省略号：%q", got[len(got)-10:])
	}
}
