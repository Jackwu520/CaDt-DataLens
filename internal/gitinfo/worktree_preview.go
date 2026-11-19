// worktree_preview.go：export 零副作用三方合并预检（方案 docs/unfinished-plans/worktree-export-improvement.md）。
// carry=true 的 baseSha 快照 commit 就是现成 merge-base：
//
//	base   = wt.baseSha（创建隔离区时的快照 commit，或主根 HEAD）
//	ours   = 主根当前工作区快照（GIT_INDEX_FILE 临时 index + add -A + write-tree/commit-tree）
//	theirs = 隔离区当前工作区快照（同法）
//
// 快照是纯 plumbing：不碰真 index（git stash 内部同做法，add -A 直接跑会毁掉用户暂存区）、
// 不碰 HEAD、不建分支，只往共享对象库写 tree/commit 对象。路径排除 .cadt/（产物/日志/
// 隔离区本体，永不进快照）与 reparse 点（junction 会把主根依赖内容整个索引进去，复查实测）。
// 三栏分类（全集 = theirs 相对 base 的改动文件）：
//
//	已应用 = ours 与 theirs 内容一致（主根已包含该改动，无需重做）
//	真冲突 = merge-tree --write-tree 的 Conflicted file info
//	可应用 = 其余
//
// 全量报告落盘 <主根>/.cadt/export-reports/（必须主根侧：隔离区随 discard 删除）。
// 版本门槛：merge-tree --write-tree 需 git ≥2.38，低版本返回 Supported=false 交前端降级。
package gitinfo

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"datalens/internal/executil"
)

// GitMergeConflictFile merge-tree 判定的冲突文件；Reasons 从 informational messages
// 里提取命中的 CONFLICT 行（如 CONFLICT (content) / CONFLICT (modify/delete)）。
type GitMergeConflictFile struct {
	Path    string   `json:"path"`
	Reasons []string `json:"reasons,omitempty"`
}

// ConflictedPaths 冲突文件路径列表（集合判定与测试的便利方法）。
func (r *GitWorktreeMergePreviewResult) ConflictedPaths() []string {
	out := make([]string, 0, len(r.Conflicted))
	for _, f := range r.Conflicted {
		out = append(out, f.Path)
	}
	return out
}

// GitWorktreeMergePreviewResult Supported=false 时 Reason 说明原因，其余字段无效——
// 前端据此降级走 PatchPreviewText/PatchSave 兜底链路。
type GitWorktreeMergePreviewResult struct {
	Supported      bool                   `json:"supported"`
	Reason         string                 `json:"reason,omitempty"`
	Clean          bool                   `json:"clean"` // merge-tree exit 0（无冲突）
	Applicable     []string               `json:"applicable"`
	AlreadyApplied []string               `json:"alreadyApplied"`
	Conflicted     []GitMergeConflictFile `json:"conflicted"`
	Messages       []string               `json:"messages,omitempty"` // merge-tree 自由文本段（Auto-merging / CONFLICT 行）
	TreeSha        string                 `json:"treeSha,omitempty"`  // merge-tree 产出的合并结果 tree（诊断用，不落工作区）
	ReportPath     string                 `json:"reportPath,omitempty"`
	ReportErr      string                 `json:"reportErr,omitempty"`
}

// mergeTreeMinMinor：merge-tree --write-tree 落地于 git 2.38.0。
const mergeTreeMinMajor, mergeTreeMinMinor = 2, 38

// conflictEntryRe：Conflicted file info 行——"<mode> <oid> <stage>\t<path>"（无 -z 时 LF 分隔）。
var conflictEntryRe = regexp.MustCompile(`^[0-7]{6} [0-9a-f]{40} [1-3]\t(.*)$`)

