package main

// 文件系统对话框的 Wails 绑定（目录/条目操作在 internal/fsops）。

import (
	"context"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"datalens/internal/fsops"
)

func (a *App) OpenFilesDialog(ctx context.Context) ([]string, error) {
	if wailsApp == nil {
		return nil, nil
	}
	dialog := wailsApp.Dialog.OpenFile().
		SetTitle("打开文件").
		AddFilter("结构化数据 (*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)", "*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv").
		AddFilter("所有文件 (*.*)", "*.*")
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	paths, err := dialog.PromptForMultipleSelection()
	if isDialogCancelled(err) {
		return nil, nil
	}
	return paths, err
}

func (a *App) OpenFolderDialog(ctx context.Context, defaultDir string) (string, error) {
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
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	path, err := dialog.PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	return path, err
}

func (a *App) SaveFileDialog(ctx context.Context, defaultName string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	dialog := wailsApp.Dialog.SaveFile()
	dialog.SetOptions(&application.SaveFileDialogOptions{Title: "保存文件"})
	if w := dialogOwner(ctx); w != nil {
		dialog = dialog.AttachToWindow(w)
	}
	path, err := dialog.
		SetFilename(defaultName).
		AddFilter("所有文件 (*.*)", "*.*").
		PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	return path, err
}

// 兼容别名（实现已下沉 internal/fsops）。
type DirEntry = fsops.DirEntry

type DirListing = fsops.DirListing
