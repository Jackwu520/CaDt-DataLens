//go:build windows

// Package dpapi 是 Windows DPAPI（CryptProtectData / CryptUnprotectData）的最小封装。
// 密文绑定当前用户与本机：换成别的 Windows 用户、或把文件拷到另一台机器，都解不出明文。
// 环境变量配置（internal/envvars）与 AI 配置（internal/aiconfig）共用这一份实现，
// 避免两套 syscall 各自演化。
package dpapi

import (
	"encoding/base64"
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

var (
	crypt32            = syscall.NewLazyDLL("crypt32.dll")
	procCryptProtect   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotect = crypt32.NewProc("CryptUnprotectData")
	procLocalFree      = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")
)

// ErrDecrypt 表示密文解不开（换用户 / 换机器 / 数据损坏）。
// 调用方据此区分「没配过」与「配过但读不出来」——后者绝不能当成空配置覆盖回去。
var ErrDecrypt = errors.New("DPAPI 解密失败")

type dataBlob struct {
	cbData uint32
	pbData *byte
}

// Supported 报告当前平台是否支持加密存储（Windows 恒为 true）。
func Supported() bool { return true }

func blobFromBytes(data []byte) dataBlob {
	if len(data) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(data)), pbData: &data[0]}
}

func blobBytes(b dataBlob) []byte {
	if b.pbData == nil || b.cbData == 0 {
		return nil
	}
	return unsafe.Slice(b.pbData, int(b.cbData))
}

// Protect 加密明文并返回 base64 密文；空串原样返回空串。
// description 只写进密文元数据（便于排查），不参与密钥派生。
func Protect(plain, description string) (string, error) {
	if plain == "" {
		return "", nil
	}
	in := blobFromBytes([]byte(plain))
	desc, err := syscall.UTF16PtrFromString(description)
	if err != nil {
		return "", err
	}
	var out dataBlob
	r, _, callErr := procCryptProtect.Call(
		uintptr(unsafe.Pointer(&in)),
		uintptr(unsafe.Pointer(desc)),
		0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return "", fmt.Errorf("DPAPI 加密失败：%v", callErr)
	}
	defer func() {
		if out.pbData != nil {
			_, _, _ = procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
		}
	}()
	return base64.StdEncoding.EncodeToString(blobBytes(out)), nil
}

// Unprotect 解密 base64 密文；失败返回可被 errors.Is 识别的 ErrDecrypt。
func Unprotect(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(stored)
	if err != nil {
		return "", fmt.Errorf("%w：密文不是合法 base64", ErrDecrypt)
	}
	in := blobFromBytes(raw)
	var out dataBlob
	r, _, _ := procCryptUnprotect.Call(
		uintptr(unsafe.Pointer(&in)),
		0, 0, 0, 0, 0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		return "", ErrDecrypt
	}
	defer func() {
		if out.pbData != nil {
			_, _, _ = procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
		}
	}()
	return string(blobBytes(out)), nil
}