// unquoteGitPath core.quotePath 开启（默认）时非 ASCII 文件名会被 C-quoted（"a/\346\226\207.md"）。
// 简单反解：去引号 + \NNN 八进制 / \\ \" 等常见转义；解不动就原样返回（只影响报告显示）。
func unquoteGitPath(p string) string {
	if len(p) < 2 || p[0] != '"' || p[len(p)-1] != '"' {
		return p
	}
	body := p[1 : len(p)-1]
	var b strings.Builder
	for i := 0; i < len(body); i++ {
		c := body[i]
		if c != '\\' || i+1 >= len(body) {
			b.WriteByte(c)
			continue
		}
		i++
		switch body[i] {
		case '\\', '"':
			b.WriteByte(body[i])
		case 't':
			b.WriteByte('\t')
		case 'n':
			b.WriteByte('\n')
		default:
			// \NNN 八进制（最多 3 位）
			if body[i] >= '0' && body[i] <= '7' && i+2 < len(body) &&
				body[i+1] >= '0' && body[i+1] <= '7' && body[i+2] >= '0' && body[i+2] <= '7' {
				v := int(body[i]-'0')<<6 | int(body[i+1]-'0')<<3 | int(body[i+2]-'0')
				b.WriteByte(byte(v))
				i += 2
			} else {
				b.WriteByte('\\')
				b.WriteByte(body[i])
			}
		}
	}
	return b.String()
}

// snapshotHeavyDirs 主根快照时跳过遍历的目录：白名单依赖目录（junction 共享/包管理器生成，
// 几乎必然 gitignore，其内容不进 add -A）与 .git。跳过只为省 reparse 扫描的时间——若这些
// 目录被 git 跟踪，其内部 reparse 点确实会漏，但「跟踪 node_modules」本身是反模式。
var snapshotHeavyDirs = map[string]bool{".git": true, "node_modules": true, ".venv": true, "venv": true}

func reparseRelPathsSkipHeavy(dir string) []string {
	var rels []string
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == dir {
			return nil
		}
		if d.IsDir() && snapshotHeavyDirs[d.Name()] {
			return filepath.SkipDir
		}
		if !isReparsePoint(path) {
			return nil
		}
		if rel, rerr := filepath.Rel(dir, path); rerr == nil {
			rels = append(rels, filepath.ToSlash(rel))
		}
		if d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	return rels
}

// gitRunEnv gitRun 的增强版：extraEnv 追加在 sanitizeGitEnv 之后（GIT_INDEX_FILE 被
// sanitize 剥掉，这里必须补挂回去才有临时 index），stdin 支持 patch-id 这类纯 stdin 管道。
// stderr 拼进错误文本——merge-tree 失败时 gitRun 拿不到 stderr。
func gitRunEnv(dir string, args []string, extraEnv map[string]string, stdin string, timeoutMs int) (string, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	executil.HideCommandWindow(cmd)
	cmd.Env = sanitizeGitEnv(os.Environ())
	for k, v := range extraEnv {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	code := 0
	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			return "", -1, runErr
		}
	}
	if ctx.Err() == context.DeadlineExceeded {
		return "", -1, fmt.Errorf("git 命令超时")
	}
	if code != 0 && strings.TrimSpace(stderr.String()) != "" {
		return stdout.String(), code, fmt.Errorf("git %s 失败：%s", args[0], strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), code, nil
}

