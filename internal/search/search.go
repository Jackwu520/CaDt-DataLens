package search

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// Searcher 工作区检索与 glob 引擎（无状态）。
type Searcher struct{}

const (
	searchMaxFileSize   = 4 << 20
	searchMaxLineBytes  = 1 << 20
	searchMaxResults    = 400
	searchMaxPerFile    = 30
	searchBudget        = 3500 * time.Millisecond
	searchPreviewBefore = 60
	searchPreviewAfter  = 140
)

var searchSkipDirs = map[string]bool{
	".git": true, ".svn": true, ".hg": true,
	".idea": true, ".vscode": true,
	"node_modules": true, "__pycache__": true,
	".pytest_cache": true, ".mypy_cache": true,
	".gradle": true, ".cache": true,
}

var searchBinaryExt = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".jfif": true, ".gif": true,
	".bmp": true, ".ico": true, ".webp": true, ".tif": true, ".tiff": true,
	".psd": true, ".avif": true, ".heic": true, ".raw": true,
	".pdf": true, ".zip": true, ".7z": true, ".rar": true, ".gz": true,
	".tar": true, ".bz2": true, ".xz": true, ".exe": true, ".dll": true,
	".so": true, ".dylib": true, ".bin": true, ".pyc": true, ".pyo": true,
	".class": true, ".jar": true, ".war": true, ".mp3": true, ".mp4": true,
	".wav": true, ".ogg": true, ".flac": true, ".woff": true, ".woff2": true,
	".ttf": true, ".otf": true, ".eot": true, ".sqlite": true, ".db": true,
	".wgt": true, ".pak": true, ".zipx": true,
}

// SkipDir 判断目录名是否属于检索与目录树共同忽略的目录（大小写不敏感）。
func SkipDir(name string) bool { return searchSkipDirs[strings.ToLower(name)] }

// worktreeSkipPrefix AI 隔离 worktree 的固定父目录（相对主根，正斜杠）。检出副本不进检索
// 与目录树——否则搜一个函数名会命中主根与副本两份；.cadt 其余子目录（含 .cadt/tmp）不受影响。
const worktreeSkipPrefix = ".cadt/worktree"

// SkipPath 按相对路径（相对检索/遍历根，正斜杠）判断是否整棵跳过。rg 路径的排除 glob
// 在 search_rg.go 与本函数口径一致（改这里即两边同步）。根自身（rel 为空或 "."）永不命中
// ——从 worktree 内发起的检索照常工作。
func SkipPath(rel string) bool {
	rel = strings.ToLower(strings.Trim(strings.ReplaceAll(rel, "\\", "/"), "/"))
	if rel == "" || rel == "." {
		return false
	}
	return rel == worktreeSkipPrefix || strings.HasPrefix(rel, worktreeSkipPrefix+"/")
}

// searchArtifactDirs / searchArtifactSuffixes 定义「产物档」：构建输出与依赖目录。
// 命中只降权不排除——工作区本身可能就是一份构建站，产物也必须搜得到，只是排在源码之后。
// 两张表同时驱动 rg 的排除/包含 glob（见 search_rg.go），改这里即两边同步。
var searchArtifactDirs = []string{
	"dist", "build", "out", "target", "bin", "obj",
	"vendor", "coverage", "bower_components",
	".next", ".nuxt", ".output", ".svelte-kit", ".turbo",
}

var searchArtifactSuffixes = []string{".min.js", ".min.css", ".map"}

