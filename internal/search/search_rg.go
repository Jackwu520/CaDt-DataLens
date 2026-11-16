package search

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/executil"
)

type rgMessage struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
			End   int `json:"end"`
		} `json:"submatches"`
	} `json:"data"`
}

func rgGlobalArgs(query string, caseSensitive bool, pattern string, artifactOnly bool) []string {
	args := []string{
		"--json", "--no-config", "--no-messages", "--color", "never",
		"--max-filesize", "4M",
		"--max-count", strconv.Itoa(searchMaxPerFile),
		"--hidden",
		// Windows 上 rg 的路径是反斜杠，目录排除用组件名匹配才可靠
		"--glob", "!.git", "--glob", "!.svn", "--glob", "!.hg",
		"--glob", "!.idea", "--glob", "!.vscode",
		"--glob", "!node_modules", "--glob", "!__pycache__",
		"--glob", "!.pytest_cache", "--glob", "!.mypy_cache",
		"--glob", "!.gradle", "--glob", "!.cache",
		// AI 隔离 worktree：目录与子树双保险（尽力剪枝；Windows 上路径型 glob 不可靠，
		// runRgPass 里另有 skipRgHit 按 SkipPath 二次过滤保底）。口径与 search.go 的
		// SkipPath 一致（含 .cadt/tmp 不受影响）。
		"--glob", "!.cadt/worktree", "--glob", "!.cadt/worktree/**",
		"-F",
	}
	if !caseSensitive {
		args = append(args, "-i")
	}
	// 文件名/路径通配下推给 rg（-g 的语义与 globMatchPath 基本一致：含 / 按路径、否则按文件名）
	if pattern = strings.TrimSpace(pattern); pattern != "" {
		args = append(args, "--glob", pattern)
	}
	// 产物档拆两趟：源码趟按组件名排除产物目录/后缀，产物趟用 `**/` 前缀包含任意层级。
	// 表与 search.go 的 searchArtifactDirs / searchArtifactSuffixes 单一来源，改表即两边同步。
	for _, dir := range searchArtifactDirs {
		if artifactOnly {
			args = append(args, "--glob", "**/"+dir+"/**")
		} else {
			args = append(args, "--glob", "!"+dir)
		}
	}
	for _, suffix := range searchArtifactSuffixes {
		if artifactOnly {
			args = append(args, "--glob", "**/*"+suffix)
		} else {
			args = append(args, "--glob", "!*"+suffix)
		}
	}
	return append(args, "--", query)
}

type rgPass struct {
	hits      []SearchHit
	files     map[string]bool
	truncated bool
	usable    bool
}

// skipRgHit 过滤 rg 命中路径里的 AI 隔离 worktree 副本。rg 的路径型 glob 在 Windows 上
// 不可靠（路径分隔符语义随版本差异，见 rgGlobalArgs 注释），glob 只是尽力剪枝，
// 这里按 SkipPath 二次过滤保底。结果按 path 缓存（同一文件多命中只算一次）。
func skipRgHit(root, path string, cache map[string]bool) bool {
	if cached, ok := cache[path]; ok {
		return cached
	}
	rel := path
	if r, relErr := filepath.Rel(root, path); relErr == nil {
		rel = r
	}
	skip := SkipPath(rel)
	cache[path] = skip
	return skip
}

// runRgPass 跑一趟 rg 并把命中收齐。artifactOnly 时只收产物档命中——glob 已做包含，
// Go 侧再按分类器过滤一次，避免用户 filePattern 与包含 glob 取并集时混进源码命中。
func runRgPass(rgPath, root, query string, caseSensitive bool, pattern string, artifactOnly bool, hitCap int, deadline time.Time) rgPass {
	pass := rgPass{files: map[string]bool{}}
	worktreeCache := map[string]bool{}
	remaining := time.Until(deadline)
	if remaining <= 0 || hitCap <= 0 {
		pass.truncated = true
		return pass
	}
	ctx, cancel := context.WithTimeout(context.Background(), remaining)
	defer cancel()
	args := append(rgGlobalArgs(query, caseSensitive, pattern, artifactOnly), root)
	cmd := exec.CommandContext(ctx, rgPath, args...)
	executil.HideCommandWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return pass
	}
	if err := cmd.Start(); err != nil {
		return pass
	}
	hitsPerFile := map[string]int{}
	tierCache := map[string]bool{}
	capped := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
