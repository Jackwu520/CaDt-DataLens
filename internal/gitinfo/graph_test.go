// graph_test.go：Git 图谱引擎测试——字形流解析器（Gitea 移植）用例 + 字形→路径压缩用例
// + porcelain 解析 + 写操作参数校验。字形/路径用例不依赖 git 环境（纯函数）；
// 集成用例（GraphCommits/GraphRefs）无 git 时 skip。
package gitinfo

import (
	"os"
	"strings"
	"testing"
)

// ===== 字形解析器测试（用真实 git --graph 输出的字形行） =====

// feedRows 逐行喂给解析器，返回每行的 (字形, flow) 快照。
func feedRows(rows []string) []struct {
	glyphs string
	flows  []int64
} {
	p := newGlyphParser()
	out := make([]struct {
		glyphs string
		flows  []int64
	}, 0, len(rows))
	for _, r := range rows {
		p.parse([]byte(r))
		out = append(out, struct {
			glyphs string
			flows  []int64
		}{string(p.glyphs), append([]int64{}, p.flows...)})
	}
	return out
}

func TestGlyphParserLinear(t *testing.T) {
	// 直线历史：每行一个 `*`，主链 flow 恒为 1
	rows := []string{"*   ", "*   ", "*   "}
	snap := feedRows(rows)
	for i, s := range snap {
		if s.flows[0] != 1 {
			t.Errorf("行 %d 的主链 flow=%d，期望 1", i, s.flows[0])
		}
	}
}

func TestGlyphParserForkMerge(t *testing.T) {
	// 分叉合并（真实 lab 仓库输出）：
	//   *      m3
	//   *      merge B（第二父分叉）
	//   |\     关系行：分叉边过渡
	//   * |    m2
	//   | *    b2（分支提交，另一 flow）
	//   | *    b1
	//   |/     关系行：分支汇回主线
	//   *      merge A
	rows := []string{
		"*   ",
		"*   ",
		"|\\  ",
		"* | ",
		"| * ",
		"| * ",
		"|/  ",
		"*   ",
	}
	snap := feedRows(rows)
	// merge B 行（idx=1）：分叉边在关系行（idx=2）才出现，pos1，新 flow=2
	if snap[2].flows[1] != 2 {
		t.Errorf("分叉边 flow=%d，期望 2", snap[2].flows[1])
	}
	// b2/b1 在 pos2（lane 1），flow=2
	if snap[4].flows[2] != 2 {
		t.Errorf("分支提交 flow=%d，期望 2", snap[4].flows[2])
	}
	// 汇入行（idx=6）：`/` 在 pos1 继承分支 flow，主线在 pos0 保持 flow=1
	if snap[6].flows[0] != 1 || snap[6].flows[1] != 2 {
		t.Errorf("汇入行 flows=%v，期望 [1 2]", snap[6].flows[:2])
	}
	// 汇入后（idx=7）：只剩主线 flow=1
	if snap[7].flows[0] != 1 {
		t.Errorf("汇入后主线 flow=%d，期望 1", snap[7].flows[0])
	}
}

func TestGlyphParserBraid(t *testing.T) {
	// 连续三个 merge 的「辫子区」（Starrail Workshop 仓库真实输出）：
	//   *      merge A
	//   |\     关系行
	//   * \    merge B
	//   |\ \   关系行
	//   * \ \  merge C
	//   |\ \ \ 关系行
	//   | | | * feat(items)（merge A 的分支尖）
	rows := []string{
		"*   ",
		"|\\  ",
		"* \\   ",
		"|\\ \\  ",
		"* \\ \\   ",
		"|\\ \\ \\  ",
		"| | | * ",
	}
	snap := feedRows(rows)
	// 分叉边 flow：merge A 的边在 r1 新生（F2）；merge B 的边在 r3 新生（F3）；
	// merge C 的边在 r5 新生（F4）。几何上逐行右移一格（r4 pos4 是 merge A 边的延续）。
	if snap[2].flows[2] != 2 {
		t.Errorf("merge A 分叉边 flow=%d，期望 2", snap[2].flows[2])
	}
	if snap[4].flows[2] != 3 {
		t.Errorf("merge B 分叉边 flow=%d，期望 3", snap[4].flows[2])
	}
	if snap[6].flows[6] != 2 {
		t.Errorf("feat(items) flow=%d，期望 2（merge A 的分支尖，边被后续 merge 逐行右移到 lane3）", snap[6].flows[6])
	}
	// 主线恒为 flow 1
	for i, s := range snap {
		if s.flows[0] != 1 {
			t.Errorf("行 %d 主线 flow=%d，期望 1", i, s.flows[0])
		}
	}
}

// ===== 字形组 → flow 路径压缩测试 =====

