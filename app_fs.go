package main

// 文件系统对话框的 Wails 绑定（目录/条目操作在 internal/fsops）。

import (
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"datalens/internal/fsops"
)

func (a *App) OpenFilesDialog() ([]string, error) {
	return runtime.OpenMultipleFilesDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "打开文件",
		Filters: []runtime.FileFilter{
			{DisplayName: "结构化数据 (*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv)", Pattern: "*.json;*.jsonl;*.ndjson;*.yaml;*.yml;*.xml;*.svg;*.csv;*.tsv"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

func (a *App) OpenFolderDialog(defaultDir string) (string, error) {
	opts := runtime.OpenDialogOptions{Title: "打开文件夹"}
	if strings.TrimSpace(defaultDir) != "" {
		opts.DefaultDirectory = defaultDir
	}
	return runtime.OpenDirectoryDialog(a.ctx, opts)
}

func (a *App) SaveFileDialog(defaultName string) (string, error) {
	return runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "保存文件",
		DefaultFilename: defaultName,
		Filters: []runtime.FileFilter{
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

// 兼容别名（实现已下沉 internal/fsops）。
type DirEntry = fsops.DirEntry

type DirListing = fsops.DirListing

type DirTreeNode = fsops.DirTreeNode

type DirTreeListing = fsops.DirTreeListing
