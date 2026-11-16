package main

import "datalens/internal/aigroups"

// init：AI 群聊存储接线（根目录 <appdata>/ai-groups/，方案 docs/unfinished-plans/ai-group-chat.md §6.5）。
// 群聊不进会话搜索索引（§16.8）、无派生索引钩子——共享对话 JSONL 是唯一真源；
// 绑定方法由 App 匿名嵌入 *aigroups.GroupStore 提升（app_core.go）。
func init() {
	aigroups.AppDataDir = appDataRoot
}