// snapshotWorkingTree 把 dir 的当前工作区（含未跟踪文件，排除 .cadt 与 reparse 点）写成一个
// 临时 commit 返回 sha。GIT_INDEX_FILE 指向一次性临时文件：主根用户已 staged 的内容不受影响，
// 也绝不碰 HEAD 与分支。失败时返回错误，调用方降级。
// 注意：不能用 exclude pathspec（`:(exclude).cadt` 这类）——add 对「被 gitignore 的显式路径」
// 直接 fatal（The following paths are ignored），实测确认；改用 add -A 后 `reset -- <路径>`
// 从临时 index 摘除（reset 的 pathspec 匹配不到时静默通过，无此问题）。
func snapshotWorkingTree(dir string, excludes []string) (string, error) {
	tmp, err := os.CreateTemp("", "cadt-snapidx-*")
	if err != nil {
		return "", err
	}
	indexPath := tmp.Name()
	_ = tmp.Close()
	_ = os.Remove(indexPath) // 必须「不存在」：git 不接受零字节文件当 index（smaller than expected）
	env := map[string]string{"GIT_INDEX_FILE": indexPath}
	if _, code, err := gitRunEnv(dir, []string{"add", "-A"}, env, "", 120000); err != nil || code != 0 {
		if err != nil {
			return "", fmt.Errorf("快照 add 失败：%w", err)
		}
		return "", fmt.Errorf("快照 add 失败（退出码 %d）", code)
	}
	// 摘除不想进快照的路径：.cadt（产物/日志/隔离区本体）+ reparse 点（junction 会把
	// 主根依赖内容整个索引进去，复查实测）。
	resetArgs := append([]string{"reset", "-q", "--", ".cadt"}, excludes...)
	if _, code, err := gitRunEnv(dir, resetArgs, env, "", 60000); err != nil || code != 0 {
		if err != nil {
			return "", fmt.Errorf("快照 reset 失败：%w", err)
		}
		return "", fmt.Errorf("快照 reset 失败（退出码 %d）", code)
	}
	out, code, err := gitRunEnv(dir, []string{"write-tree"}, env, "", 60000)
	if err != nil || code != 0 {
		if err != nil {
			return "", fmt.Errorf("快照 write-tree 失败：%w", err)
		}
		return "", fmt.Errorf("快照 write-tree 失败（退出码 %d）", code)
	}
	tree := strings.TrimSpace(out)
	if !shaRe.MatchString(tree) {
		return "", fmt.Errorf("write-tree 返回非法 sha")
	}
	// commit-tree：merge-tree 需要 commit-ish；对象只进对象库，不建引用。
	cOut, cCode, cErr := gitRunEnv(dir, []string{
		"-c", "user.name=cadt-snapshot", "-c", "user.email=cadt-snapshot@local",
		"commit-tree", tree, "-m", "cadt: working tree snapshot (export preview)",
	}, nil, "", 30000)
	if cErr != nil || cCode != 0 {
		if cErr != nil {
			return "", fmt.Errorf("快照 commit-tree 失败：%w", cErr)
		}
		return "", fmt.Errorf("快照 commit-tree 失败（退出码 %d）", cCode)
	}
	lines := strings.Fields(cOut)
	if len(lines) == 0 || !shaRe.MatchString(lines[0]) {
		return "", fmt.Errorf("commit-tree 返回非法 sha")
	}
	return lines[0], nil
}

// gitVersionAtLeast 解析 `git --version`（"git version 2.51.2.windows.1"）取前两位数字。
func gitVersionAtLeast(major, minor int) bool {
	out, code, err := gitRunEnv("", []string{"--version"}, nil, "", 10000)
	if err != nil || code != 0 {
		return false
	}
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) < 3 {
		return false
	}
	num := fields[2]
	dot := strings.IndexByte(num, '.')
	if dot <= 0 {
		return false
	}
	gMajor, err1 := strconv.Atoi(num[:dot])
	rest := num[dot+1:]
	dot2 := strings.IndexByte(rest, '.')
	if dot2 < 0 {
		dot2 = len(rest)
	}
	gMinor, err2 := strconv.Atoi(rest[:dot2])
	if err1 != nil || err2 != nil {
		return false
	}
	return gMajor > major || (gMajor == major && gMinor >= minor)
}

// parseMergeTreeOutput 解析 merge-tree --write-tree（无 -z）输出：
// 首行 tree OID；有冲突时依次为空行 + Conflicted file info + 空行 + 自由文本 messages。
func parseMergeTreeOutput(out string) (treeSha string, conflicted []string, messages []string, err error) {
	trimmed := strings.TrimRight(out, "\n")
	if trimmed == "" {
		return "", nil, nil, fmt.Errorf("merge-tree 输出为空")
	}
	lines := strings.Split(trimmed, "\n")
	treeSha = strings.TrimSpace(lines[0])
	if !shaRe.MatchString(treeSha) {
		return "", nil, nil, fmt.Errorf("merge-tree 输出首行不是 tree sha")
	}
	conflicted = []string{}
	messages = []string{}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if m := conflictEntryRe.FindStringSubmatch(line); m != nil {
			conflicted = append(conflicted, unquoteGitPath(m[1]))
			continue
		}
		messages = append(messages, line)
	}
	return treeSha, conflicted, messages, nil
}

