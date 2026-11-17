// graph.go：Git 图谱引擎——带泳道（graph lane）拓扑的提交历史、分组 ref 列表与
// 历史上的写操作（签出 / 重置 / cherry-pick）。泳道在 Go 侧算好，前端只负责渲染。
// 全部走 gitRun（gitinfo.go 唯一执行入口，已带防黑窗 / GIT_TERMINAL_PROMPT=0 / 超时）。
package gitinfo

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// GitGraphCommit 是图谱里的一行提交。Lane/ThroughLanes 由 assignLanes 计算，
// 前端据此画竖线与弧线：Lane 是提交圆点所在泳道，ThroughLanes 是穿过该行的其它泳道。
type GitGraphCommit struct {
	Sha          string `json:"sha"`
	Parents      []string `json:"parents"`
	Refs         string   `json:"refs,omitempty"`         // git %D 原文（装饰器，如 HEAD -> master, origin/master）
	Author       string   `json:"author"`
	Email        string   `json:"email,omitempty"`
	Date         string   `json:"date"`                   // 已格式化的本地时间
	Subject      string   `json:"subject"`
	Lane         int      `json:"lane"`
	ThroughLanes []int    `json:"throughLanes"`           // 该行需要画穿线的泳道（升序）
}

// GitGraphPage 是一页提交。HasMore + NextSkip 供前端滚动到底时续拉。
type GitGraphPage struct {
	Available bool             `json:"available"`
	Reason    string           `json:"reason,omitempty"`
	Root      string           `json:"root,omitempty"`
	HeadBranch string          `json:"headBranch,omitempty"`
	Ref       string           `json:"ref,omitempty"`          // 实际作用的 ref（空 = 当前 HEAD）
	Commits   []GitGraphCommit `json:"commits"`
	LaneCount int              `json:"laneCount"`
	HasMore   bool             `json:"hasMore"`
	NextSkip  int              `json:"nextSkip"`
}

const (
	graphDefaultLimit = 500
	graphMaxLimit     = 2000
	graphLogTimeoutMs = 20000
)

// assignLanes 按提交顺序（git log --date-order，新→旧）分配泳道并算每行穿线。
// 返回与 commits 等长的 lane 切片；同时回填每个 commit 的 Lane / ThroughLanes。
//
// 算法（标准「最小空闲泳道」）：
//   - laneOf 记录每个 sha 已被分配的泳道（子提交先到，为它的父预留）。
//   - 处理一行时：该行泳道 = laneOf 里已预留的，否则取当前空闲的最小泳道。
//   - 该行的每个父：若父已在 laneOf（别的子已为它留位）则复用；否则优先继承当前行的泳道
//     （直线延续），当前行泳道被占用时才新开泳道。
//   - 当前行的父处理完后，当前行泳道若不再被任何待续父占用，则标记为空闲（该行圆点画完即止）。
func assignLanes(commits []GitGraphCommit) []int {
	lanes := make([]int, len(commits))
	laneOf := make(map[string]int, len(commits))
	// pendingLanes: 泳道 -> 仍待续（已有子但父还没出现）的父 sha 集合
	pending := map[int]map[string]bool{}
	used := map[int]bool{} // 当前已被占用的泳道

	firstFree := func() int {
		for l := 0; ; l++ {
			if !used[l] {
				return l
			}
		}
	}

	for i := range commits {
		c := &commits[i]
		lane := 0
		if l, ok := laneOf[c.Sha]; ok {
			lane = l
		} else {
			lane = firstFree()
			laneOf[c.Sha] = lane
		}
		used[lane] = true
		lanes[i] = lane
		c.Lane = lane

		// 穿线：其它泳道若有待续父（不属于本行的父），本行要画穿线
		through := []int{}
		for l, shas := range pending {
			if l == lane {
				continue
			}
			for sha := range shas {
				if !containsSha(c.Parents, sha) {
					through = append(through, l)
					break
				}
			}
		}
		sortInts(through)
		c.ThroughLanes = through

		// 为父分配泳道
		firstNewParent := true
		for _, p := range c.Parents {
			if _, ok := laneOf[p]; ok {
				continue
			}
			if firstNewParent {
				// 第一个新父继承当前 lane（直线延续）
				laneOf[p] = lane
				firstNewParent = false
			} else {
				// 后续父取空闲泳道
				nl := firstFree()
				laneOf[p] = nl
				used[nl] = true
			}
		}

		// 更新 pending：本行所有父都记为待续；本行自身泳道若不再有待续父则释放
		for _, p := range c.Parents {
			pl := laneOf[p]
			if pending[pl] == nil {
				pending[pl] = map[string]bool{}
			}
			pending[pl][p] = true
		}
		stillPending := false
		for _, p := range c.Parents {
			if laneOf[p] == lane {
				stillPending = true
				break
			}
		}
		if !stillPending {
			delete(pending, lane)
			used[lane] = false
		}
	}
	return lanes
}

