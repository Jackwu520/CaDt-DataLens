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

// sanitize 把会话 id / 产物名收紧成单段安全文件名：**任一非法字符即整串拒绝**
// （fail-closed），不做替换——替换会产生「名字被改写」的隐式行为，调用方以为写的是 A
// 实际写的是 B。Truncation 在 Trim 之后：先按上限截，再去掉首尾点，保证不会截出
// 以点结尾的目录名（Win32 会剥离尾点，两个不同 id 会落到同一目录）。
// Windows 保留设备名（CON/NUL/COM1…）单独拦：它们不含非法字符，但 Read 打开
// 控制台设备可能把 GUI 进程挂住。
var windowsReservedNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

func sanitize(value string, maxLen int) string {
	var b strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			// 非法字符：整串判废（分隔符、盘符、空格、控制字符都在此拦下）
			return ""
		}
	}
	out := b.String()
	if len(out) > maxLen {
		out = out[:maxLen]
	}
	out = strings.Trim(out, ".")
	if out == "" || windowsReservedNames[strings.ToLower(strings.TrimSuffix(out, filepath.Ext(out)))] {
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

// Read 读回一份产物（子代理转录用）；不存在返回空串，不报错。
// 上限按 MaxBytes 守一次，避免手改出来的大文件把渲染层拖死。
func Read(sessionID, name string) (string, error) {
	dir := SessionDir(sessionID)
	file := sanitize(name, 96)
	if dir == "" || file == "" {
		return "", errors.New("会话 id 或产物名非法")
	}
	info, err := os.Stat(filepath.Join(dir, file+".txt"))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if info.Size() > MaxBytes {
		return "", ErrTooLarge
	}
	raw, err := os.ReadFile(filepath.Join(dir, file+".txt"))
	if err != nil {
		return "", err
	}
	return string(raw), nil
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
	// Root() 全由常量拼出（appdata.Root() + DirName），没有外部输入，这条校验防的只有
	// 一种情况：未来有人改坏 Root() 的口径（丢了 DirName、返回了相对路径）。真出现时
	// 宁可拒绝删除，也不能静默 RemoveAll 一个不可预期的目录。
	if root == "" || filepath.Base(root) != DirName || !filepath.IsAbs(root) {
		return errors.New("产物根目录异常")
	}
	return os.RemoveAll(root)
}