// conflictReasons 从 messages 里挑出提及该文件的 CONFLICT 行（每个文件一条主因即可）。
func conflictReasons(path string, messages []string) []string {
	var reasons []string
	for _, line := range messages {
		if strings.Contains(line, path) && strings.Contains(line, "CONFLICT") {
			reasons = append(reasons, strings.TrimSpace(line))
		}
	}
	return reasons
}

// dedupeSorted 去重排序（diff -z 输出天然无重复，防御性处理）。
func dedupeSorted(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

func listDiffZ(root, from, to string) ([]string, error) {
	// --no-renames：export 的 diff 就是这个口径（git diff.renames 默认开，会让 rename
	// 场景下两次 diff 的路径集合口径不一致，rename 呈现为 delete+add 才可比）
	out, code, err := gitRun(root, []string{"diff", "--name-only", "--no-renames", "-z", from, to}, 120000)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("git diff --name-only 失败（退出码 %d）", code)
	}
	var items []string
	for _, rel := range strings.Split(out, "\x00") {
		rel = strings.TrimSpace(rel)
		if rel != "" {
			items = append(items, rel)
		}
	}
	return items, nil
}

// mergeCoreResult 预检（L1）与应用（L2）共用的三方合并产物：快照 → merge-tree → 集合分类。
// 两个入口永远跑同一引擎同一实现，报告与实际应用不会分叉（方案 L1/L2 一致性要求）。
type mergeCoreResult struct {
	oursSha, theirsSha, treeSha string
	changedSet                  map[string]bool // theirs 相对 base 的改动全集
	differSet                   map[string]bool // ours 与 theirs 有差异（不在其中 = 已应用）
	conflictedSet               map[string]bool
	conflictedPaths             []string
	applicable                  []string
	alreadyApplied              []string
	conflictedFiles             []GitMergeConflictFile
	messages                    []string
}

// runMergeCore 执行三方合并并分类。任何一步失败返回用户可读原因：预检转 Supported=false
// 降级，应用转 Supported=false 报错；由调用方决定降级姿势。
func runMergeCore(root, wtPath, baseSha string) (*mergeCoreResult, error) {
	if !gitVersionAtLeast(mergeTreeMinMajor, mergeTreeMinMinor) {
		return nil, errors.New("git 版本过低（需要 ≥2.38 的 merge-tree --write-tree）")
	}
	if !worktreeRepoReady(root) {
		return nil, errors.New("主根不在 git 仓库内")
	}
	oursSha, err := snapshotWorkingTree(root, reparseRelPathsSkipHeavy(root))
	if err != nil {
		return nil, fmt.Errorf("主根工作区快照失败：%w", err)
	}
	theirsSha, err := snapshotWorkingTree(wtPath, reparseRelPaths(wtPath))
	if err != nil {
		return nil, fmt.Errorf("隔离区工作区快照失败：%w", err)
	}
	// 全集：theirs 相对 base 的改动文件
	changed, err := listDiffZ(root, baseSha, theirsSha)
	if err != nil {
		return nil, fmt.Errorf("diff 全集失败：%w", err)
	}
	// ours 与 theirs 的差异集：不在其中 = 主根已包含该改动 = 已应用
	differ, err := listDiffZ(root, oursSha, theirsSha)
	if err != nil {
		return nil, fmt.Errorf("diff ours/theirs 失败：%w", err)
	}
	mOut, mCode, mErr := gitRunEnv(root, []string{
		"merge-tree", "--write-tree", "--merge-base=" + baseSha, oursSha, theirsSha,
	}, nil, "", 120000)
	if mErr != nil {
		return nil, fmt.Errorf("merge-tree 执行失败：%w", mErr)
	}
	if mCode != 0 && mCode != 1 {
		return nil, fmt.Errorf("merge-tree 退出码 %d（既非成功也非冲突）", mCode)
	}
	treeSha, conflicted, messages, pErr := parseMergeTreeOutput(mOut)
	if pErr != nil {
		return nil, fmt.Errorf("merge-tree 输出解析失败：%w", pErr)
	}
	core := &mergeCoreResult{
		oursSha: oursSha, theirsSha: theirsSha, treeSha: treeSha,
		changedSet: map[string]bool{}, differSet: map[string]bool{}, conflictedSet: map[string]bool{},
		messages:        messages,
		applicable:      []string{},
		alreadyApplied:  []string{},
		conflictedFiles: []GitMergeConflictFile{},
	}
	for _, p := range dedupeSorted(differ) {
		core.differSet[p] = true
	}
	core.conflictedPaths = dedupeSorted(conflicted)
	for _, p := range core.conflictedPaths {
		core.conflictedSet[p] = true
		core.conflictedFiles = append(core.conflictedFiles, GitMergeConflictFile{Path: p, Reasons: conflictReasons(p, messages)})
	}
	for _, p := range dedupeSorted(changed) {
		core.changedSet[p] = true
		if core.conflictedSet[p] {
			continue
		}
		if core.differSet[p] {
			core.applicable = append(core.applicable, p)
		} else {
			core.alreadyApplied = append(core.alreadyApplied, p)
		}
	}
	return core, nil
}