func containsSha(list []string, sha string) bool {
	for _, s := range list {
		if s == sha {
			return true
		}
	}
	return false
}

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

// GraphCommits 返回一页带泳道拓扑的提交。ref 为空表示当前 HEAD；skip 用于分页续拉。
func GraphCommits(dir string, ref string, limit int, skip int) (*GitGraphPage, error) {
	page := &GitGraphPage{Commits: []GitGraphCommit{}}
	dir = strings.TrimSpace(dir)
	ref = strings.TrimSpace(ref)
	if dir == "" {
		page.Reason = "没有打开的目录"
		return page, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		page.Reason = "未安装 git"
		return page, nil
	}
	if code != 0 || strings.TrimSpace(out) != "true" {
		page.Reason = "不在 git 仓库内"
		return page, nil
	}
	page.Available = true
	if root, _, _ := gitRun(dir, []string{"rev-parse", "--show-toplevel"}, 5000); root != "" {
		page.Root = strings.TrimSpace(root)
	}
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		page.HeadBranch = strings.TrimSpace(b)
	}
	if limit <= 0 {
		limit = graphDefaultLimit
	}
	if limit > graphMaxLimit {
		limit = graphMaxLimit
	}
	if skip < 0 {
		skip = 0
	}
	// 多取一条判断 hasMore；NUL 分隔字段，单元间用 \x1f 避免与字段冲突
	args := []string{
		"log", "-n", strconv.Itoa(limit + 1),
		"--date-order",
		"--skip=" + strconv.Itoa(skip),
		"--date=format:%Y-%m-%d %H:%M",
		"--pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s",
	}
	if ref != "" {
		if strings.HasPrefix(ref, "-") {
			page.Reason = "非法修订"
			return page, nil
		}
		args = append(args, "--", ref)
	}
	raw, code, err := gitRun(dir, args, graphLogTimeoutMs)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		page.Reason = "读取提交历史失败"
		return page, nil
	}
	lines := splitGraphLines(raw)
	if len(lines) > limit {
		lines = lines[:limit]
		page.HasMore = true
		page.NextSkip = skip + limit
	}
	commits := parseGraphLines(lines)
	assignLanes(commits)
	laneCount := 0
	for _, c := range commits {
		if c.Lane+1 > laneCount {
			laneCount = c.Lane + 1
		}
	}
	page.Commits = commits
	page.LaneCount = laneCount
	page.Ref = ref
	return page, nil
}

// splitGraphLines 按行切分 git log 输出（容忍 \r\n）。
func splitGraphLines(raw string) []string {
	raw = strings.ReplaceAll(raw, "\r\n", "\n")
	raw = strings.TrimSuffix(raw, "\n")
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	return strings.Split(raw, "\n")
}

