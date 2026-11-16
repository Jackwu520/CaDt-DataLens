package main

// 文件系统与资源管理器：目录列举、条目新建/改名/复制/移动、拖放落盘、对话框。

import (
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"datalens/internal/search"

	"github.com/wailsapp/wails/v2/pkg/runtime"
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

type DirEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Mtime int64  `json:"mtime,omitempty"`
	Size  int64  `json:"size,omitempty"`
}

type DirListing struct {
	Entries   []DirEntry `json:"entries"`
	Truncated bool       `json:"truncated"`
	Total     int        `json:"total"`
	Mtime     int64      `json:"mtime"`
}

// DirMtime 只读取目录自身的修改时间，供文件树在整目录重读前做廉价变更判断。
func (a *App) DirMtime(path string) (int64, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return 0, fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, fmt.Errorf("不是目录：%s", path)
	}
	return info.ModTime().UnixMilli(), nil
}

func (a *App) ReadDir(path string, limit int) (*DirListing, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("不是目录：%s", path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	total := len(entries)
	truncated := false
	if len(entries) > limit {
		entries = entries[:limit]
		truncated = true
	}
	out := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		item := DirEntry{
			Name:  entry.Name(),
			Path:  filepath.Join(path, entry.Name()),
			IsDir: entry.IsDir(),
		}
		if info, err := entry.Info(); err == nil {
			item.Mtime = info.ModTime().UnixMilli()
			if !item.IsDir {
				item.Size = info.Size()
			}
		}
		out = append(out, item)
	}
	return &DirListing{Entries: out, Truncated: truncated, Total: total, Mtime: info.ModTime().UnixMilli()}, nil
}

// ---- list_dir 递归树（AI 工具 depth>1 走这里） ----

type DirTreeNode struct {
	Name     string         `json:"name"`
	IsDir    bool           `json:"isDir"`
	Size     int64          `json:"size,omitempty"`
	Children []*DirTreeNode `json:"children,omitempty"`
	Omitted  bool           `json:"omitted,omitempty"` // 该目录还有条目没列出（预算用尽）
}

type DirTreeListing struct {
	Root      *DirTreeNode `json:"root"`
	Depth     int          `json:"depth"`
	Total     int          `json:"total"` // 实际收录的条目数（不含根）
	Truncated bool         `json:"truncated"`
}

const (
	dirTreeMaxDepth   = 8   // 模型可请求的递归深度上限（再深就是树导出的活）
	dirTreeMaxEntries = 400 // 全树条目预算：超过即截断，防止 node_modules 类目录刷爆上下文
)

// ReadDirTree 递归列目录树。search.SkipDir 命中的目录整棵跳过（与 search_text 同一张表），
// 目录符号链接不跟（防环）；条目预算用尽时在对应目录打 Omitted 并停止深入。
func (a *App) ReadDirTree(path string, depth int) (*DirTreeListing, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("不是目录：%s", path)
	}
	if depth < 1 {
		depth = 1
	}
	if depth > dirTreeMaxDepth {
		depth = dirTreeMaxDepth
	}
	budget := dirTreeMaxEntries
	root, truncated := walkDirTree(path, depth, &budget)
	return &DirTreeListing{Root: root, Depth: depth, Total: dirTreeMaxEntries - budget, Truncated: truncated}, nil
}

// walkDirTree 递归收录；根级读失败由调用方先 os.Stat 挡过，子级读失败按空目录跳过。
func walkDirTree(dir string, remainingDepth int, budget *int) (*DirTreeNode, bool) {
	node := &DirTreeNode{Name: filepath.Base(dir), IsDir: true}
	if remainingDepth <= 0 {
		return node, false
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		node.Omitted = true
		return node, false
	}
	sortDirTreeEntries(entries)
	truncated := false
	for _, entry := range entries {
		name := entry.Name()
		isDir := entry.IsDir() && entry.Type()&os.ModeSymlink == 0
		if isDir && search.SkipDir(name) {
			continue
		}
		if *budget <= 0 {
			node.Omitted = true
			return node, true
		}
		*budget--
		child := &DirTreeNode{Name: name, IsDir: isDir}
		if !isDir {
			if info, err := entry.Info(); err == nil {
				child.Size = info.Size()
			}
		}
		node.Children = append(node.Children, child)
		if isDir {
			sub, subTruncated := walkDirTree(filepath.Join(dir, name), remainingDepth-1, budget)
			child.Children = sub.Children
			child.Omitted = sub.Omitted
			truncated = truncated || subTruncated
		}
	}
	return node, truncated
}

// sortDirTreeEntries 目录在前，名字不区分大小写（Windows 资源管理器语义的简化版）
func sortDirTreeEntries(entries []os.DirEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		aDir := entries[i].IsDir() && entries[i].Type()&os.ModeSymlink == 0
		bDir := entries[j].IsDir() && entries[j].Type()&os.ModeSymlink == 0
		if aDir != bDir {
			return aDir
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})
}

var reservedEntryNames = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

func validateEntryName(name string) (string, error) {
	if strings.TrimSpace(name) != name {
		return "", fmt.Errorf("名称不能以空格或制表符开头或结尾")
	}
	trimmed := name
	if trimmed == "" {
		return "", fmt.Errorf("名称不能为空")
	}
	if trimmed == "." || trimmed == ".." {
		return "", fmt.Errorf("名称不能是 . 或 ..")
	}
	if strings.ContainsAny(trimmed, `<>:"/\|?*`) {
		return "", fmt.Errorf("名称不能包含 < > : \" / \\ | ? *")
	}
	for _, r := range trimmed {
		if r < 32 {
			return "", fmt.Errorf("名称不能包含控制字符")
		}
	}
	if strings.HasSuffix(trimmed, ".") {
		return "", fmt.Errorf("名称不能以点结尾")
	}
	stem := strings.TrimSuffix(trimmed, filepath.Ext(trimmed))
	if reservedEntryNames[strings.ToLower(stem)] {
		return "", fmt.Errorf("“%s”是 Windows 保留名称", stem)
	}
	return trimmed, nil
}