// WorktreeMergePreview export 的零副作用预检：三方合并分类 + 全量报告落盘。
// 不写主根任何工作区文件、不碰任何真 index/HEAD/分支；只在共享对象库留临时 tree/commit
// 对象（git gc 自然回收）。git <2.38 或快照失败时 Supported=false，前端降级走兜底链路。
func WorktreeMergePreview(root, name, baseSha string) (*GitWorktreeMergePreviewResult, error) {
	root = strings.TrimSpace(root)
	baseSha = strings.TrimSpace(baseSha)
	res := &GitWorktreeMergePreviewResult{
		Applicable: []string{}, AlreadyApplied: []string{}, Conflicted: []GitMergeConflictFile{},
	}
	wtPath, err := worktreePathOf(root, strings.TrimSpace(name))
	if err != nil {
		return nil, err
	}
	if !shaRe.MatchString(baseSha) {
		return nil, fmt.Errorf("baseSha 非法")
	}
	core, cErr := runMergeCore(root, wtPath, baseSha)
	if cErr != nil {
		res.Supported = false
		res.Reason = cErr.Error()
		return res, nil
	}
	res.Supported = true
	res.Clean = len(core.conflictedPaths) == 0
	res.TreeSha = core.treeSha
	res.Messages = core.messages
	res.Conflicted = core.conflictedFiles
	res.Applicable = core.applicable
	res.AlreadyApplied = core.alreadyApplied
	res.ReportPath, res.ReportErr = writeExportReport(root, strings.TrimSpace(name), baseSha, core.oursSha, core.theirsSha, res)
	return res, nil
}

