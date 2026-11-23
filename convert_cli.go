package main

// convert_cli.go：--convert 命令行模式的 App 生命周期（隐藏窗口、前端回调、退出码）。
// 参数解析与任务构建在 internal/convertcli。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"datalens/internal/atomfile"
	"datalens/internal/convertcli"
)

// GetConvertRequest 供前端在 CLI 转换模式下读取任务；普通窗口返回空串。
func (a *App) GetConvertRequest() string {
	if a.convert == nil {
		return ""
	}
	data, err := json.Marshal(convertcli.Request{Jobs: a.convert.Jobs, To: a.convert.To, Stdout: a.convert.Stdout})
	if err != nil {
		return ""
	}
	return string(data)
}

// FinishConvert 写回转换结果并退出隐藏窗口。
func (a *App) FinishConvert(payload string) error {
	if a.convert == nil {
		return errors.New("当前不是转换模式")
	}
	var data convertcli.Payload
	if err := json.Unmarshal([]byte(payload), &data); err != nil {
		a.finishConvertWithError(fmt.Errorf("转换结果格式无效：%w", err))
		return err
	}
	var firstErr error
	written := 0
	for _, result := range data.Results {
		if strings.TrimSpace(result.Error) != "" {
			fmt.Fprintf(os.Stderr, "转换失败 %s：%s\n", result.Input, result.Error)
			if firstErr == nil {
				firstErr = errors.New(result.Error)
			}
			continue
		}
		if result.Output == "" {
			fmt.Fprint(os.Stdout, result.Content)
			if !strings.HasSuffix(result.Content, "\n") {
				fmt.Fprintln(os.Stdout)
			}
			continue
		}
		if err := atomfile.WriteFileAtomic(result.Output, []byte(result.Content)); err != nil {
			fmt.Fprintf(os.Stderr, "写入失败 %s：%v\n", result.Output, err)
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		written++
		fmt.Fprintf(os.Stderr, "已转换：%s -> %s\n", result.Input, result.Output)
	}
	if firstErr != nil {
		a.convertExitCode = 1
	} else {
		a.convertExitCode = 0
	}
	if data.Stdout {
		fmt.Fprintln(os.Stderr, "完成。")
	} else {
		fmt.Fprintf(os.Stderr, "完成，共写入 %d 个文件。\n", written)
	}
	a.convertDone.Store(true)
	go quitApp()
	return firstErr
}

func (a *App) finishConvertWithError(err error) {
	fmt.Fprintln(os.Stderr, err)
	a.convertExitCode = 1
	a.convertDone.Store(true)
	go quitApp()
}

func (a *App) convertMode() bool { return a.convert != nil }

func (a *App) waitConvertTimeout() {
	go func() {
		<-time.After(30 * time.Second)
		if !a.convertDone.Load() {
			fmt.Fprintln(os.Stderr, "转换超时：前端未返回结果")
			a.convertExitCode = 1
			os.Exit(1)
		}
	}()
}
