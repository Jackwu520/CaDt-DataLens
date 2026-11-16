// launchargs：启动参数解析 —— 打开目标（文件:行:列）、设置页、AI 会话、单实例 ID 与开关判定。
package launchargs

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// OpenTarget 启动时要打开的文件或目录；行列从 1 开始，0 表示未指定。
type OpenTarget struct {
	Path   string `json:"path"`
	Line   int    `json:"line,omitempty"`
	Column int    `json:"column,omitempty"`
}

// ParseOpenSettingsArg 解析 --open-settings=<pane>，没有则返回空串。
func ParseOpenSettingsArg(args []string) string {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if strings.HasPrefix(arg, "--open-settings=") {
			return strings.TrimPrefix(arg, "--open-settings=")
		}
	}
	return ""
}

// ParseAISessionArg 解析 --ai-session=<id>，没有则返回空串。
func ParseAISessionArg(args []string) string {
	for _, arg := range args {
		arg = strings.TrimSpace(arg)
		if strings.HasPrefix(arg, "--ai-session=") {
			return strings.TrimSpace(strings.TrimPrefix(arg, "--ai-session="))
		}
	}
	return ""
}

// PathArgs 返回参数里真实存在（且以 - 开头的开关除外）的文件与目录。
func PathArgs(args []string) []string {
	exe, _ := os.Executable()
	var paths []string
	for _, arg := range args {
		if arg == "" || strings.HasPrefix(arg, "-") || strings.EqualFold(arg, exe) {
			continue
		}
		if _, err := os.Stat(arg); err == nil {
			paths = append(paths, arg)
		}
	}
	return paths
}

// FirstPathArg 返回第一个真实存在的路径参数。
func FirstPathArg(args []string) string {
	if paths := PathArgs(args); len(paths) > 0 {
		return paths[0]
	}
	return ""
}

func positiveInt(value string) int {
	n, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func splitPathLine(arg string) (string, int, int, bool) {
	lastColon := strings.LastIndex(arg, ":")
	if lastColon <= 0 {
		return "", 0, 0, false
	}
	line, err := strconv.Atoi(arg[lastColon+1:])
	if err != nil || line <= 0 {
		return "", 0, 0, false
	}
	prefix := arg[:lastColon]
	if _, err := os.Stat(prefix); err == nil {
		return prefix, line, 0, true
	}
	prevColon := strings.LastIndex(prefix, ":")
	if prevColon <= 0 {
		return "", 0, 0, false
	}
	middle, err := strconv.Atoi(prefix[prevColon+1:])
	if err != nil || middle <= 0 {
		return "", 0, 0, false
	}
	path := prefix[:prevColon]
	if _, err := os.Stat(path); err == nil {
		return path, middle, line, true
	}
	return "", 0, 0, false
}

// ParseOpenTargets 把命令行参数解析成打开目标列表（支持 path:line[:column] 与
// --line/--column/--goto 三种写法）。
func ParseOpenTargets(args []string) []OpenTarget {
	exe, _ := os.Executable()
	targets := []OpenTarget{}
	pendingLine, pendingColumn := 0, 0
	for i := 0; i < len(args); i++ {
		arg := strings.TrimSpace(args[i])
		if arg == "" || strings.EqualFold(arg, exe) || arg == "--new-window" {
			continue
		}
		if arg == "--goto" || arg == "-g" {
			continue
		}
		if strings.HasPrefix(arg, "--line=") {
			pendingLine = positiveInt(strings.TrimPrefix(arg, "--line="))
			continue
		}
		if arg == "--line" || arg == "-l" {
			if i+1 < len(args) {
				i++
				pendingLine = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "--column=") {
			pendingColumn = positiveInt(strings.TrimPrefix(arg, "--column="))
			continue
		}
		if arg == "--column" || arg == "-c" {
			if i+1 < len(args) {
				i++
				pendingColumn = positiveInt(args[i])
			}
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		path := arg
		line, column := pendingLine, pendingColumn
		if _, err := os.Stat(path); err != nil {
			if p, l, c, ok := splitPathLine(arg); ok {
				path = p
				line = l
				if c > 0 {
					column = c
				}
			}
		}
		if _, err := os.Stat(path); err != nil {
			continue
		}
		targets = append(targets, OpenTarget{Path: path, Line: line, Column: column})
		pendingLine, pendingColumn = 0, 0
	}
	if len(targets) > 0 {
		last := &targets[len(targets)-1]
		if pendingLine > 0 && last.Line == 0 {
			last.Line = pendingLine
		}
		if pendingColumn > 0 && last.Column == 0 {
			last.Column = pendingColumn
		}
	}
	return targets
}

// StartupCwdTarget 裸启动（无参数）时把当前目录作为工作区打开；
// 双击 exe 启动时 CWD 等于 exe 目录，此时返回空（走欢迎页）。
func StartupCwdTarget() []OpenTarget {
	wd, err := os.Getwd()
	if err != nil || strings.TrimSpace(wd) == "" {
		return nil
	}
	if exe, exeErr := os.Executable(); exeErr == nil && exe != "" {
		if strings.EqualFold(filepath.Dir(exe), wd) {
			return nil
		}
	}
	info, err := os.Stat(wd)
	if err != nil || !info.IsDir() {
		return nil
	}
	return []OpenTarget{{Path: wd}}
}

// HasFlag 判断参数里是否带有某个开关（独立窗口/调试控制台等）。
func HasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

// UniqueIDForArgs 计算单实例锁 ID：--new-window 或配置为 window 打开模式时给随机 ID，
// 让新进程真正开出独立窗口。
func UniqueIDForArgs(args []string, openMode string) string {
	for _, arg := range args {
		if arg == "--new-window" {
			return randomLaunchID()
		}
	}
	if openMode == "window" {
		return randomLaunchID()
	}
	return "cadt-datalens-7f3a9c21"
}

func randomLaunchID() string {
	return fmt.Sprintf("cadt-datalens-window-%d-%d", os.Getpid(), time.Now().UnixNano())
}
