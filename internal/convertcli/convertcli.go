// convertcli：--convert 命令行模式的参数解析与任务构建（实际格式互转由前端执行，本包只管命令行协议）。
package convertcli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Job 是一次输入到输出的转换任务。
type Job struct {
	Input  string `json:"input"`
	Output string `json:"output"`
}

// Options 是解析后的转换模式选项。
type Options struct {
	Jobs   []Job
	To     string
	Stdout bool
	Force  bool
}

// Request 下发给前端的转换请求。
type Request struct {
	Jobs   []Job  `json:"jobs"`
	To     string `json:"to"`
	Stdout bool   `json:"stdout"`
}

// Result 是前端返回的单条转换结果。
type Result struct {
	Input   string `json:"input"`
	Output  string `json:"output"`
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Payload 是前端回传的完整结果集。
type Payload struct {
	Stdout  bool     `json:"stdout"`
	Results []Result `json:"results"`
}

var targetExts = map[string]string{
	"json":  ".json",
	"jsonl": ".jsonl",
	"yaml":  ".yaml",
	"xml":   ".xml",
	"csv":   ".csv",
	"toml":  ".toml",
	"ini":   ".ini",
}

func normalizeTarget(value string) (string, string, error) {
	id := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(value, ".")))
	switch id {
	case "yml":
		id = "yaml"
	case "ndjson":
		id = "jsonl"
	}
	ext, ok := targetExts[id]
	if !ok {
		return "", "", fmt.Errorf("不支持的目标格式：%s（可用：json/jsonl/yaml/xml/csv/toml/ini）", value)
	}
	return id, ext, nil
}

func replaceFileExt(path, ext string) string {
	current := filepath.Ext(path)
	return strings.TrimSuffix(path, current) + ext
}

func expandInputs(args []string) ([]string, error) {
	out := make([]string, 0, len(args))
	for _, arg := range args {
		if strings.ContainsAny(arg, "*?[") {
			matches, err := filepath.Glob(arg)
			if err != nil {
				return nil, fmt.Errorf("通配符无效：%s", arg)
			}
			if len(matches) == 0 {
				return nil, fmt.Errorf("没有匹配的文件：%s", arg)
			}
			out = append(out, matches...)
			continue
		}
		info, err := os.Stat(arg)
		if err != nil {
			return nil, fmt.Errorf("无法读取输入：%s", arg)
		}
		if info.IsDir() {
			return nil, fmt.Errorf("输入是目录：%s", arg)
		}
		out = append(out, arg)
	}
	return out, nil
}

// ParseArgs 解析 --convert 参数；isConvert=false 表示普通 GUI 启动。
func ParseArgs(args []string) (*Options, bool, error) {
	isConvert := false
	// 先整体判断是否转换模式：GUI 启动参数（--new-window / --ai-float / --debug-console 等）
	// 不能当成未知参数拒绝，否则独立窗口子进程会在启动前直接退出。
	for _, arg := range args {
		if strings.TrimSpace(arg) == "--convert" {
			isConvert = true
			break
		}
	}
	var inputs []string
	to := ""
	out := ""
	stdout := false
	force := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--convert":
		case arg == "--to" || arg == "-t":
			i++
			if i >= len(args) {
				return nil, true, errors.New("--to 缺少格式名")
			}
			to = args[i]
		case strings.HasPrefix(arg, "--to="):
			to = strings.TrimPrefix(arg, "--to=")
		case arg == "--out" || arg == "-o":
			i++
			if i >= len(args) {
				return nil, true, errors.New("--out 缺少路径")
			}
			out = args[i]
		case strings.HasPrefix(arg, "--out="):
			out = strings.TrimPrefix(arg, "--out=")
		case arg == "--stdout":
			stdout = true
		case arg == "--force":
			force = true
		case strings.HasPrefix(arg, "-"):
			if !isConvert {
				continue
			}
			return nil, true, fmt.Errorf("未知参数：%s", arg)
		default:
			inputs = append(inputs, arg)
		}
	}
	if !isConvert {
		return nil, false, nil
	}
	if to == "" {
		return nil, true, errors.New("缺少 --to 目标格式\n" + Usage)
	}
	targetID, targetExt, err := normalizeTarget(to)
	if err != nil {
		return nil, true, err
	}
	if len(inputs) == 0 {
		return nil, true, errors.New("缺少输入文件\n" + Usage)
	}
	expanded, err := expandInputs(inputs)
	if err != nil {
		return nil, true, err
	}
	for i, input := range expanded {
		if abs, err := filepath.Abs(input); err == nil {
			expanded[i] = abs
		}
	}
	if stdout && len(expanded) > 1 {
		return nil, true, errors.New("--stdout 只能用于单个输入文件")
	}
	if out != "" {
		if abs, err := filepath.Abs(out); err == nil {
			out = abs
		}
	}
	outIsDir := false
	if out != "" {
		if info, err := os.Stat(out); err == nil && info.IsDir() {
			outIsDir = true
		} else if strings.HasSuffix(out, string(os.PathSeparator)) || strings.HasSuffix(out, "/") {
			return nil, true, fmt.Errorf("输出目录不存在：%s", out)
		}
	}
	if out != "" && !outIsDir && len(expanded) > 1 {
		return nil, true, errors.New("多个输入文件时 --out 必须是已存在的目录")
	}
	jobs := make([]Job, 0, len(expanded))
	for _, input := range expanded {
		output := ""
		if !stdout {
			switch {
			case outIsDir:
				output = filepath.Join(out, replaceFileExt(filepath.Base(input), targetExt))
			case out != "":
				output = out
			default:
				output = replaceFileExt(input, targetExt)
			}
			if !force && output != "" {
				if _, err := os.Stat(output); err == nil {
					return nil, true, fmt.Errorf("输出文件已存在：%s（加 --force 覆盖）", output)
				}
			}
		}
		jobs = append(jobs, Job{Input: input, Output: output})
	}
	return &Options{Jobs: jobs, To: targetID, Stdout: stdout, Force: force}, true, nil
}

// Usage 是 --convert 的帮助文本。
const Usage = `用法：
  CaDt-DataLens.exe --convert <输入...> --to <格式> [--out <文件|目录>] [--stdout] [--force]

格式：json、jsonl、yaml、xml、csv、toml、ini
示例：
  CaDt-DataLens.exe --convert a.json --to yaml
  CaDt-DataLens.exe --convert logs\*.jsonl --to csv --out dist\
  CaDt-DataLens.exe --convert config.yaml --to json --stdout`
