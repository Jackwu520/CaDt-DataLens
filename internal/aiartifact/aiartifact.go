// Package aiartifact 是 AI 工具结果的大对象落盘区：<应用数据>/ai-artifacts/<会话 id>/。
//
// 存在理由：工具结果动辄几十上百 KB（MCP 回显、抓网页、命令输出），全塞进上下文
// 会让一轮请求就吃掉可观预算。超过阈值的原文放这里，上下文里只留指针 + 预览。
//
// 它是应用数据目录下**唯一对模型可读的子树**（见 ai-read-roots.js 的硬拒白名单）：
// 里面只有工具结果与子代理转录，既没有密钥（ai-config.json）也没有会话正文
// （ai-sessions/）。目录按会话分桶，删会话时整目录清掉，另有存储清理兜底。
package aiartifact

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
)

// DirName 是应用数据目录下的子目录名（前端 ai-read-roots.js 的 ARTIFACT_DIR_NAME 必须同值）。
const DirName = "ai-artifacts"

// MaxBytes 单个产物上限：再大就不落盘了，调用方退回「只保留头尾」的老路。
const MaxBytes = 4 << 20

// ErrTooLarge 表示内容超过 MaxBytes，调用方应退回截断策略。
var ErrTooLarge = fmt.Errorf("产物超过 %d KB", MaxBytes/1024)

// Root 返回产物根目录；应用数据目录不可用时返回空。
func Root() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, DirName)
}

// SessionDir 返回某会话的产物目录；会话 id 非法时返回空。
func SessionDir(sessionID string) string {
	root := Root()
	id := sanitize(sessionID, 64)
	if root == "" || id == "" {
		return ""
	}
	return filepath.Join(root, id)
}

// sanitize 只留下安全字符：会话 id 与产物名都由宿主生成，但仍按最严口径过滤，
// 避免 ".."、路径分隔符或盘符混进来把写入引到目录之外。
func sanitize(value string, maxLen int) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			return ""
		}
	}
	out := strings.Trim(b.String(), ".")
	if len(out) > maxLen {
		out = out[:maxLen]
	}
	if out == "" {
		return ""
	}
	return out
}

// Write 把一段工具结果写到 <会话目录>/<name>.txt，返回绝对路径。
// name 由调用方给（通常是 toolCallId），非法或内容超限都返回错误。
func Write(sessionID, name, content string) (string, error) {
	dir := SessionDir(sessionID)
	file := sanitize(name, 96)
	if dir == "" || file == "" {
		return "", errors.New("会话 id 或产物名非法")
	}
	if len(content) > MaxBytes {
		return "", ErrTooLarge
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, file+".txt")
	if err := atomfile.WriteFileAtomicMode(path, []byte(content), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// ClearSession 删除某会话的全部产物（删会话时调用）。
func ClearSession(sessionID string) error {
	dir := SessionDir(sessionID)
	if dir == "" {
		return nil
	}
	root := Root()
	// 双保险：只删 Root 之下的一级子目录，绝不因为拼路径出错往上删。
	if root == "" || filepath.Dir(dir) != root {
		return errors.New("产物目录越界")
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return nil
}

// ClearAll 删除全部产物（「删除所有会话」时调用）。
func ClearAll() error {
	root := Root()
	// 只认以 ai-artifacts 结尾的目录，避免 Root() 口径变化时误删 appdata 其他内容。
	if root == "" || filepath.Base(root) != DirName {
		return errors.New("产物根目录异常")
	}
	return os.RemoveAll(root)
}
