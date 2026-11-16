package fileio

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImageHexDumpHasNoPreamble(t *testing.T) {
	got := imageHexDump([]byte{0x89, 'P', 'N', 'G', 0x00, 0xFF})
	if strings.HasPrefix(got, "//") || strings.Contains(got, "\n\n") || strings.HasSuffix(got, "\n") {
		t.Fatalf("hex dump should contain only data rows, got %q", got)
	}
	lines := strings.Split(got, "\n")
	if len(lines) != 1 {
		t.Fatalf("expected one data line, got %d: %q", len(lines), got)
	}
	if !strings.HasPrefix(lines[0], "00000000  ") {
		t.Fatalf("unexpected first line: %q", lines[0])
	}
	if !strings.Contains(lines[0], "89 50 4e 47 00 ff") {
		t.Fatalf("bytes missing from dump: %q", lines[0])
	}
}

// SVG 必须按文本打开（Binary/Image 都为 false）：imageExtensions 是 OpenFile 分类与
// 读图判定共用的表，曾因把 .svg 加进表里导致 SVG 被判成图片二进制、编辑器打不开。
func TestOpenFileSVGStaysText(t *testing.T) {
	svg := "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\"/></svg>"
	path := filepath.Join(t.TempDir(), "pic.svg")
	if err := os.WriteFile(path, []byte(svg), 0o644); err != nil {
		t.Fatal(err)
	}
	data, err := (&Files{}).OpenFile(path, "")
	if err != nil {
		t.Fatal(err)
	}
	if data.Binary || data.Image {
		t.Fatalf("SVG 不应判成图片二进制：binary=%v image=%v", data.Binary, data.Image)
	}
	if data.Content != svg {
		t.Fatalf("SVG 正文应原样保留，got %q", data.Content)
	}
}

// 读图链路对 svg 单独放行（不依赖 imageExtensions），MIME 回退到扩展名表。
func TestReadImageAsDataURLAcceptsSVG(t *testing.T) {
	svg := "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"
	path := filepath.Join(t.TempDir(), "pic.svg")
	if err := os.WriteFile(path, []byte(svg), 0o644); err != nil {
		t.Fatal(err)
	}
	url, err := (&Files{}).ReadImageAsDataURL(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "data:image/svg+xml;base64,") {
		t.Fatalf("data URL = %q", url)
	}
	// 非图片文本仍要拒绝：放行只限 .svg 扩展名。
	txt := filepath.Join(t.TempDir(), "note.svg")
	if err := os.WriteFile(txt, []byte("<html>not svg but named svg</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 同为 .svg 扩展名、内容非 SVG 也放行（与重构后行为一致：按扩展名放行，不嗅探 SVG 根元素）。
	if _, err := (&Files{}).ReadImageAsDataURL(txt); err != nil {
		t.Fatalf(".svg 扩展名应放行：%v", err)
	}
	deny := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(deny, []byte("plain text"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Files{}).ReadImageAsDataURL(deny); err == nil {
		t.Fatal(".txt 文本应拒绝")
	}
}

// AI 视频链路：ReadVideoAsDataURL 只收 mp4（扩展名 + ftyp 魔数双校验），上限 16 MB。
func TestReadVideoAsDataURL(t *testing.T) {
	mp4 := append([]byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'}, []byte("payload")...)
	path := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(path, mp4, 0o644); err != nil {
		t.Fatal(err)
	}
	url, err := (&Files{}).ReadVideoAsDataURL(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(url, "data:video/mp4;base64,") {
		t.Fatalf("data URL = %q", url)
	}

	// 扩展名白名单：webm / mov 不放行
	for _, name := range []string{"clip.webm", "clip.mov", "clip.avi"} {
		p := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(p, mp4, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := (&Files{}).ReadVideoAsDataURL(p); err == nil {
			t.Fatalf("%s 应拒绝", name)
		}
	}
	// 内容不是 mp4：假扩展名拒绝
	fake := filepath.Join(t.TempDir(), "fake.mp4")
	if err := os.WriteFile(fake, []byte("plain text"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Files{}).ReadVideoAsDataURL(fake); err == nil {
		t.Fatal("非 ftyp 内容应拒绝")
	}
	// 超上限拒绝
	big := filepath.Join(t.TempDir(), "big.mp4")
	if err := os.WriteFile(big, bytes.Repeat(mp4, 1<<20), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (&Files{}).ReadVideoAsDataURL(big); err == nil {
		t.Fatal("超 16 MB 视频应拒绝")
	}
}

// OpenFile 的视频分类：容器扩展名或 ftyp/EBML 头命中才 Video=true。
// Image 与 Video 互斥，且 HEVC 品牌位的 mp4 必须按扩展名判成视频（isImageFile 会把它当 HEIF）。
func TestOpenFileVideoClassification(t *testing.T) {
	ftyp := func(brand string) []byte {
		raw := []byte{0x00, 0x00, 0x00, 0x18, 'f', 't', 'y', 'p'}
		raw = append(raw, []byte(brand)...)
		return append(raw, bytes.Repeat([]byte{0}, 24)...)
	}
	cases := []struct {
		name      string
		raw       []byte
		wantVideo bool
		wantImage bool
	}{
		{"clip.mp4", ftyp("mp42"), true, false},
		{"clip.m4v", ftyp("M4V "), true, false},
		{"clip.mov", ftyp("qt  "), true, false},
		{"clip.webm", []byte{0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01, 0x42}, true, false},
		{"hevc.mp4", ftyp("hevc"), true, false},
		{"snap.heic", ftyp("heic"), false, true},
		{"snap.png", []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00}, false, true},
		{"notes.txt", []byte("plain text\n"), false, false},
	}
	for _, c := range cases {
		path := filepath.Join(t.TempDir(), c.name)
		if err := os.WriteFile(path, c.raw, 0o644); err != nil {
			t.Fatal(err)
		}
		data, err := (&Files{}).OpenFile(path, "")
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if data.Video != c.wantVideo || data.Image != c.wantImage {
			t.Fatalf("%s: video=%v image=%v, want video=%v image=%v",
				c.name, data.Video, data.Image, c.wantVideo, c.wantImage)
		}
		// 视频与图片都仍是二进制文档，编辑/保存路径不变
		if (c.wantVideo || c.wantImage) && !data.Binary {
			t.Fatalf("%s 应标记为 binary 文档", c.name)
		}
	}
}
