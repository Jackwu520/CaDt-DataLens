package main

import "testing"

func TestGeometryRestoreKey(t *testing.T) {
	cases := []struct {
		name      string
		spec      windowSpec
		modeCount int
		wantKey   string
		wantCasc  int
	}{
		{"AI 浮窗", windowSpec{Name: "float", Mode: windowModeFloat}, 0, "float", 0},
		{"调试控制台", windowSpec{Name: "debug", Mode: windowModeDebug}, 0, "debug", 0},
		{"非规范浮窗名不持久化", windowSpec{Name: "float-2", Mode: windowModeFloat}, 0, "", 0},
		{"首个主窗口", windowSpec{Name: "main", Mode: windowModeMain}, 1, "main", 0},
		{"第二个主窗口", windowSpec{Name: "main-2", Mode: windowModeMain}, 2, "main", 1},
		{"第三个主窗口", windowSpec{Name: "main-3", Mode: windowModeMain}, 3, "main", 2},
		{"计数异常按首个处理", windowSpec{Name: "main", Mode: windowModeMain}, 0, "main", 0},
		{"首个终端窗口", windowSpec{Name: "term", Mode: windowModeTerminal}, 1, "terminal", 0},
		{"第二个终端窗口", windowSpec{Name: "term-2", Mode: windowModeTerminal}, 2, "terminal", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key, cascade := geometryRestoreKey(tc.spec, tc.modeCount)
			if key != tc.wantKey || cascade != tc.wantCasc {
				t.Fatalf("geometryRestoreKey() = (%q, %d), want (%q, %d)",
					key, cascade, tc.wantKey, tc.wantCasc)
			}
		})
	}
}

func TestGeometryPersistKey(t *testing.T) {
	cases := []struct {
		name      string
		spec      windowSpec
		isPrimary bool
		want      string
	}{
		{"AI 浮窗", windowSpec{Name: "float", Mode: windowModeFloat}, false, "float"},
		{"调试控制台", windowSpec{Name: "debug", Mode: windowModeDebug}, false, "debug"},
		{"终端独立窗口", windowSpec{Name: "term", Mode: windowModeTerminal}, false, "terminal"},
		{"主窗口是 primary", windowSpec{Name: "main", Mode: windowModeMain}, true, "main"},
		{"额外主窗口不覆盖", windowSpec{Name: "main-2", Mode: windowModeMain}, false, ""},
		{"非规范浮窗名", windowSpec{Name: "float-2", Mode: windowModeFloat}, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := geometryPersistKey(tc.spec, tc.isPrimary); got != tc.want {
				t.Fatalf("geometryPersistKey() = %q, want %q", got, tc.want)
			}
		})
	}
}
