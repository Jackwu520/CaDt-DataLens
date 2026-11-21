package main

import "testing"

func TestResolveUvCandidates(t *testing.T) {
	tests := []struct {
		name string
		home string
		want []string
	}{
		{name: "空主目录返回空表", home: "", want: nil},
		{
			// Windows 官方安装器装的是 uv.exe，os.Stat 不做 PATHEXT 解析——候选必须显式带扩展名
			name: "常规主目录（exe 优先，无扩展名兜底非 Windows）",
			home: `C:\Users\u`,
			want: []string{`C:\Users\u\.local\bin\uv.exe`, `C:\Users\u\.local\bin\uv`},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveUvCandidates(tt.home)
			if len(got) != len(tt.want) {
				t.Fatalf("候选数 = %d, 期望 %d（%v）", len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("候选[%d] = %q, 期望 %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// MCPDesktopDoctor 是纯读绑定：不执行子进程、不写盘。这里只做冒烟——能跑通、
// 字段自洽（UVFound 时必带路径；候选路径非空）。
func TestMCPDesktopDoctorSmoke(t *testing.T) {
	app := &App{}
	result := app.MCPDesktopDoctor()
	if result.UVFound && result.UVPath == "" {
		t.Fatalf("UVFound=true 但 UVPath 为空")
	}
	if !result.UVFound && !result.UVHomeFound && len(result.Hints) == 0 {
		t.Fatalf("两处都未找到 uv 时必须给出安装提示")
	}
}
