//go:build !windows

// Package dpapi 的非 Windows 实现：没有系统级用户密钥库，Supported() 恒为 false，
// 调用方（envvars / aiconfig）据此退回明文存储。
// Unprotect 一律失败——Windows 上写出的密文换到别的平台本来就解不开，
// 报错比返回一串 base64 冒充明文安全。
package dpapi

import "errors"

// ErrDecrypt 表示密文解不开（当前平台没有 DPAPI）。
var ErrDecrypt = errors.New("当前平台不支持 DPAPI 解密")

// Supported 报告当前平台是否支持加密存储。
func Supported() bool { return false }

// Protect 明文直通（Supported() 为 false，调用方不应走到这里）。
func Protect(plain, _ string) (string, error) { return plain, nil }

// Unprotect 恒失败：非 Windows 平台无法解密 DPAPI 密文。
func Unprotect(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	return "", ErrDecrypt
}
