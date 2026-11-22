// mcp_image_test.go：MCP 图像结果落地的三态（未注入 / 成功 / 失败）。
// 背景：桌面控制的 Screenshot / Snapshot(use_vision=True) 返回的是 image content，
// 模型只能收文本——必须落地成文件 + 给路径，模型才能用 read_image 真看到画面。
package mcp

import (
	"encoding/base64"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestFormatImageContent(t *testing.T) {
	old := ImageSaver
	t.Cleanup(func() { ImageSaver = old })

	payload := base64.StdEncoding.EncodeToString([]byte("fake-png-bytes"))

	// ① saver 返回空路径（存不了）：退化为占位，但必须说清「看不到画面」
	ImageSaver = func(string, []byte) (string, error) { return "", nil }
	got := formatImageContent("image/png", payload)
	if !strings.Contains(got, "image/png") || !strings.Contains(got, "无法查看画面") {
		t.Fatalf("未落地时应给出占位并说明无法查看，实际：%q", got)
	}

	// ② 落地成功：文本里必须有绝对路径 + read_image 指路
	ImageSaver = func(mime string, data []byte) (string, error) {
		if mime != "image/png" || string(data) != "fake-png-bytes" {
			t.Fatalf("saver 收到的参数不对：mime=%q data=%q", mime, data)
		}
		return `C:\Temp\shot.png`, nil
	}
	got = formatImageContent("image/png", payload)
	if !strings.Contains(got, `C:\Temp\shot.png`) || !strings.Contains(got, "read_image") {
		t.Fatalf("成功落地时必须给出路径与 read_image 指路，实际：%q", got)
	}

	// ③ saver 报错：回退占位，不能把错误当成功
	ImageSaver = func(string, []byte) (string, error) { return "", errors.New("disk full") }
	got = formatImageContent("image/png", payload)
	if strings.Contains(got, "read_image") || !strings.Contains(got, "无法查看画面") {
		t.Fatalf("落地失败时必须回退占位，实际：%q", got)
	}

	// ④ base64 坏 / 空内容
	ImageSaver = func(string, []byte) (string, error) { return `C:\x.png`, nil }
	if got := formatImageContent("image/png", "!!!not-base64!!!"); strings.Contains(got, "read_image") {
		t.Fatalf("坏 base64 不该当成功，实际：%q", got)
	}
	if got := formatImageContent("image/png", ""); !strings.Contains(got, "内容为空") {
		t.Fatalf("空内容应明确说明，实际：%q", got)
	}
}

func TestSaveMCPImageWritesFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMP", dir)
	t.Setenv("TEMP", dir)
	// os.TempDir 在 Windows 上读 TMP/TEMP；两处都设，避免平台差异让测试落到真临时目录
	path, err := DefaultImageSaver("image/png", []byte("png"))
	if err != nil {
		t.Fatalf("DefaultImageSaver 失败：%v", err)
	}
	defer os.Remove(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("回读失败：%v", err)
	}
	if string(data) != "png" {
		t.Fatalf("内容不符：%q", data)
	}
	if !strings.HasSuffix(path, ".png") {
		t.Fatalf("扩展名应来自 mime，实际：%q", path)
	}
	// 空内容直接报错（上游 save_path 同款语义：没有图就不写文件）
	if _, err := DefaultImageSaver("image/png", nil); err == nil {
		t.Fatal("空内容应返回错误")
	}
}
