// Package aiconfig AI 配置（profiles / prompts / preferences / 审批白名单）落盘为
// appdata 下的 ai-config.json。localStorage 继续保留一份镜像，便于旧版本回退；
// 文件存在时以文件为准。
//
// 文件在 Windows 上整份用 DPAPI 加密（前缀 enc:v1:），绑定当前用户与本机——
// 与 ZCode 的 ~/.zcode/v2/credentials.json 同一种做法：模型即使能读到文件，
// 拿到的也只是密文。读写对调用方透明：ReadFile 解出明文，WriteFile 加密后落盘。
// 无 DPAPI 的平台（非 Windows）保持明文，与 internal/envvars 的降级一致。
package aiconfig

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
	"datalens/internal/dpapi"
)

// FileMax 单文件上限（按明文计）。
const FileMax = 1 << 20

// sealedPrefix 标记「这份文件是 DPAPI 密文」。没有前缀的一律按明文旧格式读，
// 下次保存自动升级成密文——升级不要求用户做任何动作。
const sealedPrefix = "enc:v1:"

// sealDescription 写进密文元数据，仅用于排查（不参与密钥派生）。
const sealDescription = "CaDt-DataLens AI 配置"

// SealedErrorToken 是 ErrSealed 文案里的稳定标记：前端靠它区分「配置读不出来」
// 与「配置不存在」，前者必须保留原文件、不能用空配置覆盖。
const SealedErrorToken = "AI_CONFIG_SEALED"

// ErrSealed 表示文件是加密的，但当前环境解不开（换了 Windows 用户 / 换了机器 /
// 文件损坏）。调用方必须保留原文件。
var ErrSealed = errors.New(SealedErrorToken + "：AI 配置文件无法解密（可能来自其他电脑或 Windows 用户）")

// Path 返回 ai-config.json 的绝对路径；应用数据目录不可用时返回空。
func Path() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "ai-config.json")
}

// Decode 把磁盘上的原始文本还原成明文配置：密文解密，明文原样返回。
// 供读盘路径与测试共用；解不开时返回 ErrSealed。
func Decode(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	if !strings.HasPrefix(text, sealedPrefix) {
		return raw, nil
	}
	if !dpapi.Supported() {
		return "", ErrSealed
	}
	plain, err := dpapi.Unprotect(strings.TrimPrefix(text, sealedPrefix))
	if err != nil {
		if errors.Is(err, dpapi.ErrDecrypt) {
			return "", ErrSealed
		}
		return "", err
	}
	return plain, nil
}

// Encode 把明文配置转成落盘形态：有 DPAPI 就加密，没有就原样。
// 加密失败直接报错，不退回明文——否则「密钥不落明文」这条保证会静默消失。
func Encode(plain string) (string, error) {
	if !dpapi.Supported() {
		return plain, nil
	}
	sealed, err := dpapi.Protect(plain, sealDescription)
	if err != nil {
		return "", err
	}
	return sealedPrefix + sealed, nil
}

// ReadFile 读取指定路径的配置并解出明文；文件不存在返回空串。
func ReadFile(path string) (string, error) {
	if path == "" {
		return "", errors.New("无法定位应用数据目录")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	// 密文是 base64，体积约为明文的 1.37 倍：先按放宽后的上限挡掉异常大文件，
	// 解密后再按 FileMax 精确判定。
	if info.Size() > FileMax*2 {
		return "", fmt.Errorf("AI 配置超过 %d KB", FileMax/1024)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	plain, err := Decode(string(raw))
	if err != nil {
		return "", err
	}
	if len(plain) > FileMax {
		return "", fmt.Errorf("AI 配置超过 %d KB", FileMax/1024)
	}
	return plain, nil
}

// WriteFile 原子写入指定路径的配置（0600，Windows 上加密后落盘）。
func WriteFile(path, data string) error {
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	if len(data) > FileMax {
		return fmt.Errorf("AI 配置超过 %d KB", FileMax/1024)
	}
	encoded, err := Encode(data)
	if err != nil {
		return err
	}
	return atomfile.WriteFileAtomicMode(path, []byte(encoded), 0o600)
}

// Read 读取默认配置路径。
func Read() (string, error) { return ReadFile(Path()) }

// Write 写入默认配置路径。
func Write(data string) error { return WriteFile(Path(), data) }

// BackupSealed 把「解不开的密文配置」改名留档，返回留档路径（没有可留档的文件时返回空串）。
// 用途：用户换了机器 / 换了 Windows 用户，文件解不开又不该被静默覆盖——
// 前端在首次写回前调它，把旧密文挪到 ai-config.json.sealed-<时间>.bak 再写新配置。
// 明文文件不动（那是正常配置，改名等于删配置）。
func BackupSealed() (string, error) {
	path := Path()
	if path == "" {
		return "", errors.New("无法定位应用数据目录")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	if !strings.HasPrefix(strings.TrimSpace(string(raw)), sealedPrefix) {
		return "", nil
	}
	backup := path + ".sealed-" + time.Now().Format("20060102-150405") + ".bak"
	if err := os.Rename(path, backup); err != nil {
		return "", err
	}
	return backup, nil
}

// Store 暴露给 App 的绑定服务。
type Store struct{}

func (*Store) AIConfigRead() (string, error) { return Read() }

func (*Store) AIConfigWrite(data string) error { return Write(data) }

// AIConfigBackupSealed 见 BackupSealed。
func (*Store) AIConfigBackupSealed() (string, error) { return BackupSealed() }