// writeExportReport 全量报告落盘 <主根>/.cadt/export-reports/<name>-<时间戳>.md。
// 每次导出一份、不覆盖（多次 export 可比对「这次和上次差在哪」）；失败不致命（ReportErr 记录）。
func writeExportReport(root, name, baseSha, oursSha, theirsSha string, res *GitWorktreeMergePreviewResult) (string, string) {
	dir := filepath.Join(root, ".cadt", "export-reports")
	var b strings.Builder
	b.WriteString("# worktree export 预检报告\n\n")
	b.WriteString("- 时间：" + time.Now().Format("2006-01-02 15:04:05") + "\n")
	b.WriteString("- 隔离区：.cadt/worktree/" + name + "\n")
	b.WriteString("- 基准（merge-base）：" + baseSha + "\n")
	b.WriteString("- ours 主根快照：" + oursSha + "\n")
	b.WriteString("- theirs 隔离区快照：" + theirsSha + "\n")
	b.WriteString("- merge-tree 结果 tree：" + res.TreeSha + "（" + boolText(res.Clean, "无冲突", "有冲突") + "）\n\n")
	section := func(title string, items []GitMergeConflictFile, reasonKey bool) {
		b.WriteString("## " + title + "（" + strconv.Itoa(len(items)) + "）\n\n")
		for _, f := range items {
			b.WriteString("- `" + f.Path + "`")
			if reasonKey && len(f.Reasons) > 0 {
				b.WriteString("：" + f.Reasons[0])
			}
			b.WriteString("\n")
		}
		if len(items) == 0 {
			b.WriteString("（无）\n")
		}
		b.WriteString("\n")
	}
	section("真冲突（需在隔离区重做）", res.Conflicted, true)
	plain := make([]GitMergeConflictFile, 0, len(res.Applicable))
	for _, p := range res.Applicable {
		plain = append(plain, GitMergeConflictFile{Path: p})
	}
	section("本次可应用", plain, false)
	plain2 := make([]GitMergeConflictFile, 0, len(res.AlreadyApplied))
	for _, p := range res.AlreadyApplied {
		plain2 = append(plain2, GitMergeConflictFile{Path: p})
	}
	section("已应用（主根已包含，无需重做）", plain2, false)
	if len(res.Messages) > 0 {
		b.WriteString("## merge-tree 消息\n\n```\n" + strings.Join(res.Messages, "\n") + "\n```\n")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err.Error()
	}
	path := filepath.Join(dir, "export-report-"+name+"-"+time.Now().Format("20060102-150405")+".md")
	if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
		return "", err.Error()
	}
	return filepath.ToSlash(path), ""
}

func boolText(v bool, yes, no string) string {
	if v {
		return yes
	}
	return no
}

// PatchID `git patch-id --stable`：diff 文本的稳定指纹（stdin 喂入，gitRun 不支持 stdin
// 才走 gitRunEnv）。重复 export 时与会话记录的上次指纹比对，命中即整份已应用。
func PatchID(diffText string) (string, error) {
	if strings.TrimSpace(diffText) == "" {
		return "", nil
	}
	out, code, err := gitRunEnv("", []string{"patch-id", "--stable"}, nil, diffText, 30000)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("git patch-id 退出码 %d", code)
	}
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) == 0 {
		return "", nil
	}
	return fields[0], nil
}

// ===== L2 应用（WorktreeMergeApply）=====
// 实测结论（2026-11-19，方案 L2 实施前验证）：git apply -3 在主根有未暂存改动时直接
// 失败——--3way 隐含 --index，要求「工作区文件与 index 一致」（"f.txt: does not match
// index"），而脏主根正是隔离区回灌的常态场景，该路线不可用。
// 改为 merge-tree 写回：L1 预检与 L2 应用共用 runMergeCore（同一引擎不会分叉），应用 =
// 重新跑一次三方合并（审批有间隔，主根可能又变）→ 把合并 tree 里的文件内容经
// cat-file blob 写回主根工作区。纯 plumbing：不碰真 index、不碰 HEAD/分支，无 unmerged
// stages 残留；真冲突文件不写（内容留在预检报告），交 AI 在隔离区重做。

