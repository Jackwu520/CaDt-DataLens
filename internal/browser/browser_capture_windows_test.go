//go:build windows

package browser

import (
	"fmt"
	"strings"
	"testing"
)

// TestBrowserCaptureLooksBlank 空白帧判据：空白帧的 base64 远小于阈值，正常页面远超。
func TestBrowserCaptureLooksBlank(t *testing.T) {
	cases := []struct {
		name string
		b64  string
		want bool
	}{
		{"空字符串", "", true},
		{"空白帧（约 1 KB）", strings.Repeat("A", 1024), true},
		{"阈值内最后一档", strings.Repeat("A", browserCaptureBlankB64-1), true},
		{"阈值本身", strings.Repeat("A", browserCaptureBlankB64), false},
		{"正常页面（16 KB）", strings.Repeat("A", 16<<10), false},
	}
	for _, c := range cases {
		if got := browserCaptureLooksBlank(c.b64); got != c.want {
			t.Fatalf("%s：browserCaptureLooksBlank(len=%d) = %v，预期 %v", c.name, len(c.b64), got, c.want)
		}
	}
}

// TestBrowserCaptureWithRetry 空白帧兜底：首抓空白 → 等一帧重抓；始终空白则走满次数但不报错。
func TestBrowserCaptureWithRetry(t *testing.T) {
	realShot := strings.Repeat("R", 8<<10)
	blankShot := strings.Repeat("B", 512)

	t.Run("首次空白后重抓成功", func(t *testing.T) {
		calls, waits := 0, 0
		capture := func() (string, error) {
			calls++
			if calls == 1 {
				return blankShot, nil
			}
			return realShot, nil
		}
		shot, err := browserCaptureWithRetry(capture, func() { waits++ }, 3)
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if shot != realShot || calls != 2 || waits != 1 {
			t.Fatalf("抓到内容=%v calls=%d waits=%d", shot == realShot, calls, waits)
		}
	})

	t.Run("始终空白时走满次数且不报错", func(t *testing.T) {
		calls, waits := 0, 0
		capture := func() (string, error) {
			calls++
			return blankShot, nil
		}
		shot, err := browserCaptureWithRetry(capture, func() { waits++ }, 3)
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if shot != blankShot || calls != 3 || waits != 2 {
			t.Fatalf("calls=%d waits=%d", calls, waits)
		}
	})

	t.Run("抓图出错立刻返回不重试", func(t *testing.T) {
		calls := 0
		capture := func() (string, error) {
			calls++
			return "", fmt.Errorf("CapturePreview 超时（30s）")
		}
		if _, err := browserCaptureWithRetry(capture, func() {}, 3); err == nil {
			t.Fatal("预期返回错误")
		}
		if calls != 1 {
			t.Fatalf("出错后不应重试，calls=%d", calls)
		}
	})

	t.Run("attempts 小于 1 按一次处理", func(t *testing.T) {
		calls := 0
		_, _ = browserCaptureWithRetry(func() (string, error) { calls++; return blankShot, nil }, nil, 0)
		if calls != 1 {
			t.Fatalf("calls=%d，预期 1", calls)
		}
	})
}
