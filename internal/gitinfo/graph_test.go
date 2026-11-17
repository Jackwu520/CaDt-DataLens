// graph_test.go：Git 图谱引擎测试——泳道算法表驱动用例 + porcelain 解析 + 写操作参数校验。
// 泳道算法用例不依赖 git 环境（纯函数）；集成用例（GraphCommits/GraphRefs）无 git 时 skip。
package gitinfo

import (
	"os"
	"strings"
	"testing"
)

// ===== 泳道算法纯函数测试 =====

// laneCase 用 sha 序列描述一个拓扑，验证 assignLanes 的分配结果。
type laneCase struct {
	name    string
	commits []GitGraphCommit // 只需填 Sha 与 Parents，Lane/ThroughLanes 由算法填
	want    []int            // 期望的每行 Lane
}

func TestAssignLanes(t *testing.T) {
	cases := []laneCase{
		{
			name: "直线历史",
			commits: []GitGraphCommit{
				{Sha: "c3"}, {Sha: "c2"}, {Sha: "c1"},
			},
			want: []int{0, 0, 0},
		},
		{
			name: "分叉后合并（feature 从 main 分出再合回）",
			// c4(merge) -> c3, c1 ; c3 -> c2 ; c2 -> c1 ; c1 -> (root)
			// 顺序：c4, c3, c2, c1
			commits: []GitGraphCommit{
				{Sha: "c4", Parents: []string{"c3", "c1"}},
				{Sha: "c3", Parents: []string{"c2"}},
				{Sha: "c2", Parents: []string{"c1"}},
				{Sha: "c1"},
			},
			// c4 占 lane0，父 c3 继承 lane0，父 c1 新开 lane1
			// c3 在 lane0，父 c2 继承 lane0
			// c2 在 lane0，父 c1 已在 lane1
			// c1 在 lane1
			want: []int{0, 0, 0, 1},
		},
		{
			name: "两条独立分支并行",
			// a3 -> a2 -> a1 ; b3 -> b2 -> b1(=a1)
			// 顺序：a3, b3, a2, b2, a1, b1(假设 b1=a1 则只有一条链)
			// 用不同根：a 链 a3→a2→a1，b 链 b3→b2→b1
			commits: []GitGraphCommit{
				{Sha: "a3", Parents: []string{"a2"}},
				{Sha: "b3", Parents: []string{"b2"}},
				{Sha: "a2", Parents: []string{"a1"}},
				{Sha: "b2", Parents: []string{"b1"}},
				{Sha: "a1"},
				{Sha: "b1"},
			},
			// a3 占 lane0，父 a2 继承 lane0
			// b3 无预留，取 lane1，父 b2 继承 lane1
			// a2 在 lane0，父 a1 继承 lane0
			// b2 在 lane1，父 b1 继承 lane1
			// a1 在 lane0（无父，释放）
			// b1 在 lane1（无父，释放）
			want: []int{0, 1, 0, 1, 0, 1},
		},
		{
			name: "八叉合并（octopus）",
			// m -> a, b, c, d（四个父）
			commits: []GitGraphCommit{
				{Sha: "m", Parents: []string{"a", "b", "c", "d"}},
				{Sha: "a"}, {Sha: "b"}, {Sha: "c"}, {Sha: "d"},
			},
			// m 占 lane0，父 a 继承 lane0，b/c/d 新开 lane1/2/3
			want: []int{0, 0, 1, 2, 3},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			commits := make([]GitGraphCommit, len(tc.commits))
			copy(commits, tc.commits)
			got := assignLanes(commits)
			if len(got) != len(tc.want) {
				t.Fatalf("assignLanes 返回长度 %d，期望 %d", len(got), len(tc.want))
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("行 %d（sha=%s）：lane=%d，期望 %d", i, commits[i].Sha, got[i], tc.want[i])
				}
			}
			// 同时验证 commit.Lane 已回填
			for i := range commits {
				if commits[i].Lane != got[i] {
					t.Errorf("行 %d：commit.Lane=%d 与返回值 %d 不一致", i, commits[i].Lane, got[i])
				}
			}
		})
	}
}

func TestAssignLanesThroughLanes(t *testing.T) {
	// 分叉后合并：c4(merge) 行应有穿线（lane1 的 c1 还没出现）
	commits := []GitGraphCommit{
		{Sha: "c4", Parents: []string{"c3", "c1"}},
		{Sha: "c3", Parents: []string{"c2"}},
		{Sha: "c2", Parents: []string{"c1"}},
		{Sha: "c1"},
	}
	assignLanes(commits)
	// c4 行：父 c3 在 lane0，父 c1 在 lane1（新开）；c1 还没出现，lane1 待续
	// c3 行：lane0，穿线 lane1（c1 待续）
	if len(commits[1].ThroughLanes) == 0 {
		t.Errorf("c3 行应有穿线泳道，实际为空")
	}
}

// ===== porcelain 解析测试 =====