// parseGraphLines 解析 %H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s。
func parseGraphLines(lines []string) []GitGraphCommit {
	commits := []GitGraphCommit{}
	for _, line := range lines {
		f := strings.Split(line, "\x1f")
		if len(f) < 7 {
			continue
		}
		c := GitGraphCommit{
			Sha:     strings.TrimSpace(f[0]),
			Refs:    strings.TrimSpace(f[2]),
			Author:  strings.TrimSpace(f[3]),
			Email:   strings.TrimSpace(f[4]),
			Subject: strings.TrimSpace(f[6]),
		}
		if ts, err := strconv.ParseInt(strings.TrimSpace(f[5]), 10, 64); err == nil {
			c.Date = formatGitTime(ts)
		} else {
			c.Date = strings.TrimSpace(f[5])
		}
		if p := strings.TrimSpace(f[1]); p != "" {
			c.Parents = strings.Fields(p)
		} else {
			c.Parents = []string{}
		}
		commits = append(commits, c)
	}
	return commits
}

// formatGitTime 把 unix 时间戳格式化为本地时间（与 RecentLogFor 的展示口径一致）。
func formatGitTime(ts int64) string {
	return time.Unix(ts, 0).Format("2006-01-02 15:04")
}

// ===== ref 列表 =====

// GitGraphRef 是 ref 树里的一个条目（分支 / 远程 / 标签 / worktree HEAD）。
type GitGraphRef struct {
	Name     string `json:"name"`
	Sha      string `json:"sha,omitempty"`
	Current  bool   `json:"current,omitempty"`
	Worktree string `json:"worktree,omitempty"` // 属于哪个 worktree（主根为空）
	Detached bool   `json:"detached,omitempty"`
}

// GitGraphRefsResult 是图谱左栏的分组 ref。
type GitGraphRefsResult struct {
	Available bool          `json:"available"`
	Reason    string        `json:"reason,omitempty"`
	Root      string        `json:"root,omitempty"`
	Current   string        `json:"current,omitempty"` // 当前分支名（detached 为空）
	HeadSha   string        `json:"headSha,omitempty"`
	Local     []GitGraphRef `json:"local"`
	Remote    []GitGraphRef `json:"remote"`
	Tags      []GitGraphRef `json:"tags"`
	Worktrees []GitGraphRef `json:"worktrees"`
}

// GraphRefs 返回图谱左栏数据：当前 HEAD、本地/远程分支、标签、各 worktree 的 HEAD。
func GraphRefs(dir string) (*GitGraphRefsResult, error) {
	res := &GitGraphRefsResult{Local: []GitGraphRef{}, Remote: []GitGraphRef{}, Tags: []GitGraphRef{}, Worktrees: []GitGraphRef{}}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		res.Reason = "没有打开的目录"
		return res, nil
	}
	out, code, err := gitRun(dir, []string{"rev-parse", "--is-inside-work-tree"}, 5000)
	if err != nil {
		res.Reason = "未安装 git"
		return res, nil
	}
	if code != 0 || strings.TrimSpace(out) != "true" {
		res.Reason = "不在 git 仓库内"
		return res, nil
	}
	res.Available = true
	if root, _, _ := gitRun(dir, []string{"rev-parse", "--show-toplevel"}, 5000); root != "" {
		res.Root = strings.TrimSpace(root)
	}
	if b, c, _ := gitRun(dir, []string{"rev-parse", "--abbrev-ref", "HEAD"}, 5000); c == 0 {
		name := strings.TrimSpace(b)
		if name != "HEAD" {
			res.Current = name
		}
	}
	if s, c, _ := gitRun(dir, []string{"rev-parse", "HEAD"}, 5000); c == 0 {
		res.HeadSha = strings.TrimSpace(s)
	}
	// 本地分支（带 HEAD 标记与 sha）
	if raw, c, _ := gitRun(dir, []string{
		"for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(HEAD)", "refs/heads",
	}, 10000); c == 0 {
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" {
				continue
			}
			p := strings.Split(line, "\t")
			if len(p) < 3 {
				continue
			}
			res.Local = append(res.Local, GitGraphRef{
				Name:    strings.TrimSpace(p[0]),
				Sha:     strings.TrimSpace(p[1]),
				Current: strings.TrimSpace(p[2]) == "*",
			})
		}
	}
	// 远程分支（排除符号引用与远程 HEAD）
	if raw, c, _ := gitRun(dir, []string{
		"for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)", "refs/remotes",
	}, 10000); c == 0 {
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" {
				continue
			}
			p := strings.Split(line, "\t")
			if len(p) < 3 {
				continue
			}
			full := strings.TrimSpace(p[0])
			if strings.TrimSpace(p[2]) != "" || strings.HasSuffix(full, "/HEAD") {
				continue
			}
			name := strings.TrimPrefix(full, "refs/remotes/")
			if name == "" || !strings.Contains(name, "/") {
				continue
			}
			res.Remote = append(res.Remote, GitGraphRef{Name: name, Sha: strings.TrimSpace(p[1])})
		}
	}
	// 标签
	if raw, c, _ := gitRun(dir, []string{
		"for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%09%(objectname)", "refs/tags",
	}, 10000); c == 0 {
		for _, line := range strings.Split(raw, "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" {
				continue
			}
			p := strings.Split(line, "\t")
			if len(p) < 2 {
				continue
			}
			res.Tags = append(res.Tags, GitGraphRef{
				Name: strings.TrimSpace(p[0]),
				Sha:  strings.TrimSpace(p[1]),
			})
		}
	}
	// worktree HEAD（主根之外的检出）
	if wl, err := WorktreeList(dir); err == nil && wl != nil {
		for _, w := range wl.Items {
			if w.Bare || !w.UnderCadt {
				continue
			}
			res.Worktrees = append(res.Worktrees, GitGraphRef{
				Name:     w.Branch,
				Sha:      w.Head,
				Worktree: w.RelPath,
				Detached: w.Detached,
			})
		}
	}
	return res, nil
}

