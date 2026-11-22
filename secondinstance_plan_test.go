package main

// secondinstance_plan_test.go：secondInstancePlan（转发参数 → 动作计划）与
// routeWindowForPath（文件 → 归属工作区窗口）的表驱动测试。
// secondInstance 本体只碰窗口 API（winReg / emit），不可单测；决策语义全部钉在这里。
// 修正语义对应方案 docs/unfinished-plans/cli-startup-args-refresh.md §3.4（B/C/D/E）。

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"datalens/internal/launchargs"
)

// resolveStub 测试注入的会话归属解析：sess-1 → D:/proj，其余报错（sess-empty 归属未知）。
func resolveStub(id string) (string, error) {
	if id == "sess-1" {
		return "D:/proj", nil
	}
	if id == "sess-empty" {
		return "", nil
	}
	return "", errors.New("session-gone")
}

// routeStub 模拟祖先链路由语义（真实实现的专项测试见 TestRouteWindowForPath）：
// main-2 管最深子工作区 D:\proj\sub，main 管 D:\proj，其余无归属。
func routeStub(p string) string {
	key := strings.ToLower(strings.ReplaceAll(p, "\\", "/"))
	switch {
	case strings.HasPrefix(key, "d:/proj/sub"):
		return "main-2"
	case strings.HasPrefix(key, "d:/proj"):
		return "main"
	default:
		return ""
	}
}

func TestSecondInstancePlan(t *testing.T) {
	projFile := "D:/proj/a.json"
	subFile := "D:/proj/sub/x.json"
	otherFile := "D:/else/b.json"
	cases := []struct {
		name  string
		args  []string
		route func(string) string
		want  forwardPlan
	}{
		{"quit", []string{"--quit"}, nil, forwardPlan{kind: "quit"}},
		{"float-with-targets", []string{"--ai-float", projFile}, nil,
			forwardPlan{kind: "float", targets: []launchargs.OpenTarget{{Path: projFile}}}},
		{"float-bare", []string{"--ai-float"}, nil,
			forwardPlan{kind: "float", targets: []launchargs.OpenTarget{}}},
		{"debug", []string{"--debug-console"}, nil, forwardPlan{kind: "debug"}},
		// 缺陷 B：单独 --ai-session → 解析归属走 sessionOpen；失败只前置。
		{"session-open", []string{"--ai-session=sess-1"}, nil,
			forwardPlan{kind: "sessionOpen", sessionID: "sess-1", workspace: "D:/proj"}},
		{"session-gone-show", []string{"--ai-session=gone"}, nil, forwardPlan{kind: "show"}},
		{"session-empty-ws-show", []string{"--ai-session=sess-empty"}, nil, forwardPlan{kind: "show"}},
		// 审查 P2-3：会话解析失败不吞同命令行的定点分支（settings/memo 仍生效）；
		// 会话解析成功则 sessionOpen 优先（转发路径二选一，与冷启动并存语义的差异记方案 §7）。
		{"session-gone-settings-fallthrough", []string{"--ai-session=gone", "--open-settings=ai"}, nil,
			forwardPlan{kind: "settings", pane: "ai", targets: []launchargs.OpenTarget{}}},
		{"session-open-overrides-settings", []string{"--ai-session=sess-1", "--open-settings=ai"}, nil,
			forwardPlan{kind: "sessionOpen", sessionID: "sess-1", workspace: "D:/proj"}},
		// 审查 P3-4：--new-window + --ai-session（无文件）走 sessionOpen 同工作区复用
		//（「同一工作区禁止双开」裁定），--new-window 被忽略。
		{"session-open-ignores-new-window", []string{"--new-window", "--ai-session=sess-1"}, nil,
			forwardPlan{kind: "sessionOpen", sessionID: "sess-1", workspace: "D:/proj"}},
		{"settings", []string{"--open-settings=ai"}, nil,
			forwardPlan{kind: "settings", pane: "ai", targets: []launchargs.OpenTarget{}}},
		// 缺陷 D：定点打开不再吞掉同命令行的文件目标。
		{"settings-with-files", []string{"--open-settings=ai", projFile}, nil,
			forwardPlan{kind: "settings", pane: "ai",
				targets: []launchargs.OpenTarget{{Path: projFile}}}},
		{"memo", []string{"--memo=cadt-memo://workspace/item/it-1"}, nil,
			forwardPlan{kind: "memo", locator: "cadt-memo://workspace/item/it-1",
				targets: []launchargs.OpenTarget{}}},
		{"memo-with-files", []string{"--memo=cadt-memo://workspace/item/it-1", projFile}, nil,
			forwardPlan{kind: "memo", locator: "cadt-memo://workspace/item/it-1",
				targets: []launchargs.OpenTarget{{Path: projFile}}}},
		// 缺陷 C：--ai-session + 文件转发 → deliver 且带会话归属（供执行层比对窗口）。
		{"deliver-session-match", []string{"--ai-session=sess-1", projFile}, nil,
			forwardPlan{kind: "deliver", sessionID: "sess-1", workspace: "D:/proj",
				groups: []targetGroup{{targets: []launchargs.OpenTarget{{Path: projFile}}}}}},
		{"deliver-session-gone", []string{"--ai-session=gone", projFile}, nil,
			forwardPlan{kind: "deliver",
				groups: []targetGroup{{targets: []launchargs.OpenTarget{{Path: projFile}}}}}},
		{"new-window", []string{"--new-window", projFile}, nil,
			forwardPlan{kind: "newWindow", targets: []launchargs.OpenTarget{{Path: projFile}}}},
		{"new-window-with-session", []string{"--new-window", "D:/proj", "--ai-session=sess-1"}, nil,
			forwardPlan{kind: "newWindow", sessionID: "sess-1",
				targets: []launchargs.OpenTarget{{Path: "D:/proj"}}}},
		// 无路由依赖：全部目标进主窗口组（旧单窗口行为等价）。
		{"deliver-plain", []string{projFile}, nil,
			forwardPlan{kind: "deliver",
				groups: []targetGroup{{targets: []launchargs.OpenTarget{{Path: projFile}}}}}},
		{"deliver-line-column", []string{"--line", "9", projFile}, nil,
			forwardPlan{kind: "deliver",
				groups: []targetGroup{{targets: []launchargs.OpenTarget{{Path: projFile, Line: 9}}}}}},
		// 缺陷 E：文件按所属工作区路由分组，无归属目标进主窗口组。
		{"deliver-routed-groups", []string{subFile, projFile, otherFile}, routeStub,
			forwardPlan{kind: "deliver", groups: []targetGroup{
				{windowName: "main-2", targets: []launchargs.OpenTarget{{Path: subFile}}},
				{windowName: "main", targets: []launchargs.OpenTarget{{Path: projFile}}},
				{windowName: "", targets: []launchargs.OpenTarget{{Path: otherFile}}},
			}}},
		{"deliver-routed-with-session", []string{"--ai-session=sess-1", subFile}, routeStub,
			forwardPlan{kind: "deliver", sessionID: "sess-1", workspace: "D:/proj",
				groups: []targetGroup{
					{windowName: "main-2", targets: []launchargs.OpenTarget{{Path: subFile}}},
				}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := secondInstancePlan(tc.args, forwardDeps{
				resolveSessionWorkspace: resolveStub,
				routeWindowForPath:      tc.route,
			})
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("secondInstancePlan(%v) = %+v, want %+v", tc.args, got, tc.want)
			}
		})
	}
}

