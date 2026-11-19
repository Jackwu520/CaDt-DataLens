package search

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
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
	searchMaxFileSize    = 4 << 20
	searchMaxLineBytes   = 1 << 20
	searchMaxResults     = 400
	searchHardMaxResults = 1000
	searchMaxPerFile     = 30
	searchBudget         = 3500 * time.Millisecond
	searchPreviewBefore  = 60
	searchPreviewAfter   = 140
	searchMaxContext     = 3
)

var searchSkipDirs = map[string]bool{
	".git": true, ".svn": true, ".hg": true,
	".idea": true, ".vscode": true,
	"node_modules": true, "__pycache__": true,
	".pytest_cache": true, ".mypy_cache": true,
	".gradle": true, ".cache": true,
	// Python 虚拟环境：几万个文件、检索无意义，指纹计数与 watcher 删除计数同样跳过
	// （pip install / 重建 venv 是合法的批量删除，2026-11-19 举一反三排查）。
	".venv": true, "venv": true, "site-packages": true,
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

// SearchOptions 高级检索参数（AI search_text 下推；Wails 绑定可直接收该结构）。
// 空字段一律表示「用默认值」——旧参数面（SearchWorkspace / Filtered）走零值即完全兼容。
type SearchOptions struct {
	CaseSensitive  bool   `json:"caseSensitive"`
	Regex          bool   `json:"regex"`
	WholeWord      bool   `json:"wholeWord"`
	Pattern        string `json:"pattern"`        // 包含通配（filePattern）
	ExcludePattern string `json:"excludePattern"` // 排除通配（globMatchPath 语义）
	OutputMode     string `json:"outputMode"`     // 空 / content / files / count
	Context        int    `json:"context"`        // 0..3
	MaxResults     int    `json:"maxResults"`     // 1..1000，0 = 默认 400
	// FileOnly：root 为单个文件时只扫这一个文件（不向父目录扩散）。
	// 兼容旧行为：FileOnly=false 时文件根仍按父目录扫描（历史语义）。
	FileOnly bool `json:"fileOnly"`
}

// ContextLine 命中行的上下文（行号 + 原文），前后各最多 searchMaxContext 行。
type ContextLine struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

type SearchHit struct {
	Path       string        `json:"path"`
	Name       string        `json:"name"`
	Dir        string        `json:"dir"`
	Line       int           `json:"line"`
	Column     int           `json:"column"`
	Length     int           `json:"length"`
	Preview    string        `json:"preview"`
	MatchStart int           `json:"matchStart"`
	MatchEnd   int           `json:"matchEnd"`
	Before     []ContextLine `json:"before,omitempty"`
	After      []ContextLine `json:"after,omitempty"`
	// fuzzySplit 标记子序列（离散）命中，仅用于排序分档，不进 JSON。
	fuzzySplit bool
}

// FileCount outputMode=count 时的单文件命中数。
type FileCount struct {
	Path  string `json:"path"`
	Count int    `json:"count"`
}

type SearchResult struct {
	Hits      []SearchHit `json:"hits"`
	Truncated bool        `json:"truncated"`
	Files     int         `json:"files"`
	// ArtifactSkipped 表示源码档已吃满结果上限、产物档根本没去扫（仅当被上限截住时为 true）。
	ArtifactSkipped bool `json:"artifactSkipped,omitempty"`
	// FileList 仅 outputMode=files 填充：有命中的文件（按排序后的命中顺序去重）。
	FileList []string `json:"fileList,omitempty"`
	// Counts 仅 outputMode=count 填充：每文件命中数（同上顺序）。
	Counts []FileCount `json:"counts,omitempty"`
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

// searchSpec 一次检索的归一化参数（内部用，不进 Wails 绑定）。
// 两条扫描路径（rg / 内置）共用同一份 spec，保证参数语义不漂移。
type searchSpec struct {
	query         string
	needle        string // 模式化后小写（字面量 / fuzzy 用）
	caseSensitive bool
	fuzzy         bool
	regex         bool
	wholeWord     bool
	re            *regexp.Regexp
	pattern       string
	exclude       string
	maxResults    int
	context       int
	outputMode    string
	fileOnly      bool
}

func newSearchSpec(query string, opts SearchOptions) (*searchSpec, error) {
	spec := &searchSpec{
		query:         query,
		caseSensitive: opts.CaseSensitive,
		regex:         opts.Regex,
		wholeWord:     opts.WholeWord,
		pattern:       strings.TrimSpace(opts.Pattern),
		exclude:       strings.TrimSpace(opts.ExcludePattern),
		outputMode:    strings.ToLower(strings.TrimSpace(opts.OutputMode)),
		context:       opts.Context,
		maxResults:    opts.MaxResults,
		fileOnly:      opts.FileOnly,
	}
	if spec.outputMode == "" {
		spec.outputMode = "content"
	}
	if spec.outputMode != "content" && spec.outputMode != "files" && spec.outputMode != "count" {
		return nil, errors.New("outputMode 只支持 content / files / count")
	}
	if spec.context < 0 {
		spec.context = 0
	}
	if spec.context > searchMaxContext {
		spec.context = searchMaxContext
	}
	if spec.maxResults <= 0 {
		spec.maxResults = searchMaxResults
	}
	if spec.maxResults > searchHardMaxResults {
		spec.maxResults = searchHardMaxResults
	}
	if spec.regex {
		pat := spec.query
		if !spec.caseSensitive {
			pat = "(?i)" + pat
		}
		if spec.wholeWord {
			pat = `\b(?:` + pat + `)\b`
		}
		re, err := regexp.Compile(pat)
		if err != nil {
			return nil, errors.New("正则表达式无效：" + err.Error())
		}
		spec.re = re
	} else {
		needle := query
		if !spec.caseSensitive {
			needle = strings.ToLower(query)
		}
		spec.needle = needle
	}
	return spec, nil
}

// legacySearchSpec 老绑定（SearchWorkspace / Filtered / Fuzzy）的零选项适配。
func legacySearchSpec(query string, caseSensitive bool, maxResults int, pattern string, fuzzy bool) *searchSpec {
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(query)
	}
	if maxResults <= 0 || maxResults > searchHardMaxResults {
		maxResults = searchMaxResults
	}
	return &searchSpec{
		query:         query,
		needle:        needle,
		caseSensitive: caseSensitive,
		fuzzy:         fuzzy,
		pattern:       strings.TrimSpace(pattern),
		outputMode:    "content",
		maxResults:    maxResults,
	}
}

func isWordByte(b byte) bool {
	return b == '_' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') ||
		(b >= 'A' && b <= 'Z') || b >= 0x80 // 非 ASCII 字节按「词字符」保守处理
}

// findMatches 返回一行内所有命中的字节区间 [start, end)。
// 正则模式用 Go regexp（RE2，线性时间，无灾难性回溯）；字面量模式沿用 ASCII 折叠快路径。
func (spec *searchSpec) findMatches(line string) [][2]int {
	if spec.regex {
		locs := spec.re.FindAllStringIndex(line, -1)
		out := make([][2]int, 0, len(locs))
		for _, loc := range locs {
			out = append(out, [2]int{loc[0], loc[1]})
		}
		return out
	}
	needle := spec.needle
	if needle == "" {
		return nil
	}
	foldASCII := !spec.caseSensitive && isASCIIString(needle) && isASCIIString(line)
	haystack := line
	if !spec.caseSensitive && !foldASCII {
		haystack = strings.ToLower(line)
	}
	var out [][2]int
	from := 0
	for {
		var idx int
		if foldASCII {
			idx = indexFoldASCII(haystack[from:], needle)
		} else {
			idx = strings.Index(haystack[from:], needle)
		}
		if idx < 0 {
			break
		}
		idx += from
		end := idx + len(needle)
		if !spec.wholeWord ||
			!(idx > 0 && isWordByte(line[idx-1])) && !(end < len(line) && isWordByte(line[end])) {
			out = append(out, [2]int{idx, end})
		}
		from = idx + len(needle)
		if from >= len(haystack) {
			break
		}
	}
	return out
}

// attachContextFromSlice 内置扫描路径：从同文件行数组附上前后文。
func attachContextFromSlice(hit *SearchHit, lines []string, lineIdx, n int) {
	if n <= 0 || lineIdx < 0 || lineIdx >= len(lines) {
		return
	}
	for i := lineIdx - n; i < lineIdx; i++ {
		if i >= 0 {
			hit.Before = append(hit.Before, ContextLine{Line: i + 1, Text: lines[i]})
		}
	}
	for i := lineIdx + 1; i <= lineIdx+n && i < len(lines); i++ {
		hit.After = append(hit.After, ContextLine{Line: i + 1, Text: lines[i]})
	}
}

// attachContextFromMap rg 路径：context 消息按「路径 → 行号 → 原文」收集，扫描结束后统一回填。
func attachContextFromMap(hits []SearchHit, byPath map[string]map[int]string, n int) {
	if n <= 0 || len(byPath) == 0 {
		return
	}
	for i := range hits {
		lines := byPath[hits[i].Path] // 只取本文件的上下文，绝不串到别的文件
		if len(lines) == 0 {
			continue
		}
		line := hits[i].Line
		for ln := line - n; ln < line; ln++ {
			if text, ok := lines[ln]; ok {
				hits[i].Before = append(hits[i].Before, ContextLine{Line: ln, Text: text})
			}
		}
		for ln := line + 1; ln <= line+n; ln++ {
			if text, ok := lines[ln]; ok {
				hits[i].After = append(hits[i].After, ContextLine{Line: ln, Text: text})
			}
		}
	}
}

// applyOutputMode 把命中的行列表聚合成「文件清单 / 每文件计数」，返回给 AI 时省掉大量 token。
// 两条路径都走这里聚合（rg 侧仍用 --json 收命中，避免 JSON 与 --count 输出形态冲突）。
func applyOutputMode(result *SearchResult, spec *searchSpec) {
	if result == nil {
		return
	}
	switch spec.outputMode {
	case "files":
		seen := make(map[string]bool, len(result.Hits))
		for _, hit := range result.Hits {
			if seen[hit.Path] {
				continue
			}
			seen[hit.Path] = true
			result.FileList = append(result.FileList, hit.Path)
		}
		result.Hits = nil
	case "count":
		counts := make([]FileCount, 0, len(result.Hits))
		index := make(map[string]int, len(result.Hits))
		for _, hit := range result.Hits {
			if i, ok := index[hit.Path]; ok {
				counts[i].Count++
				continue
			}
			index[hit.Path] = len(counts)
			counts = append(counts, FileCount{Path: hit.Path, Count: 1})
		}
		result.Counts = counts
		result.Hits = nil
	}
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

func scanSearchFile(job searchFileJob, spec *searchSpec, deadline time.Time) searchFileResult {
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
	// processLine 返回 true 表示单文件命中已满，调用方可以提前收工。
	processLine := func(line string, lineIdx int) bool {
		if line == "" {
			return false
		}
		hitsBefore := len(out.hits)
		appendHit := func(start, end int, fuzzySplit bool) {
			preview, mStart, mEnd := buildSearchPreview(line, start, end-start)
			hit := SearchHit{
				Path:       job.path,
				Name:       job.name,
				Dir:        job.relDir,
				Line:       lineIdx + 1,
				Column:     utf16Len(line[:start]) + 1,
				Length:     utf16Len(line[start:end]),
				Preview:    preview,
				MatchStart: mStart,
				MatchEnd:   mEnd,
				fuzzySplit: fuzzySplit,
			}
			out.hits = append(out.hits, hit)
		}
		// 模糊模式：整行先找字面命中（与老路径完全一致），没有再做子序列匹配（fzf 语义）
		for _, span := range spec.findMatches(line) {
			appendHit(span[0], span[1], false)
			if len(out.hits) >= searchMaxPerFile {
				return true
			}
		}
		if spec.fuzzy && len(out.hits) == hitsBefore {
			if start, end, ok := fuzzyFind(line, spec.needle, spec.caseSensitive); ok {
				appendHit(start, end, true)
			}
		}
		return len(out.hits) >= searchMaxPerFile
	}
	nextLine := func() (string, bool) {
		if !scanner.Scan() {
			return "", false
		}
		lineNo++
		if lineNo%512 == 0 && time.Now().After(deadline) {
			out.overBudget = true
			return "", false
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if lineNo == 1 {
			line = strings.TrimPrefix(line, "\uFEFF")
		}
		return line, true
	}
	if spec.context > 0 {
		// 前后文需要「未来的行」，先把全文读到行数组（单文件 ≤4MB，受既有上限保护）。
		lines := make([]string, 0, 256)
		for {
			line, ok := nextLine()
			if !ok {
				break
			}
			lines = append(lines, line)
		}
		for idx, line := range lines {
			if processLine(line, idx) {
				break
			}
		}
		for i := range out.hits {
			// 此时 lines 已收齐全文，前后文不会因「后文还没读到」而缺半边。
			attachContextFromSlice(&out.hits[i], lines, out.hits[i].Line-1, spec.context)
		}
		return out
	}
	for {
		line, ok := nextLine()
		if !ok {
			break
		}
		if processLine(line, lineNo-1) {
			break
		}
	}
	return out
}

// SearchWorkspace 流式扫描工作区文本文件，不建索引；命中数/单文件命中/耗时均有限额。
func (s *Searcher) SearchWorkspace(root, query string, caseSensitive bool, maxResults int) (*SearchResult, error) {
	return s.searchWorkspace(root, query, legacySearchSpec(query, caseSensitive, maxResults, "", false))
}

// SearchWorkspaceFuzzy 在 SearchWorkspace 的扫描与限额之上启用 fzf 式子序列匹配：
// 每行先找字面命中（与普通模式完全一致），整行没有字面命中时再找「字符按序出现」
// 的最小窗口；窗口超过 fuzzyMaxWindow 个字符视为无意义命中，直接丢弃。
// 子序列匹配没有 rg 对应能力，此模式固定走内置扫描（共用同一个 searchBudget）。
func (s *Searcher) SearchWorkspaceFuzzy(root, query string, caseSensitive bool, maxResults int) (*SearchResult, error) {
	return s.searchWorkspace(root, query, legacySearchSpec(query, caseSensitive, maxResults, "", true))
}

// SearchWorkspaceFiltered 与 SearchWorkspace 同源，但只保留 filePattern 通配匹配的文件命中。
// pattern 语义与 globMatchPath 一致；AI 的 search_text 把 filePattern 下推到这里，
// 避免无关文件的命中先占满结果窗口（前端仍保留一次兜底过滤）。
func (s *Searcher) SearchWorkspaceFiltered(root, query string, caseSensitive bool, maxResults int, pattern string) (*SearchResult, error) {
	return s.searchWorkspace(root, query, legacySearchSpec(query, caseSensitive, maxResults, pattern, false))
}

// SearchWorkspaceAdvanced 是 AI search_text 的高级入口：正则 / 全词 / 包含与排除通配 /
// 结果条数 / files+count 聚合 / 前后文。参数全部收在一个结构里（Wails 直接绑定），
// 旧三个入口保留零值兼容，UI 的全局搜索完全不受影响。
func (s *Searcher) SearchWorkspaceAdvanced(root, query string, opts SearchOptions) (*SearchResult, error) {
	spec, err := newSearchSpec(query, opts)
	if err != nil {
		return nil, err
	}
	return s.searchWorkspace(root, query, spec)
}

func (s *Searcher) searchWorkspace(root, query string, spec *searchSpec) (*SearchResult, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("未打开工作区目录")
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	// FileOnly：文件根保持原样，两条扫描路径都只扫这一个文件；
	// 未开 FileOnly 时保留历史语义（文件根扩散到父目录）。
	spec.fileOnly = spec.fileOnly && !info.IsDir()
	if !info.IsDir() && !spec.fileOnly {
		root = filepath.Dir(root)
	}
	if query == "" {
		return &SearchResult{}, nil
	}
	if !spec.fuzzy && os.Getenv("DATALENS_NO_RG") == "" {
		if res, ok := searchWithRipgrep(root, spec); ok {
			applyOutputMode(res, spec)
			return res, nil
		}
	}
	result, err := s.scanWorkspaceBuiltin(root, spec)
	if err != nil {
		return nil, err
	}
	applyOutputMode(result, spec)
	return result, nil
}

// scanWorkspaceBuiltin 纯 Go 扫描兜底路径（无 rg 或 rg 失败时）。
func (s *Searcher) scanWorkspaceBuiltin(root string, spec *searchSpec) (*SearchResult, error) {
	rootInfo, statErr := os.Stat(root)
	rootIsFile := statErr == nil && !rootInfo.IsDir()
	needle := spec.needle
	pattern := spec.pattern
	caseSensitive := spec.caseSensitive
	fuzzy := spec.fuzzy
	maxResults := spec.maxResults
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
		// 文件根（FileOnly）：唯一 job 的相对路径就是文件名，不参与目录相对路径推导
		rel := name
		if !rootIsFile {
			if r, relErr := filepath.Rel(root, path); relErr == nil {
				rel = r
			}
		}
		// filePattern 下推：不匹配的文件不进扫描队列（前端仍会兜底过滤一次，口径一致）
		if pattern != "" && !globMatchPath(pattern, filepath.ToSlash(rel), name) {
			return nil
		}
		// excludePattern 下推：与 rg 的 `--glob !排除` 同口径（globMatchPath 匹配即整文件跳过）
		if spec.exclude != "" && globMatchPath(spec.exclude, filepath.ToSlash(rel), name) {
			return nil
		}
		if info, err := d.Info(); err != nil || info.Size() > searchMaxFileSize {
			return nil
		}
		relDir := filepath.Dir(rel)
		if relDir == "." || relDir == "" {
			if rootIsFile {
				relDir = filepath.Base(filepath.Dir(root))
			} else {
				relDir = filepath.Base(root)
			}
		}
		job := searchFileJob{path: path, name: name, relDir: relDir}
		// 用户点名只搜这个文件时不参与产物分档：即使它在 dist/ 下也按源码档扫
		if (rootIsFile && spec.fileOnly) || !searchIsArtifactPath(rel) {
			srcJobs = append(srcJobs, job)
		} else {
			artJobs = append(artJobs, job)
		}
		return nil
	})
	if walkErr != nil && walkErr != filepath.SkipAll {
		return nil, walkErr
	}
	// 两阶段扫描：源码档先占预算，未被挤满才补产物档（共享同一个绝对 deadline）
	srcHits, srcScanned, truncated := scanSearchJobs(srcJobs, spec, deadline, maxResults)
	sortSearchTier(srcHits, needle, caseSensitive, fuzzy)
	result := &SearchResult{Hits: srcHits, Files: srcScanned}
	if len(result.Hits) < maxResults && len(artJobs) > 0 {
		artHits, artScanned, artTrunc := scanSearchJobs(artJobs, spec, deadline, maxResults-len(result.Hits))
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
func scanSearchJobs(jobs []searchFileJob, spec *searchSpec, deadline time.Time, hitCap int) ([]SearchHit, int, bool) {
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
				res := scanSearchFile(jobs[idx], spec, deadline)
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
