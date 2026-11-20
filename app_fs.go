package main

// 文件系统对话框的 Wails 绑定（目录/条目操作在 internal/fsops）。

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/fsops"
)

func (a *App) OpenFilesDialog() ([]string, error) {
	if wailsApp == nil {
		return nil, nil
	}
	return wailsApp.Dialog.OpenFile().
		SetTitle("打开文件").
		AddFilter("结构化数据 (*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)", "*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv").
		AddFilter("所有文件 (*.*)", "*.*").
		PromptForMultipleSelection()
}

func (a *App) OpenFolderDialog(defaultDir string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	dialog := wailsApp.Dialog.OpenFile().
		CanChooseFiles(false).
		CanChooseDirectories(true).
		SetTitle("打开文件夹")
	if strings.TrimSpace(defaultDir) != "" {
		dialog.SetDirectory(defaultDir)
	}
	return dialog.PromptForSingleSelection()
}

func (a *App) SaveFileDialog(defaultName string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	dialog := wailsApp.Dialog.SaveFile()
	dialog.SetOptions(&application.SaveFileDialogOptions{Title: "保存文件"})
	return dialog.
		SetFilename(defaultName).
		AddFilter("所有文件 (*.*)", "*.*").
		PromptForSingleSelection()
}

// 兼容别名（实现已下沉 internal/fsops）。
type DirEntry = fsops.DirEntry

type DirListing = fsops.DirListing