// GitMergeApplyFile 单文件应用结果；status 取值 applied / skipped / conflict / failed，
// 前两个与 patchResultText 的标签映射兼容（conflict 原样显示便于 AI 识别）。
type GitMergeApplyFile struct {
	RelPath string `json:"relPath"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Added   int    `json:"added,omitempty"`
	Removed int    `json:"removed,omitempty"`
	Deleted bool   `json:"deleted,omitempty"` // 隔离区删除该文件，主根同步删除
}

// GitWorktreeMergeApplyResult 形状对齐 PatchApply 的结果卡契约（mode/applied/skipped/
// added/removed/files/message），前端 result 卡与审批卡结果区零适配渲染。
type GitWorktreeMergeApplyResult struct {
	Supported bool                `json:"supported"`
	Reason    string              `json:"reason,omitempty"`
	Mode      string              `json:"mode"`
	Applied   int                 `json:"applied"`
	Skipped   int                 `json:"skipped"`
	Added     int                 `json:"added"`
	Removed   int                 `json:"removed"`
	TreeSha   string              `json:"treeSha,omitempty"`
	Files     []GitMergeApplyFile `json:"files"`
	Message   string              `json:"message,omitempty"`
}

// numstatBaseTree base→tree 的逐文件行数统计（numstat -z：add\trem\tpath\0；二进制为 "-"）。
func numstatBaseTree(root, base, tree string) map[string][2]int {
	m := map[string][2]int{}
	out, code, err := gitRun(root, []string{"diff", "--numstat", "--no-renames", "-z", base, tree}, 60000)
	if err != nil || code != 0 {
		return m
	}
	for _, rec := range strings.Split(out, "\x00") {
		rec = strings.TrimSpace(rec)
		if rec == "" {
			continue
		}
		parts := strings.Split(rec, "\t")
		if len(parts) < 3 {
			continue
		}
		m[unquoteGitPath(parts[2])] = [2]int{atoiSafe(parts[0]), atoiSafe(parts[1])}
	}
	return m
}

func atoiSafe(s string) int {
	s = strings.TrimSpace(s)
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

func treeBlobExists(root, treeSha, path string) bool {
	_, code, err := gitRun(root, []string{"cat-file", "-e", treeSha + ":" + path}, 10000)
	return err == nil && code == 0
}

// WorktreeMergeApply 把选中的文件按三方合并结果写回主根工作区（S2 应用换轨）。
// paths 来自补丁审批卡的勾选集（相对主根的 slash 路径）；冲突文件不写入，只报 status。
// 重新跑 runMergeCore（不用预检缓存）：审批有间隔，主根可能又变——保证应用瞬间的一致性。
func WorktreeMergeApply(root, name, baseSha string, paths []string) (*GitWorktreeMergeApplyResult, error) {
	root = strings.TrimSpace(root)
	baseSha = strings.TrimSpace(baseSha)
	res := &GitWorktreeMergeApplyResult{Mode: "partial", Files: []GitMergeApplyFile{}}
	wtPath, err := worktreePathOf(root, strings.TrimSpace(name))
	if err != nil {
		return nil, err
	}
	if !shaRe.MatchString(baseSha) {
		return nil, fmt.Errorf("baseSha 非法")
	}
	core, cErr := runMergeCore(root, wtPath, baseSha)
	if cErr != nil {
		res.Supported = false
		res.Reason = cErr.Error()
		return res, nil
	}
	res.Supported = true
	res.TreeSha = core.treeSha
	nums := numstatBaseTree(root, baseSha, core.treeSha)
	conflictCount := 0
	for _, raw := range paths {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		entry := GitMergeApplyFile{RelPath: p}
		if cnt, ok := nums[p]; ok {
			entry.Added, entry.Removed = cnt[0], cnt[1]
			res.Added += cnt[0]
			res.Removed += cnt[1]
		}
		switch {
		case !gitPathInRoot(root, p):
			entry.Status = "failed"
			entry.Reason = "路径越界：" + p
		case !core.changedSet[p]:
			entry.Status = "failed"
			entry.Reason = "不在隔离区改动集（相对基准无差异）"
		case core.conflictedSet[p]:
			conflictCount++
			entry.Status = "conflict"
			if rs := conflictReasons(p, core.messages); len(rs) > 0 {
				entry.Reason = rs[0]
			} else {
				entry.Reason = "三方合并冲突"
			}
		case !core.differSet[p]:
			entry.Status = "skipped"
			entry.Reason = "主根已包含该改动（已应用），无需重做"
			res.Skipped++
		default:
			target := filepath.Join(root, filepath.FromSlash(p))
			if !treeBlobExists(root, core.treeSha, p) {
				// 合并结果里没有 → theirs 删除且 ours 未恢复 → 主根同步删除
				if rmErr := os.Remove(target); rmErr != nil && !os.IsNotExist(rmErr) {
					entry.Status = "failed"
					entry.Reason = "删除失败：" + rmErr.Error()
				} else {
					entry.Status = "applied"
					entry.Deleted = true
					entry.Reason = "隔离区删除该文件，主根同步删除"
					res.Applied++
				}
			} else if content, _, bErr := gitRun(root, []string{"cat-file", "blob", core.treeSha + ":" + p}, 60000); bErr != nil {
				entry.Status = "failed"
				entry.Reason = "读取合并结果失败：" + bErr.Error()
			} else if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
				entry.Status = "failed"
				entry.Reason = "创建目录失败：" + mkErr.Error()
			} else if wErr := os.WriteFile(target, []byte(content), 0o644); wErr != nil {
				entry.Status = "failed"
				entry.Reason = "写入失败：" + wErr.Error()
			} else {
				entry.Status = "applied"
				res.Applied++
			}
		}
		res.Files = append(res.Files, entry)
	}
	if conflictCount > 0 {
		res.Message = strconv.Itoa(conflictCount) + " 个文件三方合并冲突，未写入主根（原因见各文件行与预检报告）——在隔离区重做后重新 export。"
	}
	return res, nil
}

// ===== S3：discard 保底快照 + conflict_detail 按需通道 =====

// WorktreeSnapshotPatch discard 保底快照：把隔离区相对基准的当前 diff 原样落盘
// <主根>/.cadt/patches/worktree-snapshot-<name>-<时间戳>.patch。必须绕开 PatchSave——
// 它对「没有任何文件可应用」会删补丁文件（patch_save.go），保底存档绝不能被删。
// 返回补丁路径；隔离区无改动返回 ErrWorktreeNoChanges。
func WorktreeSnapshotPatch(root, name, baseSha string) (string, error) {
	root = strings.TrimSpace(root)
	name = strings.TrimSpace(name)
	base := strings.TrimSpace(baseSha)
	if !shaRe.MatchString(base) {
		base = "HEAD" // 登记丢失时退化为相对分支 HEAD（worktree 不 commit，两者等价）
	}
	diff, err := WorktreeDiff(root, name, base)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, ".cadt", "patches")
	if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
		return "", mkErr
	}
	path := filepath.Join(dir, "worktree-snapshot-"+name+"-"+time.Now().Format("20060102-150405")+".patch")
	if wErr := os.WriteFile(path, []byte(diff), 0o644); wErr != nil {
		return "", wErr
	}
	return filepath.ToSlash(path), nil
}

// WorktreeDiffSinceBase 主根相对基准的单文件 diff（conflict_detail 用，L3「冲突报告可消费」）：
// `git diff --no-renames <baseSha> -- <path>`（commit→工作区）。maxLines 封顶（≤0 取 200），
// 截断附计数与 read_file 提示——体量护栏：细节按需逐文件取，绝不内联进回执。
func WorktreeDiffSinceBase(root, baseSha, path string, maxLines int) (string, error) {
	root = strings.TrimSpace(root)
	baseSha = strings.TrimSpace(baseSha)
	path = strings.TrimSpace(path)
	if !shaRe.MatchString(baseSha) {
		return "", fmt.Errorf("baseSha 非法")
	}
	if filepath.IsAbs(path) || strings.HasPrefix(path, "/") || strings.HasPrefix(path, "\\") {
		return "", fmt.Errorf("path 必须是相对主根的 slash 路径")
	}
	if !gitPathInRoot(root, path) {
		return "", fmt.Errorf("路径越界：%s", path)
	}
	out, code, err := gitRun(root, []string{"diff", "--no-renames", baseSha, "--", path}, 30000)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("git diff 失败（退出码 %d）", code)
	}
	diff := strings.TrimRight(out, "\n")
	if strings.TrimSpace(diff) == "" {
		return "主根该文件相对基准（" + baseSha + "）无差异。", nil
	}
	if maxLines <= 0 {
		maxLines = 200
	}
	lines := strings.Split(diff, "\n")
	if len(lines) <= maxLines {
		return diff, nil
	}
	return strings.Join(lines[:maxLines], "\n") + "\n…（已截断，全文件共 " + strconv.Itoa(len(lines)) + " 行；要看完整内容用 read_file 读文件本身）", nil
}