// parseGlyphPage 把整页字形行喂给 buildGraphPage 的底层（模拟 GraphCommits 的解析循环）。
// 这里直接构造 raw 输出（\x1e 标记数据区），复用 buildGraphPage。
func TestBuildGraphPageForkMergePaths(t *testing.T) {
	const RS = ""
	const US = ""
	sha := func(c byte) string { return strings.Repeat(string(c), 40) }
	mk := func(glyph string, shaChar byte, subject string) string {
		return glyph + RS + sha(shaChar) + US + "" + US + "" + US + "" + US + "" + US + "1700000000" + US + subject
	}
	raw := strings.Join([]string{
		mk("*   ", 'e', "m3"),
		mk("*   ", 'd', "merge B"),
		"|\\  ",
		mk("* | ", 'c', "m2"),
		mk("| * ", 'b', "b2"),
		mk("| * ", 'a', "b1"),
		"|/  ",
		mk("*   ", '9', "merge A"),
	}, "\n") + "\n"

	commits, laneCount, hasMore, nextSkip := buildGraphPage(raw, 500, 0)
	if len(commits) != 6 {
		t.Fatalf("解析出 %d 个提交，期望 6", len(commits))
	}
	if laneCount != 2 {
		t.Errorf("laneCount=%d，期望 2", laneCount)
	}
	if hasMore || nextSkip != 0 {
		t.Errorf("hasMore=%v nextSkip=%d，期望 false/0", hasMore, nextSkip)
	}

	// merge B（idx=1）：组含提交行 + 关系行（rows=2），字形带分叉斜线
	mergeB := commits[1]
	if mergeB.Rows != 2 {
		t.Errorf("merge B rows=%d，期望 2（提交行+关系行）", mergeB.Rows)
	}
	if mergeB.DotPos != 0 || mergeB.DotFlow != 1 {
		t.Errorf("merge B dot=(%d,%d)，期望 (0,1)", mergeB.DotPos, mergeB.DotFlow)
	}
	hasFork := false
	for _, g := range mergeB.Glyphs {
		if g.Ch == "\\" && g.R == 1 && g.Pos == 1 && g.Flow == 2 {
			hasFork = true
		}
	}
	if !hasFork {
		t.Errorf("merge B 组内应有分叉斜线字形 (r=1,pos=1,flow=2)，glyphs=%v", mergeB.Glyphs)
	}

	// b1（分支最后一个提交，idx=4）：圆点在 pos2 / flow2；汇入斜线归在它的组（`|/` 关系行）
	b1 := commits[4]
	if b1.DotPos != 2 || b1.DotFlow != 2 {
		t.Errorf("b1 dot=(%d,%d)，期望 (2,2)", b1.DotPos, b1.DotFlow)
	}
	hasJoin := false
	for _, g := range b1.Glyphs {
		if g.Ch == "/" && g.R == 1 && g.Pos == 1 && g.Flow == 2 {
			hasJoin = true
		}
	}
	if !hasJoin {
		t.Errorf("b1 组内应有汇入斜线字形 (r=1,pos=1,flow=2)，glyphs=%v", b1.Glyphs)
	}

	// merge A（最后一组）：主线圆点 flow1
	last := commits[len(commits)-1]
	if last.DotPos != 0 || last.DotFlow != 1 {
		t.Errorf("merge A dot=(%d,%d)，期望 (0,1)", last.DotPos, last.DotFlow)
	}
}

func TestBuildGraphPagePaging(t *testing.T) {
	const RS = "\x1e"
	const US = "\x1f"
	sha := func(c byte) string { return strings.Repeat(string(c), 40) }
	mk := func(c byte) string {
		return "*   " + RS + sha(c) + US + "" + US + "" + US + "" + US + "" + US + "1700000000" + US + "c" + string(rune(c))
	}
	// 第一页：git -n limit+1 多取一条探测 hasMore，返回 4 个提交的行 → 截断为 3 + hasMore
	raw1 := strings.Join([]string{mk('f'), mk('e'), mk('d'), mk('c')}, "\n") + "\n"
	commits, _, hasMore, nextSkip := buildGraphPage(raw1, 3, 0)
	if len(commits) != 3 || !hasMore || nextSkip != 3 {
		t.Errorf("分页结果 len=%d hasMore=%v skip=%d，期望 3/true/3", len(commits), hasMore, nextSkip)
	}
	// 第二页：git --skip=3 -n 3 只返回剩下 2 个提交的行
	raw2 := strings.Join([]string{mk('b'), mk('a')}, "\n") + "\n"
	commits, _, hasMore, _ = buildGraphPage(raw2, 3, 3)
	if len(commits) != 2 || hasMore {
		t.Errorf("第二页 len=%d hasMore=%v，期望 2/false", len(commits), hasMore)
	}
}

// ===== porcelain 解析测试（name-status / 冲突文件） =====