func TestParseGraphLines(t *testing.T) {
	// 模拟 git log --pretty=format:%H%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%at%x1f%s
	sha := strings.Repeat("a", 40)
	psha := strings.Repeat("b", 40)
	ts := "1700000000"
	line := strings.Join([]string{sha, psha, "HEAD -> master, origin/master", "Alice", "alice@example.com", ts, "feat: 新功能"}, "\x1f")
	commits := parseGraphLines([]string{line})
	if len(commits) != 1 {
		t.Fatalf("解析出 %d 条，期望 1 条", len(commits))
	}
	c := commits[0]
	if c.Sha != sha {
		t.Errorf("Sha=%s，期望 %s", c.Sha, sha)
	}
	if len(c.Parents) != 1 || c.Parents[0] != psha {
		t.Errorf("Parents=%v，期望 [%s]", c.Parents, psha)
	}
	if c.Refs != "HEAD -> master, origin/master" {
		t.Errorf("Refs=%s", c.Refs)
	}
	if c.Author != "Alice" {
		t.Errorf("Author=%s", c.Author)
	}
	if c.Subject != "feat: 新功能" {
		t.Errorf("Subject=%s", c.Subject)
	}
	if c.Date == "" {
		t.Errorf("Date 为空")
	}
}

func TestParseGraphLinesRootCommit(t *testing.T) {
	sha := strings.Repeat("c", 40)
	line := strings.Join([]string{sha, "", "", "Bob", "bob@x.com", "1700000001", "initial"}, "\x1f")
	commits := parseGraphLines([]string{line})
	if len(commits) != 1 {
		t.Fatalf("解析出 %d 条", len(commits))
	}
	if len(commits[0].Parents) != 0 {
		t.Errorf("根提交 Parents 应为空，实际 %v", commits[0].Parents)
	}
}

func TestParseGraphLinesMalformed(t *testing.T) {
	// 字段不足的行应被跳过
	commits := parseGraphLines([]string{"incomplete"})
	if len(commits) != 0 {
		t.Errorf("畸形行应跳过，实际解析出 %d 条", len(commits))
	}
}

// ===== 写操作参数校验测试 =====

func TestGraphResetInvalidSha(t *testing.T) {
	if _, err := GraphReset("/tmp", "-evil", "hard"); err == nil {
		t.Error("以 - 开头的 sha 应报错")
	}
	if _, err := GraphReset("/tmp", "rm -rf /", "hard"); err == nil {
		t.Error("非十六进制 sha 应报错")
	}
	if _, err := GraphReset("/tmp", "abc123", "invalid"); err == nil {
		t.Error("非法 mode 应报错")
	}
	if _, err := GraphReset("", "abc123", "hard"); err == nil {
		t.Error("空目录应报错")
	}
}

func TestGraphCherryPickInvalidSha(t *testing.T) {
	if _, err := GraphCherryPick("/tmp", "-evil"); err == nil {
		t.Error("以 - 开头的 sha 应报错")
	}
	if _, err := GraphCherryPick("/tmp", "not-a-sha"); err == nil {
		t.Error("非十六进制 sha 应报错")
	}
	if _, err := GraphCherryPick("", "abc123"); err == nil {
		t.Error("空目录应报错")
	}
}

// ===== 集成测试（无 git 时 skip） =====

func TestGraphCommitsIntegration(t *testing.T) {
	dir := setupTestRepo(t)
	if dir == "" {
		t.Skip("无法创建测试仓库")
	}
	page, err := GraphCommits(dir, "", 10, 0)
	if err != nil {
		t.Fatalf("GraphCommits 失败：%v", err)
	}
	if !page.Available {
		t.Fatalf("Available=false，Reason=%s", page.Reason)
	}
	if len(page.Commits) == 0 {
		t.Fatal("提交列表为空")
	}
	// 验证泳道已分配
	for i, c := range page.Commits {
		if c.Lane < 0 {
			t.Errorf("行 %d：Lane=%d < 0", i, c.Lane)
		}
		if c.Sha == "" {
			t.Errorf("行 %d：Sha 为空", i)
		}
	}
}

func TestGraphRefsIntegration(t *testing.T) {
	dir := setupTestRepo(t)
	if dir == "" {
		t.Skip("无法创建测试仓库")
	}
	res, err := GraphRefs(dir)
	if err != nil {
		t.Fatalf("GraphRefs 失败：%v", err)
	}
	if !res.Available {
		t.Fatalf("Available=false，Reason=%s", res.Reason)
	}
	if res.HeadSha == "" {
		t.Error("HeadSha 为空")
	}
}

// setupTestRepo 创建临时 git 仓库并返回路径；失败返回空串（调用方 skip）。
func setupTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	// 初始化仓库
	if _, code, err := gitRun(dir, []string{"init"}, 5000); err != nil || code != 0 {
		return ""
	}
	// 配置用户（避免 commit 失败）
	gitRun(dir, []string{"config", "user.email", "test@test.com"}, 5000)
	gitRun(dir, []string{"config", "user.name", "Test"}, 5000)
	// 创建一个文件并提交
	if err := osWriteFile(dir+"/test.txt", []byte("hello")); err != nil {
		return ""
	}
	if _, code, err := gitRun(dir, []string{"add", "."}, 5000); err != nil || code != 0 {
		return ""
	}
	if _, code, err := gitRun(dir, []string{"commit", "-m", "initial"}, 5000); err != nil || code != 0 {
		return ""
	}
	return dir
}

// osWriteFile 是 os.WriteFile 的别名（避免测试文件直接 import os）。
func osWriteFile(path string, data []byte) error {
	return osWriteFileImpl(path, data)
}

func osWriteFileImpl(path string, data []byte) error {
	return os.WriteFile(path, data, 0o644)
}
