package windowgeom

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOffset(t *testing.T) {
	got := Offset(Rect{X: 10, Y: 20, Width: 100, Height: 80, Maximised: true}, 28, -5)
	want := Rect{X: 38, Y: 15, Width: 100, Height: 80, Maximised: true}
	if got != want {
		t.Fatalf("Offset = %+v, want %+v", got, want)
	}
}

func TestNormalize(t *testing.T) {
	primary := Rect{X: 0, Y: 0, Width: 1920, Height: 1080}
	secondary := Rect{X: 1920, Y: 0, Width: 1920, Height: 1080}
	areas := []Rect{primary, secondary}

	cases := []struct {
		name string
		in   Rect
		minW int
		minH int
		want Rect
	}{
		{
			name: "已可见不动",
			in:   Rect{X: 200, Y: 100, Width: 800, Height: 600},
			minW: 320, minH: 200,
			want: Rect{X: 200, Y: 100, Width: 800, Height: 600},
		},
		{
			name: "副屏位置保留",
			in:   Rect{X: 2000, Y: 120, Width: 800, Height: 600},
			minW: 320, minH: 200,
			want: Rect{X: 2000, Y: 120, Width: 800, Height: 600},
		},
		{
			name: "屏幕没了主屏居中",
			in:   Rect{X: 5000, Y: 3000, Width: 800, Height: 600},
			minW: 320, minH: 200,
			want: Rect{X: 560, Y: 240, Width: 800, Height: 600},
		},
		{
			name: "屏幕没了且尺寸超界先收敛",
			in:   Rect{X: 5000, Y: 3000, Width: 3000, Height: 2000},
			minW: 320, minH: 200,
			want: Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
		},
		{
			name: "标题栏在屏外夹回上沿",
			in:   Rect{X: 300, Y: -120, Width: 800, Height: 600},
			minW: 320, minH: 200,
			want: Rect{X: 300, Y: 0, Width: 800, Height: 600},
		},
		{
			name: "尺寸超界收敛到工作区",
			in:   Rect{X: 0, Y: 0, Width: 3000, Height: 2000},
			minW: 320, minH: 200,
			want: Rect{X: 0, Y: 0, Width: 1920, Height: 1080},
		},
		{
			name: "小于最小尺寸补齐",
			in:   Rect{X: 100, Y: 100, Width: 200, Height: 100},
			minW: 320, minH: 200,
			want: Rect{X: 100, Y: 100, Width: 320, Height: 200},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Normalize(tc.in, tc.minW, tc.minH, areas, primary); got != tc.want {
				t.Fatalf("Normalize(%+v) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestNormalizeNoScreens(t *testing.T) {
	// 非 Windows / 查询失败：只收敛最小尺寸，位置原样保留。
	in := Rect{X: -500, Y: -500, Width: 100, Height: 80}
	got := Normalize(in, 320, 200, nil, Rect{})
	want := Rect{X: -500, Y: -500, Width: 320, Height: 200}
	if got != want {
		t.Fatalf("Normalize no screens = %+v, want %+v", got, want)
	}
}

func TestNormalizePreservesMaximised(t *testing.T) {
	primary := Rect{X: 0, Y: 0, Width: 1920, Height: 1080}
	got := Normalize(Rect{X: 10, Y: 10, Width: 800, Height: 600, Maximised: true}, 320, 200, []Rect{primary}, primary)
	if !got.Maximised {
		t.Fatal("Normalize 不应清掉 Maximised")
	}
}

func TestClampVisible(t *testing.T) {
	primary := Rect{X: 0, Y: 0, Width: 1920, Height: 1080}
	areas := []Rect{primary}

	cases := []struct {
		name string
		in   Rect
		want Rect
	}{
		{"已可见不动", Rect{X: 200, Y: 100, Width: 800, Height: 600}, Rect{X: 200, Y: 100, Width: 800, Height: 600}},
		{"屏幕没了居中且不缩放", Rect{X: 5000, Y: 3000, Width: 800, Height: 600}, Rect{X: 560, Y: 240, Width: 800, Height: 600}},
		{"标题栏在屏外只平移", Rect{X: 300, Y: -120, Width: 800, Height: 600}, Rect{X: 300, Y: 0, Width: 800, Height: 600}},
		{"超界尺寸保留", Rect{X: 0, Y: 0, Width: 3000, Height: 2000}, Rect{X: 0, Y: 0, Width: 3000, Height: 2000}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClampVisible(tc.in, areas, primary); got != tc.want {
				t.Fatalf("ClampVisible(%+v) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "window-state.json")
	s := Load(path)
	if _, ok := s.Get("main"); ok {
		t.Fatal("空文件不应有记录")
	}
	if !s.Put("main", Rect{X: 12, Y: 34, Width: 1280, Height: 800}) {
		t.Fatal("首次 Put 应报告变化")
	}
	if s.Put("main", Rect{X: 12, Y: 34, Width: 1280, Height: 800}) {
		t.Fatal("相同值 Put 不应报告变化")
	}
	if err := s.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded := Load(path)
	got, ok := loaded.Get("main")
	if !ok {
		t.Fatal("重新加载后 main 丢失")
	}
	if got != (Rect{X: 12, Y: 34, Width: 1280, Height: 800}) {
		t.Fatalf("重新加载 = %+v", got)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == "" || raw[0] != '{' {
		t.Fatalf("落盘内容不是 JSON 对象：%q", raw)
	}
}

func TestStoreTolerantOfCorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "window-state.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := Load(path)
	if _, ok := s.Get("main"); ok {
		t.Fatal("损坏文件应回落为空存储")
	}
	// 非法矩形（无尺寸）不入内存
	if err := os.WriteFile(path, []byte(`{"version":1,"windows":{"main":{"x":1,"y":2,"width":0,"height":0}}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := Load(path).Get("main"); ok {
		t.Fatal("非法矩形应被忽略")
	}
}

func TestStoreSaveWithoutPath(t *testing.T) {
	s := Load("")
	s.Put("float", Rect{X: 1, Y: 2, Width: 560, Height: 760})
	if err := s.Save(); err != nil {
		t.Fatalf("空路径应静默成功：%v", err)
	}
}
