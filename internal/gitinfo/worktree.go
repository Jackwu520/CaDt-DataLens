// worktree.go：AI 隔离工作区引擎——git worktree 的创建/列表/删除/清理与草稿 diff 导出。
// worktree 一律建在 <主根>/.cadt/worktree/<slug> 下（工作区内，AI 写路径闸天然放行、
// 不用切工作区），分支 cadt/wt/<slug>。slug 由 label + 会话 id 在 Go 侧派生，不信任前端路径。
// 回灌不做在这里：WorktreeDiff 只出补丁文本，PatchSave/审批/应用仍走既有 patch 壳与前端。
package gitinfo

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
)

// ErrWorktreeNoChanges 导出 diff 时 worktree 相对基准没有任何改动（含未跟踪文件）。
var ErrWorktreeNoChanges = errors.New("worktree 没有改动")

const (
	worktreeDirName = ".cadt/worktree" // 主根下的固定父目录（正斜杠语义）
	worktreeBranchP = "cadt/wt/"       // 隔离分支前缀；分支不保留，随 worktree 一起删
)

// slug 字符集白名单：也是路径名与分支段的安全边界（无点无斜杠，git ref 合法）。
var worktreeSlugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// shaRe 允许完整 40 位或 git 缩写（≥7 位）十六进制。
var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{7,64}$`)

type GitWorktreeInfo struct {
	Path      string `json:"path"`                // 绝对路径
	RelPath   string `json:"relPath"`             // 相对仓库根，正斜杠
	Branch    string `json:"branch,omitempty"`    // 去掉 refs/heads/ 前缀
	Head      string `json:"head,omitempty"`
	Detached  bool   `json:"detached,omitempty"`
	Bare      bool   `json:"bare,omitempty"`
	UnderCadt bool   `json:"underCadt,omitempty"` // 在 .cadt/worktree/ 下（AI 隔离区）
}

type GitWorktreeListResult struct {
	Available bool              `json:"available"`
	Reason    string            `json:"reason,omitempty"`
	Root      string            `json:"root,omitempty"`
	Items     []GitWorktreeInfo `json:"items"`
}

type GitWorktreeAddResult struct {
	Name      string   `json:"name"`                // slug（.cadt/worktree/<name>）
	Branch    string   `json:"branch"`              // cadt/wt/<name>
	Path      string   `json:"path"`                // 绝对路径
	BaseSha   string   `json:"baseSha"`             // 创建时主根 HEAD：回灌 diff 的基准
	Deps      []string `json:"deps"`                // 已 junction 共享进 worktree 的依赖目录名（顶层白名单内存在的）
	DepErrors []string `json:"depErrors,omitempty"` // junction 创建失败项（依赖共享是增益不是前提）
}

// junctionWhitelist 依赖目录共享白名单：只共享「通常被 gitignore、由包管理器生成」的
// 顶层目录——跟踪在 git 里的目录（如 Go 的 vendor/）worktree 检出自带，不能共享（会写脏）。
// junction（mklink /J）不需要管理员权限，删除 worktree 只删 reparse 点、不动目标目录。
var junctionWhitelist = []string{"node_modules", ".venv", "venv"}

// isReparsePoint 判断路径是否为 junction / 符号链接。实测（Go 1.27 Windows）：os.Lstat
// 对 junction 不报 ModeSymlink 也不报 dir（mode 显示 ?---------），必须查文件属性里的
// FILE_ATTRIBUTE_REPARSE_POINT 才可靠。ReadDir/WalkDir 同理把 junction 当非目录条目
// （不会下钻，遍历安全）；os.Stat/ReadFile 则正常跟随（AI 经 junction 读写依赖可用）。
func isReparsePoint(path string) bool {
	p16, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return false
	}
	attrs, err := syscall.GetFileAttributes(p16)
	if err != nil {
		return false
	}
	return attrs&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// linkDepDirs 把主根的依赖目录 junction 进 worktree：worktree/<dep> → 主根/<dep>。
// 目标已存在（同名实体或旧 junction）跳过；创建失败记错误但不致命（依赖共享是增益不是前提）。
// 删除侧（WorktreeRemove）先按白名单摘掉 reparse 点再交 git，保证绝不误删主根依赖。
func linkDepDirs(root, wtPath string) (deps []string, depErrors []string) {
	deps = []string{}
	depErrors = []string{}
	for _, dep := range junctionWhitelist {
		src := filepath.Join(root, dep)
		info, err := os.Stat(src)
		if err != nil || !info.IsDir() {
			continue // 主根没有这个依赖目录
		}
		dst := filepath.Join(wtPath, dep)
		if _, err := os.Lstat(dst); err == nil {
			continue // worktree 里已有同名实体（异常情况），不覆盖
		}
		if err := createJunction(dst, src); err != nil {
			depErrors = append(depErrors, dep+": "+err.Error())
			continue
		}
		deps = append(deps, dep)
	}
	return deps, depErrors
}

// createJunction 用 mklink /J 建目录联接（Windows 免管理员权限；gitinfo 本身就是
// Windows 专用 syscall，见 gitinfo.go 的 SysProcAttr）。路径含空格由 exec 引号处理。
func createJunction(link, target string) error {
	cmd := exec.Command("cmd", "/c", "mklink", "/J", link, target)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mklink /J 失败：%v（%s）", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// unlinkDepDirs 按 white 名单把 worktree 里的依赖 junction 摘掉（只删 reparse 点，
// 不动主根目标）。WorktreeRemove 在 git 之前调用，双保险防 git 的递归删除跟进 junction。
func unlinkDepDirs(wtPath string) {
	for _, dep := range junctionWhitelist {
		dst := filepath.Join(wtPath, dep)
		if isReparsePoint(dst) {
			_ = os.Remove(dst) // 摘 junction 本身；失败留给 git 处理（尽力而为）
		}
	}
}

// WorktreeStat 返回 worktree 的改动统计（git diff --stat 文本，供列表与胶囊快速对比
// 多个隔离区的改动量；完整补丁仍走 WorktreeDiff）。baseSha 有效时对比创建基准（全量
// 草稿语义）；为空或非法时对比 HEAD（该 worktree 自己的未提交改动——外部 worktree /
// 会话登记丢失时仍可用）。
func WorktreeStat(root, name, baseSha string) (string, error) {
	root = strings.TrimSpace(root)
	path, err := worktreePathOf(root, strings.TrimSpace(name))
	if err != nil {
		return "", err
	}
	base := "HEAD"
	baseSha = strings.TrimSpace(baseSha)
	if shaRe.MatchString(baseSha) {
		base = baseSha
	}
	out, code, err := gitRun(path, []string{"diff", "--no-renames", "--stat", base}, 30000)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("git diff --stat 失败（worktree：%s）", name)
	}
	return strings.TrimRight(out, "\n"), nil
}

// deriveSlug 由 label + 会话 id 派生 slug：小写、[^a-z0-9-] 折成 -、截断 32，拼会话 id
// 末 8 位字母数字（会话 id 形如 session-<base36 时间戳><5 位随机>，取尾部才是高熵段）；
// label 清洗后为空用 "wt"。纯函数，可单测。
func deriveSlug(label, sessionKey string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(label)) {
		// 按 rune 判断（不能截成 byte：CJK 码点低字节可能恰好落在 a-z，如「器」U+5668）
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
		} else if b.Len() > 0 && !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
		if b.Len() >= 32 {
			break
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "wt"
	}
	if id := alnumTail(sessionKey, 8); id != "" {
		return base + "-" + id
	}
	return base
}

// alnumTail 取 s 小写后末 n 个字母数字字符（会话 id 的随机尾段）。
func alnumTail(s string, n int) string {
	var kept []rune
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			kept = append(kept, r)
		}
	}
	if len(kept) > n {
		kept = kept[len(kept)-n:]
	}
	return string(kept)
}

// worktreePathOf 校验 name 并返回 worktree 绝对路径；name 白名单 + 相对路径双保险防穿越。
func worktreePathOf(root, name string) (string, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if !worktreeSlugRe.MatchString(name) {
		return "", fmt.Errorf("非法 worktree 名称：%s", name)
	}
	path := filepath.Join(root, filepath.FromSlash(worktreeDirName), name)
	rel, err := filepath.Rel(root, path)
	if err != nil || filepath.ToSlash(rel) != worktreeDirName+"/"+name {
		return "", fmt.Errorf("worktree 路径越界：%s", name)
	}
	return path, nil
}

// worktreeRepoReady 确认 root 在 git 仓库内（worktree 能力前提）。
func worktreeRepoReady(root string) bool {
	out, code, err := gitRun(root, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	return err == nil && code == 0 && strings.TrimSpace(out) == "true"
}

// WorktreeList 解析 git worktree list --porcelain：主根、bare、detached 一并列出，
// 由 UnderCadt 区分 AI 隔离区。孤儿判定（不在任何会话登记里）由前端算，引擎保持纯净。
func WorktreeList(dir string) (*GitWorktreeListResult, error) {
	result := &GitWorktreeListResult{Items: []GitWorktreeInfo{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		result.Reason = "没有打开的目录"
		return result, nil
	}
	if !worktreeRepoReady(dir) {
		result.Reason = "不在 git 仓库内"
		return result, nil
	}
	result.Available = true
	result.Root = dir
	raw, code, err := gitRun(dir, []string{"worktree", "list", "--porcelain"}, 10000)
	if err != nil || code != 0 {
		if err == nil {
			result.Reason = "git worktree list 失败"
		} else {
			result.Reason = "未安装 git"
		}
		result.Available = false
		return result, nil
	}
	result.Items = parseWorktreePorcelain(raw, dir)
	return result, nil
}

// parseWorktreePorcelain 按 NUL 分段：worktree <path> / HEAD <sha> / branch <ref> / bare / detached。
func parseWorktreePorcelain(raw, root string) []GitWorktreeInfo {
	items := []GitWorktreeInfo{}
	for _, block := range strings.Split(raw, "\n\n") {
		var info GitWorktreeInfo
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimRight(line, "\r")
			switch {
			case strings.HasPrefix(line, "worktree "):
				info.Path = strings.TrimSpace(strings.TrimPrefix(line, "worktree "))
			case strings.HasPrefix(line, "HEAD "):
				info.Head = strings.TrimSpace(strings.TrimPrefix(line, "HEAD "))
			case strings.HasPrefix(line, "branch "):
				info.Branch = strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(line, "branch ")), "refs/heads/")
			case strings.TrimSpace(line) == "bare":
				info.Bare = true
			case strings.TrimSpace(line) == "detached":
				info.Detached = true
			}
		}
		if info.Path == "" {
			continue
		}
		info.Path = filepath.Clean(info.Path)
		if rel, err := filepath.Rel(root, info.Path); err == nil {
			info.RelPath = filepath.ToSlash(rel)
		} else {
			info.RelPath = filepath.ToSlash(info.Path)
		}
		info.UnderCadt = info.RelPath == worktreeDirName || strings.HasPrefix(info.RelPath, worktreeDirName+"/")
		items = append(items, info)
	}
	return items
}

// WorktreeAdd 创建隔离 worktree：git worktree add -b cadt/wt/<slug> <主根>/.cadt/worktree/<slug>。
// 候选 slug 依次试 base / base-2 / base-3（路径或分支任一已存在即换下一个），全部冲突报错。
func WorktreeAdd(root, label, sessionKey string) (*GitWorktreeAddResult, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, fmt.Errorf("缺少目录")
	}
	if !worktreeRepoReady(root) {
		return nil, fmt.Errorf("不在 git 仓库内，无法创建隔离工作区")
	}
	base := deriveSlug(label, sessionKey)
	candidates := []string{base, base + "-2", base + "-3"}
	for _, slug := range candidates {
		if !worktreeSlugRe.MatchString(slug) {
			continue
		}
		path := filepath.Join(root, filepath.FromSlash(worktreeDirName), slug)
		if _, err := os.Stat(path); err == nil {
			continue // 目录已存在
		}
		branch := worktreeBranchP + slug
		if gitBranchRefExists(root, "refs/heads/"+branch) {
			continue // 分支残留（worktree 已删但分支没删干净）
		}
		if _, code, err := gitRun(root, []string{"worktree", "add", "-b", branch, "--", path}, 120000); err != nil {
			return nil, err
		} else if code != 0 {
			return nil, fmt.Errorf("创建 worktree 失败（%s）", slug)
		}
		shaOut, shaCode, shaErr := gitRun(path, []string{"rev-parse", "HEAD"}, 5000)
		if shaErr != nil || shaCode != 0 {
			return nil, fmt.Errorf("worktree 已创建但取基准 HEAD 失败：%s", path)
		}
		// 依赖目录 junction 共享（白名单内存在才建；失败不致命，记进结果告知 AI）
		deps, depErrors := linkDepDirs(root, path)
		return &GitWorktreeAddResult{
			Name:      slug,
			Branch:    branch,
			Path:      path,
			BaseSha:   strings.TrimSpace(shaOut),
			Deps:      deps,
			DepErrors: depErrors,
		}, nil
	}
	return nil, fmt.Errorf("worktree 名称冲突过多（%s…），请换一个用途名", base)
}

// WorktreeRemove 删除隔离 worktree（--force：草稿区本来就该允许未提交改动）；
// deleteBranch=true 时一并删隔离分支（默认语义：分支永不合并、不保留）。
// 先摘掉依赖 junction（只删 reparse 点，主根依赖绝不受影响），再交 git 删目录。
func WorktreeRemove(root, name string, deleteBranch bool) error {
	root = strings.TrimSpace(root)
	path, err := worktreePathOf(root, name)
	if err != nil {
		return err
	}
	unlinkDepDirs(path)
	if _, code, err := gitRun(root, []string{"worktree", "remove", "--force", "--", path}, 30000); err != nil {
		return err
	} else if code != 0 {
		return fmt.Errorf("删除 worktree 失败：%s", name)
	}
	if deleteBranch {
		branch := worktreeBranchP + strings.ToLower(strings.TrimSpace(name))
		if gitBranchRefExists(root, "refs/heads/"+branch) {
			if _, code, err := gitRun(root, []string{"branch", "-D", branch}, 15000); err != nil {
				return err
			} else if code != 0 {
				return fmt.Errorf("worktree 已删除但分支删除失败：%s", branch)
			}
		}
	}
	return nil
}

// WorktreePrune 清理 git 侧失效的 worktree 管理记录（目录被手动删除等）；不动现存目录。
func WorktreePrune(root string) error {
	root = strings.TrimSpace(root)
	if root == "" {
		return fmt.Errorf("缺少目录")
	}
	if _, code, err := gitRun(root, []string{"worktree", "prune"}, 15000); err != nil {
		return err
	} else if code != 0 {
		return fmt.Errorf("worktree prune 失败")
	}
	return nil
}

// WorktreeDiff 导出 worktree 相对创建基准的全部草稿改动（unified patch 文本）：
// 先 git add -N .（intent-to-add，让未跟踪新文件进 diff，不暂存内容），再
// git diff --no-renames <baseSha>（rename 拆成 delete+add，回避补丁解析器的 rename 盲区）。
// 删除文件也在 diff 里；忽略文件（构建产物等）不会出现。baseSha 由调用方传会话里记录的
// 创建基准（40 位或缩写十六进制）。
func WorktreeDiff(root, name, baseSha string) (string, error) {
	root = strings.TrimSpace(root)
	baseSha = strings.TrimSpace(baseSha)
	if !shaRe.MatchString(baseSha) {
		return "", fmt.Errorf("缺少有效的基准 commit（baseSha）")
	}
	path, err := worktreePathOf(root, name)
	if err != nil {
		return "", err
	}
	if info, statErr := os.Stat(path); statErr != nil || !info.IsDir() {
		return "", fmt.Errorf("worktree 目录不存在：%s", path)
	}
	if _, code, err := gitRun(path, []string{"add", "-N", "."}, 30000); err != nil {
		return "", err
	} else if code != 0 {
		return "", fmt.Errorf("git add -N 失败（worktree：%s）", name)
	}
	out, code, err := gitRun(path, []string{"diff", "--no-renames", baseSha}, 60000)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("git diff 失败（worktree：%s）", name)
	}
	diff := strings.TrimRight(out, "\n")
	if strings.TrimSpace(diff) == "" {
		return "", ErrWorktreeNoChanges
	}
	return diff, nil
}