func TestParseNameStatusZ(t *testing.T) {
	out := "M\x00src/a.js\x00A\x00src/new.js\x00D\x00src/old.js\x00R100\x00src/rename-before.js\x00src/rename-after.js\x00"
	files := parseNameStatusZ(out)
	if len(files) != 4 {
		t.Fatalf("解析出 %d 条，期望 4 条", len(files))
	}
	if files[0].Path != "src/a.js" || files[0].Status != "M" {
		t.Errorf("files[0]=%+v", files[0])
	}
	if files[1].Status != "A" {
		t.Errorf("files[1].Status=%s", files[1].Status)
	}
	if files[2].Status != "D" {
		t.Errorf("files[2].Status=%s", files[2].Status)
	}
	if files[3].Status != "R" || files[3].OldPath != "src/rename-before.js" || files[3].Path != "src/rename-after.js" {
		t.Errorf("files[3]=%+v", files[3])
	}
	// 应按路径排序：src/a.js < src/new.js < src/old.js < src/rename-after.js
	for i := 1; i < len(files); i++ {
		if files[i-1].Path >= files[i].Path {
			t.Errorf("未按路径排序：%s >= %s", files[i-1].Path, files[i].Path)
		}
	}
}

func TestParseCheckoutConflictFiles(t *testing.T) {
	out := "error: Your local changes to the following files would be overwritten by checkout:\n" +
		"\tsrc/http.js\n\tconfig/storyFilm.js\n" +
		"Please commit your changes or stash them before you switch branches.\nAborting\n"
	files := parseCheckoutConflictFiles(out)
	if len(files) != 2 {
		t.Fatalf("解析出 %d 个文件，期望 2 个：%v", len(files), files)
	}
	if files[0] != "src/http.js" || files[1] != "config/storyFilm.js" {
		t.Errorf("files=%v", files)
	}
	if got := parseCheckoutConflictFiles("Switched to branch 'master'"); len(got) != 0 {
		t.Errorf("正常输出不应解析出冲突文件：%v", got)
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

func TestGraphCommitBodyInvalidSha(t *testing.T) {
	if _, err := GraphCommitBody("/tmp", "-evil"); err == nil {
		t.Error("以 - 开头的 sha 应报错")
	}
	if _, err := GraphCommitBody("/tmp", "not-a-sha"); err == nil {
		t.Error("非十六进制 sha 应报错")
	}
	if _, err := GraphCommitBody("", "abc123"); err == nil {
		t.Error("空目录应报错")
	}
}

func TestGraphCreateBranchInvalidArgs(t *testing.T) {
	if _, err := GraphCreateBranch("/tmp", "-evil", "abc123", true); err == nil {
		t.Error("以 - 开头的分支名应报错")
	}
	if _, err := GraphCreateBranch("/tmp", "feat/x", "-evil", false); err == nil {
		t.Error("以 - 开头的 sha 应报错")
	}
	if _, err := GraphCreateBranch("/tmp", "feat/x", "not-a-sha", false); err == nil {
		t.Error("非十六进制 sha 应报错")
	}
	if _, err := GraphCreateBranch("", "feat/x", "abc123", false); err == nil {
		t.Error("空目录应报错")
	}
}

func TestGraphCheckoutSmartInvalidRef(t *testing.T) {
	if _, err := GraphCheckoutSmart("/tmp", "-evil"); err == nil {
		t.Error("以 - 开头的 ref 应报错")
	}
	if _, err := GraphCheckoutSmart("", "master"); err == nil {
		t.Error("空目录应报错")
	}
}

func TestGraphCheckoutForceInvalidRef(t *testing.T) {
	if _, err := GraphCheckoutForce("/tmp", "-evil"); err == nil {
		t.Error("以 - 开头的 ref 应报错")
	}
	if _, err := GraphCheckoutForce("", "master"); err == nil {
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
	// 验证圆点字形位与组内字形表
	for i, c := range page.Commits {
		if c.DotPos < 0 {
			t.Errorf("行 %d：DotPos=%d < 0", i, c.DotPos)
		}
		if c.DotFlow <= 0 {
			t.Errorf("行 %d：DotFlow=%d 非法", i, c.DotFlow)
		}
		if c.Rows <= 0 || len(c.Glyphs) == 0 {
			t.Errorf("行 %d：Rows=%d Glyphs=%d 非法", i, c.Rows, len(c.Glyphs))
		}
		if c.Sha == "" {
			t.Errorf("行 %d：Sha 为空", i)
		}
	}
}

func TestGraphCommitBodyIntegration(t *testing.T) {
	dir := setupTestRepo(t)
	if dir == "" {
		t.Skip("无法创建测试仓库")
	}
	page, err := GraphCommits(dir, "", 1, 0)
	if err != nil || !page.Available || len(page.Commits) == 0 {
		t.Fatalf("GraphCommits 失败：%v", err)
	}
	body, err := GraphCommitBody(dir, page.Commits[0].Sha)
	if err != nil {
		t.Fatalf("GraphCommitBody 失败：%v", err)
	}
	// setupTestRepo 的提交正文为空
	if body != "" {
		t.Errorf("正文=%q，期望空", body)
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