func TestSecondInstancePlanBareArgsDeliversCwd(t *testing.T) {
	// 裸转发（无任何参数）维持现状：CWD 兜底成打开目标投主窗口
	//（sessionOpen 分支已接管 --ai-session 场景，不会再落到这里）。
	want := launchargs.StartupCwdTarget()
	if len(want) == 0 {
		t.Skip("测试 CWD 等于 exe 目录（StartupCwdTarget 返回空），跳过")
	}
	got := secondInstancePlan(nil, forwardDeps{resolveSessionWorkspace: resolveStub})
	if got.kind != "deliver" || len(got.groups) != 1 ||
		!reflect.DeepEqual(got.groups[0].targets, want) || got.groups[0].windowName != "" {
		t.Fatalf("bare args = %+v, want deliver with primary group targets %+v", got, want)
	}
}

func TestRouteWindowForPath(t *testing.T) {
	// winReg 夹具用真实临时目录：main=root，main-2=root\sub（嵌套工作区）；
	// 同工作区的浮窗不参与路由（findByWorkspace 只认 main 模式）。
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	winReg.add(windowSpec{Name: "main", Mode: windowModeMain, Workspace: root})
	winReg.add(windowSpec{Name: "main-2", Mode: windowModeMain, Workspace: sub})
	winReg.add(windowSpec{Name: "float", Mode: windowModeFloat, Workspace: root})
	t.Cleanup(func() {
		winReg.remove("main")
		winReg.remove("main-2")
		winReg.remove("float")
	})
	inside := filepath.Join(sub, "x.json")
	top := filepath.Join(root, "other.json")
	for _, f := range []string{inside, top} {
		if err := os.WriteFile(f, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		path string
		want string
	}{
		{inside, "main-2"}, // 祖先链最深命中（内层窗口拿子目录文件）
		{top, "main"},      // 外层工作区
		{sub, ""},          // 存在的目录目标不路由（主窗口组）
		{root, ""},         // 工作区根本身（目录）不路由
		{filepath.Join(sub, "missing.json"), "main-2"}, // 不存在按文件：从所在目录起爬
		{filepath.Join(root, "missing.json"), "main"},
		{filepath.Join(root, "subX", "a.json"), "main"}, // 兄弟目录不误命中（精确相等口径）
		{"a.json", ""},    // 相对路径无归属
		{`C:\a.json`, ""}, // 盘根终止：c: → c:. 链路收敛（审查 P3-6）
	}
	for _, tc := range cases {
		if got := routeWindowForPath(tc.path); got != tc.want {
			t.Errorf("routeWindowForPath(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}
