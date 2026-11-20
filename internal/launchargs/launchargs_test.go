package launchargs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFirstPathArgSkipsExeAndFlags(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "a.json")
	if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
		t.Fatal(err)
	}
	exe, _ := os.Executable()
	if got := FirstPathArg([]string{exe, "-flag", dir, f}); got != dir {
		t.Fatalf("got %q, want %q", got, dir)
	}
	if got := FirstPathArg([]string{"-x"}); got != "" {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestPathArgsKeepsFilesAndDirs(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.json")
	b := filepath.Join(dir, "b.yaml")
	for _, f := range []string{a, b} {
		if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	got := PathArgs([]string{"-flag", a, dir, b})
	if len(got) != 3 || got[0] != a || got[1] != dir || got[2] != b {
		t.Fatalf("pathArgs = %v, want [%s %s %s]", got, a, dir, b)
	}
}

func TestParseOpenTargets(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.json")
	b := filepath.Join(dir, "b.json")
	for _, f := range []string{a, b} {
		if err := os.WriteFile(f, []byte("{}"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	exe, _ := os.Executable()
	cases := []struct {
		name  string
		args  []string
		path  string
		line  int
		col   int
		count int
	}{
		{"plain", []string{a}, a, 0, 0, 1},
		{"line-suffix", []string{a + ":12"}, a, 12, 0, 1},
		{"line-column", []string{a + ":12:7"}, a, 12, 7, 1},
		{"line-flag-before", []string{"--line", "9", a}, a, 9, 0, 1},
		{"line-flag-after", []string{a, "--line=8"}, a, 8, 0, 1},
		{"goto", []string{"-g", a + ":3"}, a, 3, 0, 1},
		{"column-and-line", []string{"--column", "4", "--line", "6", a}, a, 6, 4, 1},
		{"skip-exe-and-flags", []string{exe, "-flag", a}, a, 0, 0, 1},
		{"invalid-number", []string{a + ":abc"}, "", 0, 0, 0},
		{"missing-file", []string{filepath.Join(dir, "missing.json") + ":2"}, "", 0, 0, 0},
		{"multiple", []string{a + ":2", b + ":3"}, a, 2, 0, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseOpenTargets(tc.args)
			if len(got) != tc.count {
				t.Fatalf("parseOpenTargets(%v) count = %d, want %d: %+v", tc.args, len(got), tc.count, got)
			}
			if tc.count == 0 {
				return
			}
			if got[0].Path != tc.path || got[0].Line != tc.line || got[0].Column != tc.col {
				t.Fatalf("parseOpenTargets(%v) first = %+v, want %s:%d:%d", tc.args, got[0], tc.path, tc.line, tc.col)
			}
		})
	}
}

func TestStartupCwdTarget(t *testing.T) {
	tmp := t.TempDir()
	orig, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(orig)

	exeDir := filepath.Dir(mustSelfPath(t))

	if err := os.Chdir(exeDir); err != nil {
		t.Skip("无法 chdir 到 exe 目录")
	}
	if targets := StartupCwdTarget(); len(targets) != 0 {
		t.Fatalf("exe 目录内应返回空: %+v", targets)
	}

	if err := os.Chdir(tmp); err != nil {
		t.Fatal(err)
	}
	targets := StartupCwdTarget()
	if len(targets) != 1 || targets[0].Path != tmp {
		t.Fatalf("应返回 cwd 工作区: %+v (want %s)", targets, tmp)
	}
}

func mustSelfPath(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

func TestParseOpenSettingsArg(t *testing.T) {
	cases := map[string]string{
		"":                                "",
		"--new-window":                    "",
		"--open-settings=models":          "models",
		"--new-window --open-settings=ai": "ai",
		"--open-settings":                 "",
	}
	for args, want := range cases {
		if got := ParseOpenSettingsArg(strings.Fields(args)); got != want {
			t.Fatalf("parseOpenSettingsArg(%q) = %q, want %q", args, got, want)
		}
	}
}

func TestParseAISessionArg(t *testing.T) {
	cases := map[string]string{
		"":                         "",
		"--new-window":             "",
		"--ai-session=session-abc": "session-abc",
		"--new-window C:\\tmp --ai-session=session-abc": "session-abc",
		"--ai-session=": "",
		"--ai-session":  "",
	}
	for args, want := range cases {
		if got := ParseAISessionArg(strings.Fields(args)); got != want {
			t.Fatalf("parseAISessionArg(%q) = %q, want %q", args, got, want)
		}
	}
}

func TestParseMemoLocatorArg(t *testing.T) {
	got := ParseMemoLocatorArg([]string{"--memo=cadt-memo://workspace/item/it-abc"})
	if got != "cadt-memo://workspace/item/it-abc" {
		t.Fatalf("got %q", got)
	}
	if got := ParseMemoLocatorArg([]string{"--memo="}); got != "" {
		t.Fatalf("空值应返回空串，got %q", got)
	}
	if got := ParseMemoLocatorArg([]string{"file.json"}); got != "" {
		t.Fatalf("无 --memo 应返回空串，got %q", got)
	}
}
