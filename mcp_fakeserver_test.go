// mcp_fakeserver_test.go：go test 二进制自调用充当 MCP server（os.Args[0] + 环境变量开关），
// 不在 testdata 里塞编译产物。需要覆盖的假 server 行为见各 mode。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("MCP_FAKE_SERVER"); mode != "" {
		runFakeMCPServer(mode)
		return
	}
	os.Exit(m.Run())
}

func fakeTool(name, desc string) map[string]any {
	return map[string]any{
		"name":        name,
		"description": desc,
		"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		"annotations": map[string]any{"readOnlyHint": true},
	}
}

// fakeResult / fakeError 构造 JSON-RPC 响应：结果必须嵌在 "result" 里，不能摊在顶层。
func fakeResult(id json.RawMessage, result map[string]any) []byte {
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	return data
}

func fakeError(id json.RawMessage, code int, message string) []byte {
	data, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id,
		"error": map[string]any{"code": code, "message": message},
	})
	return data
}

func runFakeMCPServer(mode string) {
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64<<10), 8<<20)
	out := bufio.NewWriter(os.Stdout)

	writeResult := func(id json.RawMessage, result map[string]any) {
		out.Write(fakeResult(id, result))
		out.WriteByte('\n')
		out.Flush()
	}
	writeError := func(id json.RawMessage, code int, message string) {
		out.Write(fakeError(id, code, message))
		out.WriteByte('\n')
		out.Flush()
	}

	switch mode {
	case "banner":
		fmt.Println("hello, this is a banner")
		fmt.Println("[INFO] fake server 启动，输出一些非协议内容")
	case "garbage":
		for i := 0; i < 25; i++ {
			fmt.Printf("not json at all %d\n", i)
		}
	}

	toolsPage := func(cursor string) (tools []map[string]any, next string) {
		switch mode {
		case "paged":
			switch cursor {
			case "":
				return []map[string]any{fakeTool("t1", "第一页工具1"), fakeTool("t2", "第一页工具2")}, "p2"
			case "p2":
				return []map[string]any{fakeTool("t3", "第二页工具1"), fakeTool("t4", "第二页工具2")}, "p3"
			default:
				return []map[string]any{fakeTool("t5", "第三页工具")}, ""
			}
		case "duplicate":
			return []map[string]any{fakeTool("dup", "重复工具"), fakeTool("dup", "重复工具")}, ""
		default:
			return []map[string]any{fakeTool("alpha", "测试工具甲"), fakeTool("beta", "测试工具乙")}, ""
		}
	}

	for in.Scan() {
		var msg rpcMessage
		if err := json.Unmarshal(in.Bytes(), &msg); err != nil {
			continue
		}
		switch msg.Method {
		case "initialize":
			if mode == "crash" {
				os.Exit(1) // 握手期当场退出：测「server 进程意外退出」
			}
			if mode == "slow" {
				time.Sleep(300 * time.Millisecond) // 模拟启动慢（首启要下载依赖的场景）
			}
			writeResult(msg.ID, map[string]any{
				"protocolVersion": mcpProtocolVersion,
				"capabilities":    map[string]any{},
				"serverInfo":      map[string]any{"name": "fake-" + mode},
				"instructions":    "假 server 的说明书文本",
			})
		case "notifications/initialized":
			// 通知不回包
		case "tools/list":
			var p struct {
				Cursor string `json:"cursor"`
			}
			_ = json.Unmarshal(msg.Params, &p)
			tools, next := toolsPage(p.Cursor)
			writeResult(msg.ID, map[string]any{"tools": tools, "nextCursor": next})
		case "tools/call":
			switch mode {
			case "toolerr":
				writeResult(msg.ID, map[string]any{
					"content": []map[string]any{{"type": "text", "text": "boom: 业务失败"}},
					"isError": true,
				})
			case "rpcerr":
				writeError(msg.ID, -32000, "server 内部错误")
			default:
				writeResult(msg.ID, map[string]any{
					"content": []map[string]any{{"type": "text", "text": "hello from fake"}},
					"isError": false,
				})
			}
		case "":
			// 缺 method 的畸形消息：忽略
		default:
			if mcpIDPresent(msg.ID) {
				writeError(msg.ID, -32601, "method not found")
			}
		}
	}
	// stdin EOF：正常退出；no-terminate 模式模拟拒绝终止的 server（忽略 EOF 继续活着）
	if mode == "no-terminate" {
		time.Sleep(30 * time.Second)
	}
}
