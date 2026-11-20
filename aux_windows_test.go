package main

// aux_windows_test.go：辅助独立窗（便签/会话监控/文件对比）的注册表查找与
// 入参归一化。窗口不真正创建（createWindow 依赖 wailsApp），只测纯逻辑层。

import "testing"

func TestNormalizeAuxWindowInputs(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"workspace", "workspace", "workspace"},
		{"workspace 带空格", " workspace ", "workspace"},
		{"global", "global", "global"},
		{"未知回落 global", "float", "global"},
		{"空回落 global", "", "global"},
	}
	for _, c := range cases {
		if got := normalizeMemoScope(c.in); got != c.want {
			t.Errorf("%s: normalizeMemoScope(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
	kinds := []struct {
		in, want string
	}{
		{"session", "session"},
		{"group", "group"},
		{" Group ", "group"},
		{"其他", "session"},
		{"", "session"},
	}
	for _, c := range kinds {
		if got := normalizeSessionKind(c.in); got != c.want {
			t.Errorf("normalizeSessionKind(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFindAuxWindows(t *testing.T) {
	added := []*windowState{}
	cleanup := func() {
		for _, st := range added {
			winReg.remove(st.name())
		}
		added = added[:0]
	}
	defer cleanup()

	// 注册表为空：三类查找都落空
	if findMemoWindow("workspace", "D:/ws") != nil {
		t.Fatal("空注册表不该找到便签窗")
	}
	if findMonitorWindow("s1") != nil {
		t.Fatal("空注册表不该找到监控窗")
	}
	if findDiffWindow("a", "b") != nil {
		t.Fatal("空注册表不该找到对比窗")
	}

	added = append(added, winReg.add(windowSpec{Name: "memo", Mode: windowModeMemo, MemoScope: "workspace", Workspace: "D:/ws"}))
	added = append(added, winReg.add(windowSpec{Name: "monitor", Mode: windowModeMonitor, SessionID: "s1", SessionKind: "session"}))
	added = append(added, winReg.add(windowSpec{Name: "diff", Mode: windowModeDiff, DiffLeft: "a", DiffRight: "b"}))
	// 干扰项：主窗口 + 其他形态，不该被误命中
	added = append(added, winReg.add(windowSpec{Name: "main", Mode: windowModeMain, Workspace: "D:/ws"}))

	if st := findMemoWindow("workspace", "D:/ws"); st == nil || st.name() != "memo" {
		t.Fatalf("findMemoWindow 命中错误：%v", st)
	}
	if st := findMemoWindow("workspace", "D:/other"); st != nil {
		t.Fatalf("不同工作区不该命中便签窗：%v", st)
	}
	if st := findMemoWindow("global", ""); st != nil {
		t.Fatalf("不同作用域不该命中便签窗：%v", st)
	}
	if st := findMonitorWindow(" s1 "); st == nil || st.name() != "monitor" {
		t.Fatalf("findMonitorWindow 应容忍空白（实际裁剪）：%v", st)
	}
	if st := findMonitorWindow("s2"); st != nil {
		t.Fatalf("不同会话不该命中监控窗：%v", st)
	}
	if st := findDiffWindow("a", "b"); st == nil || st.name() != "diff" {
		t.Fatalf("findDiffWindow 命中错误：%v", st)
	}
	if st := findDiffWindow("b", "a"); st != nil {
		t.Fatalf("路径对调不该命中同一对比窗：%v", st)
	}
}

func TestAuxWindowGeometryKeys(t *testing.T) {
	cases := []struct {
		mode    windowMode
		name    string
		wantKey string
		persist string
	}{
		{windowModeMemo, "memo", "memo", "memo"},
		{windowModeMemo, "memo-3", "memo", "memo"},
		{windowModeMonitor, "monitor", "monitor", "monitor"},
		{windowModeMonitor, "monitor-2", "monitor", "monitor"},
		{windowModeDiff, "diff", "diff", "diff"},
		{windowModeDiff, "diff-5", "diff", "diff"},
		{windowModeLight, "light", "light", "light"},
		{windowModeLight, "light-2", "light", "light"},
		{windowModePreview, "preview", "preview", "preview"},
		{windowModePreview, "preview-9", "preview", "preview"},
	}
	for _, c := range cases {
		spec := windowSpec{Name: c.name, Mode: c.mode}
		key, _ := geometryRestoreKey(spec, 2)
		if key != c.wantKey {
			t.Errorf("%s/%s restore key = %q, want %q", c.mode, c.name, key, c.wantKey)
		}
		if got := geometryPersistKey(spec, false); got != c.persist {
			t.Errorf("%s/%s persist key = %q, want %q", c.mode, c.name, got, c.persist)
		}
	}
}

func TestFindLightAndPreviewWindows(t *testing.T) {
	added := []*windowState{}
	cleanup := func() {
		for _, st := range added {
			winReg.remove(st.name())
		}
	}
	defer cleanup()

	if findLightWindow("D:/a.md") != nil {
		t.Fatal("空注册表不该找到轻量查看窗")
	}
	if findPreviewWindow("D:/a.md") != nil {
		t.Fatal("空注册表不该找到预览窗")
	}

	added = append(added, winReg.add(windowSpec{Name: "light", Mode: windowModeLight, LightPath: "D:/a.md"}))
	added = append(added, winReg.add(windowSpec{Name: "preview", Mode: windowModePreview, PreviewPath: "D:/a.md", Origin: "main"}))
	added = append(added, winReg.add(windowSpec{Name: "main", Mode: windowModeMain, Workspace: "D:/ws"}))

	if st := findLightWindow(" D:/a.md "); st == nil || st.name() != "light" {
		t.Fatalf("findLightWindow 应容忍空白（实际裁剪）：%v", st)
	}
	if st := findLightWindow("D:/b.md"); st != nil {
		t.Fatalf("不同文件不该命中轻量查看窗：%v", st)
	}
	if st := findPreviewWindow("D:/a.md"); st == nil || st.name() != "preview" {
		t.Fatalf("findPreviewWindow 命中错误：%v", st)
	}
	if st := findPreviewWindow("D:/b.html"); st != nil {
		t.Fatalf("不同源文件不该命中预览窗：%v", st)
	}
}