// searchIsArtifactPath 按路径段/后缀判断是否产物档。O(len(rel))，遍历时每个文件只算一次。
func searchIsArtifactPath(rel string) bool {
	low := strings.ToLower(rel)
	base := low
	if i := strings.LastIndexAny(low, `/\`); i >= 0 {
		base = low[i+1:]
	}
	for _, suffix := range searchArtifactSuffixes {
		if strings.HasSuffix(base, suffix) {
			return true
		}
	}
	rest := low
	for rest != "" {
		i := strings.IndexAny(rest, `/\`)
		seg := rest
		if i >= 0 {
			seg = rest[:i]
			rest = rest[i+1:]
		} else {
			rest = ""
		}
		for _, dir := range searchArtifactDirs {
			if seg == dir {
				return true
			}
		}
	}
	return false
}

// searchNameHit 判断查询词是否出现在文件名里（比仅内容命中更强的信号）。
// needle 需由调用方预小写（大小写不敏感时）。
func searchNameHit(name, needle string, caseSensitive bool) bool {
	if needle == "" {
		return false
	}
	if caseSensitive {
		return strings.Contains(name, needle)
	}
	return strings.Contains(strings.ToLower(name), needle)
}

// sortSearchTier 档内排序：文件名命中优先，其后路径/行/列升序。
// 模糊模式下文件名命中按子序列判断，并追加一档：字面（连续）命中排在
// 子序列（离散）命中之前。命中数受 maxResults 约束（≤ 千级），排序开销可忽略。
func sortSearchTier(hits []SearchHit, needle string, caseSensitive, fuzzy bool) {
	if len(hits) < 2 {
		return
	}
	nameHit := make(map[string]bool, 8)
	for _, h := range hits {
		if _, ok := nameHit[h.Path]; !ok {
			if fuzzy {
				nameHit[h.Path] = fuzzySubsequence(h.Name, needle, caseSensitive)
			} else {
				nameHit[h.Path] = searchNameHit(h.Name, needle, caseSensitive)
			}
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		a, b := hits[i], hits[j]
		if an, bn := nameHit[a.Path], nameHit[b.Path]; an != bn {
			return an
		}
		if a.fuzzySplit != b.fuzzySplit {
			return !a.fuzzySplit
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Column < b.Column
	})
}

type SearchHit struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Dir        string `json:"dir"`
	Line       int    `json:"line"`
	Column     int    `json:"column"`
	Length     int    `json:"length"`
	Preview    string `json:"preview"`
	MatchStart int    `json:"matchStart"`
	MatchEnd   int    `json:"matchEnd"`
	// fuzzySplit 标记子序列（离散）命中，仅用于排序分档，不进 JSON。
	fuzzySplit bool
}

type SearchResult struct {
	Hits      []SearchHit `json:"hits"`
	Truncated bool        `json:"truncated"`
	Files     int         `json:"files"`
	// ArtifactSkipped 表示源码档已吃满结果上限、产物档根本没去扫（仅当被上限截住时为 true）。
	ArtifactSkipped bool `json:"artifactSkipped,omitempty"`
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func buildSearchPreview(line string, byteIdx, byteLen int) (string, int, int) {
	if byteIdx < 0 {
		byteIdx = 0
	}
	if byteIdx > len(line) {
		byteIdx = len(line)
	}
	if byteIdx+byteLen > len(line) {
		byteLen = len(line) - byteIdx
	}
	startByte := byteIdx
	for n := 0; n < searchPreviewBefore && startByte > 0; n++ {
		_, size := utf8.DecodeLastRuneInString(line[:startByte])
		startByte -= size
	}
	endByte := byteIdx + byteLen
	for n := 0; n < searchPreviewAfter && endByte < len(line); n++ {
		_, size := utf8.DecodeRuneInString(line[endByte:])
		endByte += size
	}
	prefix := startByte > 0
	suffix := endByte < len(line)
	var b strings.Builder
	b.Grow(endByte - startByte + 8)
	if prefix {
		b.WriteRune('…')
	}
	b.WriteString(line[startByte:endByte])
	if suffix {
		b.WriteRune('…')
	}
	start := utf16Len(line[startByte:byteIdx])
	if prefix {
		start++
	}
	end := start + utf16Len(line[byteIdx:byteIdx+byteLen])
	return b.String(), start, end
}

func isASCIIString(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func asciiLowerByte(b byte) byte {
	if b >= 'A' && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
}

// indexFoldASCII 在纯 ASCII 文本上做大小写不敏感查找，避免逐行 strings.ToLower 分配。
func indexFoldASCII(s, needle string) int {
	if needle == "" {
		return 0
	}
	first := asciiLowerByte(needle[0])
	for i := 0; i+len(needle) <= len(s); i++ {
		if asciiLowerByte(s[i]) != first {
			continue
		}
		match := true
		for j := 1; j < len(needle); j++ {
			if asciiLowerByte(s[i+j]) != asciiLowerByte(needle[j]) {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

type searchFileJob struct {
	path   string
	name   string
	relDir string
}

type searchFileResult struct {
	hits       []SearchHit
	scanned    bool
	overBudget bool
}

func scanSearchFile(job searchFileJob, needle string, needleASCII, caseSensitive, fuzzy bool, deadline time.Time) searchFileResult {
	var out searchFileResult
	if time.Now().After(deadline) {
		out.overBudget = true
		return out
	}
	f, err := os.Open(job.path)
	if err != nil {
		return out
	}
	defer f.Close()
	head := make([]byte, 8192)
	n, _ := f.Read(head)
	if bytes.IndexByte(head[:n], 0) >= 0 {
		return out
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return out
	}
	out.scanned = true
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 32*1024), searchMaxLineBytes)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		if lineNo%512 == 0 && time.Now().After(deadline) {
			out.overBudget = true
			break
		}
		line := scanner.Text()
		if lineNo == 1 {
			line = strings.TrimPrefix(line, "\uFEFF")
		}
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			continue
		}
		foldASCII := !caseSensitive && needleASCII && isASCIIString(line)
		haystack := line
		if !caseSensitive && !foldASCII {
			haystack = strings.ToLower(line)
		}
		hitsBefore := len(out.hits)
		searchFrom := 0
		for {
			var idx int
			if foldASCII {
				idx = indexFoldASCII(haystack[searchFrom:], needle)
			} else {
				idx = strings.Index(haystack[searchFrom:], needle)
			}
			if idx < 0 {
				break
			}
			idx += searchFrom
			preview, mStart, mEnd := buildSearchPreview(line, idx, len(needle))
			out.hits = append(out.hits, SearchHit{
				Path:       job.path,
				Name:       job.name,
				Dir:        job.relDir,
				Line:       lineNo,
				Column:     utf16Len(line[:idx]) + 1,
				Length:     utf16Len(line[idx : idx+len(needle)]),
				Preview:    preview,
				MatchStart: mStart,
				MatchEnd:   mEnd,
			})
			if len(out.hits) >= searchMaxPerFile {
				return out
			}
			searchFrom = idx + len(needle)
			if searchFrom >= len(haystack) {
				break
			}
		}
		// 模糊模式：整行没有字面命中时才做子序列匹配，每行至多一条（fzf 语义）
		if fuzzy && len(out.hits) == hitsBefore {
			if start, end, ok := fuzzyFind(line, needle, caseSensitive); ok {
				preview, mStart, mEnd := buildSearchPreview(line, start, end-start)
				out.hits = append(out.hits, SearchHit{
					Path:       job.path,
					Name:       job.name,
					Dir:        job.relDir,
					Line:       lineNo,
					Column:     utf16Len(line[:start]) + 1,
					Length:     utf16Len(line[start:end]),
					Preview:    preview,
					MatchStart: mStart,
					MatchEnd:   mEnd,
					fuzzySplit: true,
				})
				if len(out.hits) >= searchMaxPerFile {
					return out
				}
			}
		}
	}
	return out
}

// SearchWorkspace 流式扫描工作区文本文件，不建索引；命中数/单文件命中/耗时均有限额。
func (s *Searcher) SearchWorkspace(root, query string, caseSensitive bool, maxResults int) (*SearchResult, error) {
	return s.searchWorkspace(root, query, caseSensitive, maxResults, "", false)
}

// SearchWorkspaceFuzzy 在 SearchWorkspace 的扫描与限额之上启用 fzf 式子序列匹配：
// 每行先找字面命中（与普通模式完全一致），整行没有字面命中时再找「字符按序出现」
// 的最小窗口；窗口超过 fuzzyMaxWindow 个字符视为无意义命中，直接丢弃。
// 子序列匹配没有 rg 对应能力，此模式固定走内置扫描（共用同一个 searchBudget）。
func (s *Searcher) SearchWorkspaceFuzzy(root, query string, caseSensitive bool, maxResults int) (*SearchResult, error) {
	return s.searchWorkspace(root, query, caseSensitive, maxResults, "", true)
}

// SearchWorkspaceFiltered 与 SearchWorkspace 同源，但只保留 filePattern 通配匹配的文件命中。
// pattern 语义与 globMatchPath 一致；AI 的 search_text 把 filePattern 下推到这里，
// 避免无关文件的命中先占满结果窗口（前端仍保留一次兜底过滤）。
func (s *Searcher) SearchWorkspaceFiltered(root, query string, caseSensitive bool, maxResults int, pattern string) (*SearchResult, error) {
	return s.searchWorkspace(root, query, caseSensitive, maxResults, strings.TrimSpace(pattern), false)
}

func (s *Searcher) searchWorkspace(root, query string, caseSensitive bool, maxResults int, pattern string, fuzzy bool) (*SearchResult, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("未打开工作区目录")
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		root = filepath.Dir(root)
	}
	if query == "" {
		return &SearchResult{}, nil
	}
	if maxResults <= 0 || maxResults > 1000 {
		maxResults = searchMaxResults
	}
	if !fuzzy && os.Getenv("DATALENS_NO_RG") == "" {
		if res, ok := searchWithRipgrep(root, query, caseSensitive, maxResults, pattern); ok {
			return res, nil
		}
	}
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(query)
	}
	needleASCII := isASCIIString(needle)
	deadline := time.Now().Add(searchBudget)
	srcJobs := make([]searchFileJob, 0, 256)
	artJobs := make([]searchFileJob, 0, 32)
	walkErr := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if path != root {
				if searchSkipDirs[strings.ToLower(name)] || name == ".git" {
					return filepath.SkipDir
				}
				// AI 隔离 worktree 副本整棵跳过（按相对路径；从 worktree 内发起的检索不受影响）
				if rel, relErr := filepath.Rel(root, path); relErr == nil && SkipPath(rel) {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if searchBinaryExt[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		rel := name
		if r, relErr := filepath.Rel(root, path); relErr == nil {
			rel = r
		}
		// filePattern 下推：不匹配的文件不进扫描队列（前端仍会兜底过滤一次，口径一致）
		if pattern != "" && !globMatchPath(pattern, filepath.ToSlash(rel), name) {
			return nil
		}
		if info, err := d.Info(); err != nil || info.Size() > searchMaxFileSize {
			return nil
		}
		relDir := filepath.Dir(rel)
		if relDir == "." || relDir == "" {
			relDir = filepath.Base(root)
		}
		job := searchFileJob{path: path, name: name, relDir: relDir}
		if searchIsArtifactPath(rel) {
			artJobs = append(artJobs, job)
		} else {
			srcJobs = append(srcJobs, job)
		}
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipAll {
		return nil, walkErr
	}
	// 两阶段扫描：源码档先占预算，未被挤满才补产物档（共享同一个绝对 deadline）
	srcHits, srcScanned, truncated := scanSearchJobs(srcJobs, needle, needleASCII, caseSensitive, fuzzy, deadline, maxResults)
	sortSearchTier(srcHits, needle, caseSensitive, fuzzy)
	result := &SearchResult{Hits: srcHits, Files: srcScanned}
	if len(result.Hits) < maxResults && len(artJobs) > 0 {
		artHits, artScanned, artTrunc := scanSearchJobs(artJobs, needle, needleASCII, caseSensitive, fuzzy, deadline, maxResults-len(result.Hits))
		sortSearchTier(artHits, needle, caseSensitive, fuzzy)
		result.Hits = append(result.Hits, artHits...)
		result.Files += artScanned
		truncated = truncated || artTrunc
	} else if len(artJobs) > 0 && len(result.Hits) >= maxResults {
		result.ArtifactSkipped = true
	}
	result.Truncated = truncated || len(result.Hits) >= maxResults
	return result, nil
}

// scanSearchJobs 并行扫描一组文件，命中按 jobs 顺序回收；到 hitCap 或超预算即截断。
// 每个文件只扫一遍，排序只在 ≤ hitCap 条命中上做。
func scanSearchJobs(jobs []searchFileJob, needle string, needleASCII, caseSensitive, fuzzy bool, deadline time.Time, hitCap int) ([]SearchHit, int, bool) {
	if len(jobs) == 0 || hitCap <= 0 {
		return nil, 0, len(jobs) > 0
	}
	workers := runtime.NumCPU()
	if workers > len(jobs) {
		workers = len(jobs)
	}
	if workers > 16 {
		workers = 16
	}
	perFile := make([][]SearchHit, len(jobs))
	var filesScanned int64
	var totalHits int64
	var stop atomic.Bool
	var truncated atomic.Bool
	jobCh := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobCh {
				if stop.Load() {
					continue
				}
				res := scanSearchFile(jobs[idx], needle, needleASCII, caseSensitive, fuzzy, deadline)
				if res.scanned {
					atomic.AddInt64(&filesScanned, 1)
				}
				if res.overBudget {
					truncated.Store(true)
					stop.Store(true)
				}
				if len(res.hits) > 0 {
					perFile[idx] = res.hits
					if atomic.AddInt64(&totalHits, int64(len(res.hits))) >= int64(hitCap) {
						truncated.Store(true)
						stop.Store(true)
					}
				}
			}
		}()
	}
	feedStopped := false
	for idx := range jobs {
		if stop.Load() {
			feedStopped = true
			break
		}
		if time.Now().After(deadline) {
			truncated.Store(true)
			feedStopped = true
			break
		}
		jobCh <- idx
	}
	close(jobCh)
	wg.Wait()
	if feedStopped {
		truncated.Store(true)
	}
	hits := make([]SearchHit, 0, min(int(totalHits), hitCap))
merge:
	for idx := range perFile {
		for _, hit := range perFile[idx] {
			if len(hits) >= hitCap {
				truncated.Store(true)
				break merge
			}
			hits = append(hits, hit)
		}
	}
	return hits, int(filesScanned), truncated.Load()
}