loop:
	for scanner.Scan() {
		var msg rgMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.Type != "match" {
			continue
		}
		path := msg.Data.Path.Text
		if skipRgHit(root, path, worktreeCache) {
			continue
		}
		if artifactOnly {
			isArtifact, cached := tierCache[path]
			if !cached {
				rel := path
				if r, relErr := filepath.Rel(root, path); relErr == nil {
					rel = r
				}
				isArtifact = searchIsArtifactPath(rel)
				tierCache[path] = isArtifact
			}
			if !isArtifact {
				continue
			}
		}
		name := filepath.Base(path)
		line := strings.TrimRight(msg.Data.Lines.Text, "\r\n")
		relDir := filepath.Dir(path)
		if rel, err := filepath.Rel(root, relDir); err == nil {
			relDir = rel
		}
		if relDir == "." || relDir == "" {
			relDir = filepath.Base(root)
		}
		for _, sub := range msg.Data.Submatches {
			if sub.Start < 0 || sub.End > len(line) || sub.Start >= sub.End {
				continue
			}
			if hitsPerFile[path] >= searchMaxPerFile {
				continue
			}
			if len(pass.hits) >= hitCap {
				pass.truncated = true
				capped = true
				break loop
			}
			preview, matchStart, matchEnd := buildSearchPreview(line, sub.Start, sub.End-sub.Start)
			pass.hits = append(pass.hits, SearchHit{
				Path:       path,
				Name:       name,
				Dir:        relDir,
				Line:       msg.Data.LineNumber,
				Column:     utf16Len(line[:sub.Start]) + 1,
				Length:     utf16Len(line[sub.Start:sub.End]),
				Preview:    preview,
				MatchStart: matchStart,
				MatchEnd:   matchEnd,
			})
			hitsPerFile[path]++
			pass.files[path] = true
		}
	}
	if capped {
		// 命中已截断，不再需要 rg 输出；立即结束进程，避免管道写满后 Wait 拖到 deadline
		cancel()
	}
	waitErr := cmd.Wait()
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	if timedOut {
		pass.truncated = true
	}
	if waitErr != nil && !timedOut {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1 {
			pass.usable = true
			return pass
		}
		if len(pass.hits) == 0 {
			return pass
		}
	}
	if scanErr := scanner.Err(); scanErr != nil && len(pass.hits) == 0 && !timedOut {
		return pass
	}
	pass.usable = true
	return pass
}

// searchWithRipgrep 用用户自带的 rg 做搜索；第二个返回值表示是否可用，
// 不可用（未安装/无法启动/歧义失败）时应退回内置扫描。
// 两趟扫描：先源码档，结果没占满预算再补产物档，两档各自排序后拼接。
func searchWithRipgrep(root, query string, caseSensitive bool, maxResults int, pattern string) (*SearchResult, bool) {
	rgPath, err := exec.LookPath("rg")
	if err != nil {
		return nil, false
	}
	deadline := time.Now().Add(searchBudget)
	src := runRgPass(rgPath, root, query, caseSensitive, pattern, false, maxResults, deadline)
	if !src.usable {
		return nil, false
	}
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(query)
	}
	sortSearchTier(src.hits, needle, caseSensitive)
	result := &SearchResult{
		Hits:      src.hits,
		Files:     len(src.files),
		Truncated: src.truncated,
	}
	if len(result.Hits) < maxResults {
		art := runRgPass(rgPath, root, query, caseSensitive, pattern, true, maxResults-len(result.Hits), deadline)
		if art.usable {
			sortSearchTier(art.hits, needle, caseSensitive)
			result.Hits = append(result.Hits, art.hits...)
			result.Files += len(art.files)
			result.Truncated = result.Truncated || art.truncated
		} else if len(result.Hits) == 0 && !src.truncated {
			// 两趟都没拿到 rg 结果且不是超时——退回内置扫描重来一次
			return nil, false
		}
	} else {
		// 源码档已吃满上限，产物档不再扫描（rg 侧不枚举被排除的目录，是否有产物命中无从得知）
		result.ArtifactSkipped = true
	}
	if len(result.Hits) >= maxResults {
		result.Truncated = true
	}
	return result, true
}
