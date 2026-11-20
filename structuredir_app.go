package main

// structuredir_app.go：目录结构导出的 Wails 绑定——遍历与渲染在 internal/structuredir，
// 这里负责保存对话框与写盘。

import (
	"strings"

	"datalens/internal/structuredir"
)

func (a *App) StructureDir(dir string) (string, error) {
	return structuredir.Render(dir)
}

// ExportStructureDir 先弹出系统保存对话框选择导出路径，再生成并写入；
// 用户取消时返回空路径且不写文件。
func (a *App) ExportStructureDir(dir string) (string, error) {
	clean, rootName, err := structuredir.ResolveRoot(dir)
	if err != nil {
		return "", err
	}
	path, err := a.ShowSaveFileDialog(nil, "导出结构化目录", rootName+"-目录结构.txt", "txt")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	text, err := structuredir.Render(clean)
	if err != nil {
		return "", err
	}
	if err := a.SaveFile(path, text, "lf", false, "utf-8"); err != nil {
		return "", err
	}
	return path, nil
}

// ExportStructureText 先弹出系统保存对话框选择导出路径，再写入调用方给定的文本；
// 用户取消时返回空路径且不写文件。结构面板的结构树导出复用此通道。
func (a *App) ExportStructureText(defaultName string, content string) (string, error) {
	name := strings.TrimSpace(defaultName)
	if name == "" {
		name = "结构.txt"
	}
	filter := "txt"
	if strings.HasSuffix(strings.ToLower(name), ".mmd") {
		filter = "mmd"
	}
	path, err := a.ShowSaveFileDialog(nil, "导出结构", name, filter)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		return "", nil
	}
	if err := a.SaveFile(path, content, "lf", false, "utf-8"); err != nil {
		return "", err
	}
	return path, nil
}
