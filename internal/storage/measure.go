// measure.go：占用体积统计。只统计常规文件，读不动的条目（权限、被独占的子目录）
// 直接跳过而不报错——统计是「点开设置页就要给数」的旁路能力，不能因为一个坏目录就整页失败。
package storage

import (
	"io/fs"
	"os"
	"path/filepath"
)

type usage struct {
	bytes   int64
	files   int
	entries int // children 型目标的直接子项数
	approx  bool
}

func (u *usage) add(other usage) {
	u.bytes += other.bytes
	u.files += other.files
	u.entries += other.entries
	if other.approx {
		u.approx = true
	}
}

// measurePath 统计一个文件或整棵目录树。budget 是整次扫描共享的条目预算，
// 用尽后把 approx 置真并停手：宁可给「约」的数字，也不能把 UI 卡死。
func measurePath(path string, budget *int) usage {
	out := usage{}
	if path == "" || *budget <= 0 {
		out.approx = *budget <= 0
		return out
	}
	info, err := os.Lstat(path)
	if err != nil || !removableKind(info.Mode()) {
		return out
	}
	if !info.IsDir() {
		out.bytes = info.Size()
		out.files = 1
		*budget--
		return out
	}
	_ = filepath.WalkDir(path, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil || entry == nil || entry.IsDir() {
			return nil
		}
		if *budget <= 0 {
			out.approx = true
			return fs.SkipAll
		}
		*budget--
		if fi, ierr := entry.Info(); ierr == nil && fi.Mode().IsRegular() {
			out.bytes += fi.Size()
			out.files++
		}
		return nil
	})
	return out
}

// measureTarget 统计一个目标：children 型逐个白名单子项算（同时得到子项数），
// 其余按解析出的路径（含 SQLite 伴生文件）算。
func (s *Service) measureTarget(t target, workspaceRoot string, budget *int) usage {
	out := usage{}
	path := t.resolve(s, workspaceRoot)
	if path == "" {
		return out
	}
	if !t.children {
		for _, file := range s.targetFiles(t, workspaceRoot) {
			out.add(measurePath(file, budget))
		}
		return out
	}
	if _, err := os.ReadDir(path); err != nil {
		return out
	}
	for _, child := range s.targetFiles(t, workspaceRoot) {
		if *budget <= 0 {
			out.approx = true
			break
		}
		out.add(measurePath(child, budget))
		out.entries++
	}
	return out
}