func (a *App) CreateEntry(dir, name string, isDir bool) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("没有目录路径")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("不是目录：%s", dir)
	}
	clean, err := validateEntryName(name)
	if err != nil {
		return "", err
	}
	target := filepath.Join(dir, clean)
	if _, err := os.Stat(target); err == nil {
		return "", fmt.Errorf("“%s”已存在", clean)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if isDir {
		err = os.Mkdir(target, 0o755)
	} else {
		var f *os.File
		f, err = os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			err = f.Close()
		}
	}
	if err != nil {
		return "", err
	}
	return target, nil
}

func (a *App) RenameEntry(path, newName string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("没有文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	_ = info
	clean, err := validateEntryName(newName)
	if err != nil {
		return "", err
	}
	oldName := filepath.Base(path)
	if clean == oldName {
		return path, nil
	}
	dir := filepath.Dir(path)
	target := filepath.Join(dir, clean)
	if _, err := os.Stat(target); err == nil {
		if !strings.EqualFold(filepath.Clean(target), filepath.Clean(path)) {
			return "", fmt.Errorf("“%s”已存在", clean)
		}
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.Rename(path, target); err != nil {
		return "", err
	}
	return target, nil
}

func entryExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func pathIsWithin(root, target string) bool {
	rel, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func (a *App) SuggestCopyName(dir, name string, isDir bool) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("没有目标目录")
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("目标不是目录：%s", dir)
	}
	clean, err := validateEntryName(name)
	if err != nil {
		return "", err
	}
	if !entryExists(filepath.Join(dir, clean)) {
		return clean, nil
	}
	stem, ext := clean, ""
	if !isDir {
		ext = filepath.Ext(clean)
		stem = strings.TrimSuffix(clean, ext)
		if stem == "" {
			stem, ext = clean, ""
		}
	}
	for i := 1; i <= 500; i++ {
		suffix := " - 副本"
		if i > 1 {
			suffix = fmt.Sprintf(" - 副本 %d", i)
		}
		candidate := stem + suffix + ext
		if !entryExists(filepath.Join(dir, candidate)) {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("无法生成可用的名称")
}

func resolvePasteTarget(src, destDir, newName string) (string, os.FileInfo, error) {
	src = strings.TrimSpace(src)
	srcInfo, err := os.Stat(src)
	if err != nil {
		return "", nil, err
	}
	destDir = strings.TrimSpace(destDir)
	destInfo, err := os.Stat(destDir)
	if err != nil {
		return "", nil, err
	}
	if !destInfo.IsDir() {
		return "", nil, fmt.Errorf("目标不是目录：%s", destDir)
	}
	clean, err := validateEntryName(newName)
	if err != nil {
		return "", nil, err
	}
	dest := filepath.Join(destDir, clean)
	if strings.EqualFold(filepath.Clean(dest), filepath.Clean(src)) {
		return "", nil, fmt.Errorf("目标与源相同")
	}
	if srcInfo.IsDir() && pathIsWithin(src, dest) {
		return "", nil, fmt.Errorf("不能把文件夹复制或移动到它自己的子目录")
	}
	if entryExists(dest) {
		return "", nil, fmt.Errorf("“%s”已存在", clean)
	}
	return dest, srcInfo, nil
}

func copyEntry(src, dst string, info os.FileInfo) error {
	if info.IsDir() {
		if err := os.Mkdir(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			childSrc := filepath.Join(src, entry.Name())
			childDst := filepath.Join(dst, entry.Name())
			childInfo, err := os.Stat(childSrc)
			if err != nil {
				return err
			}
			if err := copyEntry(childSrc, childDst, childInfo); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func (a *App) CopyEntry(src, destDir, newName string) (string, error) {
	dest, info, err := resolvePasteTarget(src, destDir, newName)
	if err != nil {
		return "", err
	}
	if err := copyEntry(src, dest, info); err != nil {
		os.RemoveAll(dest)
		return "", err
	}
	return dest, nil
}

func (a *App) MoveEntry(src, destDir, newName string) (string, error) {
	dest, info, err := resolvePasteTarget(src, destDir, newName)
	if err != nil {
		return "", err
	}
	if err := os.Rename(src, dest); err == nil {
		return dest, nil
	}
	if err := copyEntry(src, dest, info); err != nil {
		os.RemoveAll(dest)
		return "", err
	}
	if err := os.RemoveAll(src); err != nil {
		os.RemoveAll(dest)
		return "", fmt.Errorf("移动失败：无法删除源：%w", err)
	}
	return dest, nil
}

// SaveDataURL 把 data URL（base64）解码后写入目标文件（PNG 导出等二进制落盘用）。
func (a *App) SaveDataURL(path string, dataURL string) error {
	const marker = "base64,"
	idx := strings.Index(dataURL, marker)
	if path == "" {
		return fmt.Errorf("没有目标文件")
	}
	if idx < 0 {
		return fmt.Errorf("无效的数据 URL")
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[idx+len(marker):])
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}

// CopyFileTo 把已有文件复制到指定目标路径（图片另存为用）。
func (a *App) CopyFileTo(srcPath, destPath string) error {
	if srcPath == "" || destPath == "" {
		return fmt.Errorf("路径为空")
	}
	if strings.EqualFold(srcPath, destPath) {
		return nil
	}
	data, err := os.ReadFile(srcPath)
	if err != nil {
		return err
	}
	return os.WriteFile(destPath, data, 0644)
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
