//go:build windows

// dpapi_windows_test.go：CryptProtectData / CryptUnprotectData 封装的往返与降级。
// 这次重构把 envvars 的 syscall 合并成 dpapi 包，两个调用方（AI 配置、环境变量）都压在
// 它上面——「能加密就能解回」「坏数据报 ErrDecrypt 而不是 panic」必须锁住。
package dpapi

import (
	"errors"
	"strings"
	"testing"
)

func TestProtectUnprotectRoundTrip(t *testing.T) {
	if !Supported() {
		t.Skip("当前环境无 DPAPI（理论上 Windows 恒有），跳过")
	}
	for _, plain := range []string{
		"sk-abc123",
		"",               // 空串：Protect 直通、Unprotect 也直通
		"中文密钥内容🔐", // 非 ASCII
		strings.Repeat("x", 4096), // 超过一个 DPAPI 内部分块的长度
	} {
		sealed, err := Protect(plain, "CaDt-DataLens 测试")
		if err != nil {
			t.Fatalf("Protect 报错：%v", err)
		}
		if plain != "" && sealed == plain {
			t.Fatalf("Protect 不应原样返回明文")
		}
		got, err := Unprotect(sealed)
		if err != nil {
			t.Fatalf("Unprotect 报错：%v", err)
		}
		if got != plain {
			t.Fatalf("往返不一致：want %q got %q", plain, got)
		}
	}
}

func TestUnprotectRejectsGarbage(t *testing.T) {
	if !Supported() {
		t.Skip("当前环境无 DPAPI，跳过")
	}
	// 不是 base64 的乱数据：应报 ErrDecrypt（调用方靠 errors.Is 识别），而不是 panic 或其他错误
	for _, garbage := range []string{"not-base64!!!", "enc:v1:&&&", "\x00\x01\x02"} {
		if _, err := Unprotect(garbage); !errors.Is(err, ErrDecrypt) {
			t.Fatalf("Unprotect(%q) 应返回 ErrDecrypt，实际 %v", garbage, err)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