// ===== 历史上的写操作（用户在图谱上主动点，走确认弹窗 + 只读锁；不涉 AI 审批链） =====

// GraphCheckout 签出到指定分支 / 标签 / 提交（复用 CheckoutRef 语义）。
func GraphCheckout(dir string, ref string) (*GitOperationResult, error) {
	return CheckoutRef(dir, ref)
}

// GraphReset 把当前分支重置到 sha。mode 限 soft / mixed / hard；hard 会丢工作区改动，
// 前端必须先弹确认。sha 校验为十六进制，拒绝任意参数注入。
func GraphReset(dir string, sha string, mode string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	sha = strings.TrimSpace(sha)
	mode = strings.TrimSpace(mode)
	if dir == "" || sha == "" {
		return nil, fmt.Errorf("缺少目录或提交")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("非法提交：%s", sha)
	}
	switch mode {
	case "soft", "mixed", "hard":
	default:
		return nil, fmt.Errorf("非法重置模式：%s", mode)
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", sha + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到提交：" + sha}, nil
	}
	out, code, err := gitRun(dir, []string{"reset", "--" + mode, sha}, 30000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}, nil
}

// GraphCherryPick 把单个提交摘到当前分支。冲突时如实返回失败输出，不静默。
func GraphCherryPick(dir string, sha string) (*GitOperationResult, error) {
	dir = strings.TrimSpace(dir)
	sha = strings.TrimSpace(sha)
	if dir == "" || sha == "" {
		return nil, fmt.Errorf("缺少目录或提交")
	}
	if strings.HasPrefix(sha, "-") || !shaRe.MatchString(sha) {
		return nil, fmt.Errorf("非法提交：%s", sha)
	}
	if _, code, _ := gitRun(dir, []string{"rev-parse", "--verify", "--quiet", sha + "^{commit}"}, 5000); code != 0 {
		return &GitOperationResult{Success: false, Output: "找不到提交：" + sha}, nil
	}
	out, code, err := gitRun(dir, []string{"cherry-pick", sha}, 60000)
	if err != nil {
		return nil, err
	}
	return &GitOperationResult{Success: code == 0, Output: strings.TrimSpace(out)}, nil
}
