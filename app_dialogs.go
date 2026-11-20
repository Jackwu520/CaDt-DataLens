package main

import (
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// 通用文件对话框：打开/保存统一走这里，过滤器用预置短 id，避免把过滤模式散在各调用处。
// 用户取消时路径返回空串，由调用方自行判断不写文件。

// isDialogCancelled 识别文件对话框的取消。v2 显式吞掉取消（空值+nil），v3 的 cfd 层
// 把取消透传成错误——该错误类型在 internal/go-common-file-dialog/cfd 里导不出来，
// 只能按消息识别（对照 v2 dialog.go 的 ErrCancelled 文案）。
func isDialogCancelled(err error) bool {
	return err != nil && strings.Contains(err.Error(), "cancelled by user")
}

// dialogFilter 是 v3 对话框过滤器的最小本地表示（DisplayName + 分号分隔扩展名）。
type dialogFilter struct {
	DisplayName string
	Pattern     string
}

var dialogFilters = map[string][]dialogFilter{
	"exe": {{DisplayName: "可执行文件 (*.exe)", Pattern: "*.exe"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"txt": {{DisplayName: "文本文件 (*.txt)", Pattern: "*.txt"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"log": {{DisplayName: "日志文件 (*.log)", Pattern: "*.log"}, {DisplayName: "文本文件 (*.txt)", Pattern: "*.txt"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"mmd": {{DisplayName: "Mermaid (*.mmd)", Pattern: "*.mmd"}, {DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
	"any": {{DisplayName: "所有文件 (*.*)", Pattern: "*.*"}},
}

func dialogFilterOrAny(filter string) []dialogFilter {
	if filters, ok := dialogFilters[strings.ToLower(strings.TrimSpace(filter))]; ok {
		return filters
	}
	return dialogFilters["any"]
}

// ShowOpenFileDialog 通用文件选择对话框。
func (a *App) ShowOpenFileDialog(title string, filter string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	name := strings.TrimSpace(title)
	if name == "" {
		name = "选择文件"
	}
	dialog := wailsApp.Dialog.OpenFile().SetTitle(name)
	for _, f := range dialogFilterOrAny(filter) {
		dialog.AddFilter(f.DisplayName, f.Pattern)
	}
	path, err := dialog.PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(path), nil
}

// ShowSaveFileDialog 通用保存对话框。
func (a *App) ShowSaveFileDialog(title string, defaultName string, filter string) (string, error) {
	if wailsApp == nil {
		return "", nil
	}
	name := strings.TrimSpace(title)
	if name == "" {
		name = "保存文件"
	}
	dialog := wailsApp.Dialog.SaveFile()
	dialog.SetOptions(&application.SaveFileDialogOptions{Title: name})
	dialog.SetFilename(strings.TrimSpace(defaultName))
	for _, f := range dialogFilterOrAny(filter) {
		dialog.AddFilter(f.DisplayName, f.Pattern)
	}
	path, err := dialog.PromptForSingleSelection()
	if isDialogCancelled(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(path), nil
}
