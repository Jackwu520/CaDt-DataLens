package main

// AI 工作日志：AI 通过 write_worklog 工具向工作区沉淀「做过什么」的一行式记录。
// 布局（固定三层，全部相对 <工作区>/.cadt/logs/）：
//
//	INDEX.md                  第 1 层：每月一行（指向对应月份索引）
//	{YYYY}/{MM}/INDEX.md      第 2 层：每条变更一行（只有日期 + 标题，不带摘要）
//	{YYYY}/{MM}/{YYYY-MM-DD}.md  条目正文（时间 + 标题 + 一句话摘要）
//
// 只存标题与摘要，不存正文与敏感信息；追加式写入，跨进程文件锁串行。
// 摘要只进当日正文，索引用标题当一句话条目——索引要能一眼扫完。

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"datalens/internal/sessionlock"
)

const (
	worklogLockName   = ".worklog.lock"
	worklogLockWait   = 2 * time.Second
	worklogTitleMax   = 120 // 标题字符上限（超出截断，进当日正文的标题）
	worklogSummaryMax = 500 // 摘要字符上限（超出截断）
	// worklogIndexTitleMax 月份索引行里标题的字符上限：索引只求一眼扫完，
	// 比正文标题（120）收得紧；工具描述让模型写 ≤40 字，这里留一点余量当兜底。
	worklogIndexTitleMax = 48
)

// 同进程追加互斥（各窗口各建 App，锁必须是包级的）。
var worklogMu sync.Mutex

// worklogDir 工作区日志根目录：<root>/.cadt/logs。
func worklogDir(root string) string {
	return filepath.Join(root, ".cadt", "logs")
}

// worklogSingleLine 把标题 / 摘要压成单行：换行折叠为空格，按字符数截断（多字节安全）。
func worklogSingleLine(text string, max int) string {
	value := strings.Join(strings.Fields(strings.ReplaceAll(text, "\r", "\n")), " ")
	if runes := []rune(value); len(runes) > max {
		value = string(runes[:max])
	}
	return value
}

// hasWorklogMonthLine 根 INDEX.md 里是否已有这个月的一行（行首匹配 "- YYYY-MM"）。
func hasWorklogMonthLine(raw string, stamp string) bool {
	prefix := "- " + stamp[:7]
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), prefix) {
			return true
		}
	}
	return false
}

// worklogIndexTitle 把标题压成索引用的短标题：索引里一行就是一条，长了扫不动。
// 超长时优先在最后一个断句点（：，、；。空格）处截断，断句点太靠前（少于一半）则硬截，
// 两种都补「…」。正文标题不受影响，细节仍在当日正文里。
func worklogIndexTitle(title string, max int) string {
	runes := []rune(title)
	if len(runes) <= max {
		return title
	}
	head := runes[:max]
	cut := -1
	for i := len(head) - 1; i >= 0; i-- {
		switch head[i] {
		case '：', '，', '、', '；', '。', ' ', ':', ',', ';':
			cut = i
		}
		if cut >= 0 {
			break
		}
	}
	if cut >= max/2 {
		return strings.TrimRight(string(head[:cut]), " ") + "…"
	}
	return strings.TrimRight(string(head), " ") + "…"
}

// appendWorklogEntry 在日志目录里追加一条记录：正文按天落文件，
// 月份索引一行一条，根索引每月一行；目录不存在时自动创建（跨月首条也走同一路径）。
// now 由调用方注入，测试可传固定时间。
func appendWorklogEntry(dir string, now time.Time, title, summary string) (string, error) {
	if strings.TrimSpace(title) == "" {
		return "", errors.New("日志标题为空")
	}
	title = worklogSingleLine(title, worklogTitleMax)
	summary = worklogSingleLine(summary, worklogSummaryMax)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建工作日志目录失败：%w", err)
	}
	lock, err := sessionlock.LockFile(filepath.Join(dir, worklogLockName), worklogLockWait)
	if err != nil {
		return "", fmt.Errorf("工作日志正被其他窗口写入，请稍后重试：%w", err)
	}
	defer lock.Release()

	worklogMu.Lock()
	defer worklogMu.Unlock()

	monthDir := filepath.Join(dir, now.Format("2006"), now.Format("01"))
	if err := os.MkdirAll(monthDir, 0o755); err != nil {
		return "", fmt.Errorf("创建月份目录失败：%w", err)
	}
	dayName := now.Format("2006-01-02") + ".md"
	dayPath := filepath.Join(monthDir, dayName)

	// 条目正文：## HH:MM:SS 标题 + 摘要（一句话）
	var entry strings.Builder
	entry.WriteString("## " + now.Format("15:04:05") + " " + title + "\n\n")
	if summary != "" {
		entry.WriteString("- " + summary + "\n\n")
	}
	if err := appendFileText(dayPath, entry.String()); err != nil {
		return "", err
	}

	// 月份索引：每条变更一行，只放「日期 + 短标题」这一句话；摘要留在正文里，不进索引
	// （索引是扫描用的，挤进 500 字摘要就退化成正文复制）
	line := "- " + now.Format("01-02 15:04") + " " + worklogIndexTitle(title, worklogIndexTitleMax) + "（./" + dayName + "）\n"
	if err := appendFileText(filepath.Join(monthDir, "INDEX.md"), line); err != nil {
		return "", err
	}

	// 根索引：每月一行；跨月首条补上新行，已有则跳过
	rootIndex := filepath.Join(dir, "INDEX.md")
	monthStamp := now.Format("2006-01")
	monthLine := "- " + monthStamp + "（./" + now.Format("2006/01") + "/INDEX.md）\n"
	raw, _ := os.ReadFile(rootIndex)
	if !hasWorklogMonthLine(string(raw), monthStamp) {
		if len(raw) == 0 {
			monthLine = "# AI 工作日志\n\n" + monthLine
		}
		if err := appendFileText(rootIndex, monthLine); err != nil {
			return "", err
		}
	}
	return dayPath, nil
}

// appendFileText 以追加模式写一段 UTF-8 文本，写后 fsync（掉电不丢已确认的记录）。
func appendFileText(path, text string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		return err
	}
	return f.Sync()
}

// AIWorklogAppend write_worklog 工具的后端通道：向 <工作区>/.cadt/logs/ 追加一条工作日志，
// 返回条目正文的绝对路径。root 必须是绝对路径的工作区根；标题必填，摘要可选。
func (a *App) AIWorklogAppend(root string, title string, summary string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("没有工作区，无法写工作日志")
	}
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("工作区路径不是绝对路径：%s", root)
	}
	if !utf8.ValidString(title) || !utf8.ValidString(summary) {
		return "", errors.New("日志内容包含非法编码")
	}
	dayPath, err := appendWorklogEntry(worklogDir(root), time.Now(), title, summary)
	if err != nil {
		return "", err
	}
	writeAppLog("INFO", "AI 工作日志已记录：%s", dayPath)
	return dayPath, nil
}
