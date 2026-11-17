package recycle

// $I 元数据解析的纯逻辑测试（跨平台，不需要真的动系统回收站）。

import (
	"encoding/binary"
	"testing"
	"unicode/utf16"
)

func makeMeta(path string, deletedAt uint64) []byte {
	data := make([]byte, metaFixedSize)
	binary.LittleEndian.PutUint64(data[0:8], metaHeaderVista)
	binary.LittleEndian.PutUint64(data[16:24], deletedAt)
	chars := utf16.Encode([]rune(path + "\x00"))
	buf := make([]byte, len(chars)*2)
	for i, c := range chars {
		binary.LittleEndian.PutUint16(buf[i*2:], c)
	}
	binary.LittleEndian.PutUint32(data[24:28], uint32(len(chars)))
	return append(data, buf...)
}

func TestOriginalPathFromMeta(t *testing.T) {
	want := `D:\工作\随便 a\文件.txt`
	got, err := originalPathFromMeta(makeMeta(want, 123))
	if err != nil {
		t.Fatalf("解析失败：%v", err)
	}
	if got != want {
		t.Fatalf("原路径不符：got %q want %q", got, want)
	}
}

func TestOriginalPathFromMetaRejectsBadData(t *testing.T) {
	cases := []struct {
		name string
		data []byte
	}{
		{"过短", []byte{1, 2, 3}},
		{"非 Vista 格式", func() []byte {
			b := makeMeta(`C:\a.txt`, 0)
			binary.LittleEndian.PutUint64(b[0:8], 1)
			return b
		}()},
		{"路径长度为 0", func() []byte {
			b := makeMeta(`C:\a.txt`, 0)
			binary.LittleEndian.PutUint32(b[24:28], 0)
			return b
		}()},
		{"长度越界", func() []byte {
			b := makeMeta(`C:\a.txt`, 0)
			binary.LittleEndian.PutUint32(b[24:28], 0x7fffffff)
			return b
		}()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := originalPathFromMeta(tc.data); err == nil {
				t.Fatal("应当拒绝异常元数据")
			}
		})
	}
}

func TestDataNameFromMeta(t *testing.T) {
	cases := map[string]string{
		"$IABC123.txt": "$RABC123.txt",
		"$I3fghjk":     "$R3fghjk",
		"":             "",
		"notmeta":      "",
		"$I":           "",
	}
	for in, want := range cases {
		if got := dataNameFromMeta(in); got != want {
			t.Errorf("dataNameFromMeta(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSameOriginalPath(t *testing.T) {
	if !sameOriginalPath(`D:\工作\a.txt`, `d:/工作/a.txt`) {
		t.Fatal("斜杠与大小写差异应视为同一路径")
	}
	if !sameOriginalPath(`D:\工作\`, `D:\工作`) {
		t.Fatal("尾部分隔符应忽略")
	}
	if sameOriginalPath(`D:\a.txt`, `D:\b.txt`) {
		t.Fatal("不同路径不能匹配")
	}
	if sameOriginalPath("", `D:\a.txt`) {
		t.Fatal("空路径不能匹配")
	}
}

func TestDeletedAtFromMeta(t *testing.T) {
	want := uint64(134000000000000000)
	if got := deletedAtFromMeta(makeMeta(`C:\a.txt`, want)); got != want {
		t.Fatalf("删除时间不符：got %d want %d", got, want)
	}
	if got := deletedAtFromMeta([]byte{1, 2}); got != 0 {
		t.Fatalf("短数据应返回 0，得到 %d", got)
	}
}
