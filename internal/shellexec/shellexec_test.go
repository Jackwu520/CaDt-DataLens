//go:build windows

package shellexec

import "testing"

// RevealInFolder 交给 explorer.exe 的参数必须用 Windows 原生反斜杠路径：
// 前端归一化后的正斜杠路径会被 explorer 当开关解析，回退打开「文档」文件夹。
func TestRevealArgsUseNativePath(t *testing.T) {
	cases := []struct {
		name  string
		path  string
		isDir bool
		want  []string
	}{
		{"目录正斜杠", "C:/Users/a/AppData/Roaming/CaDt/ai-logs", true,
			[]string{`C:\Users\a\AppData\Roaming\CaDt\ai-logs`}},
		{"目录已是反斜杠", `C:\tmp\logs`, true, []string{`C:\tmp\logs`}},
		{"文件正斜杠走选中", "D:/data/sample.json", false,
			[]string{"/select,", `D:\data\sample.json`}},
		{"尾部斜杠清理", "C:/tmp/logs/", true, []string{`C:\tmp\logs`}},
	}
	for _, c := range cases {
		got := revealArgs(c.path, c.isDir)
		if len(got) != len(c.want) {
			t.Fatalf("%s: revealArgs(%q) = %v, want %v", c.name, c.path, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%s: revealArgs(%q)[%d] = %q, want %q", c.name, c.path, i, got[i], c.want[i])
			}
		}
	}
}
