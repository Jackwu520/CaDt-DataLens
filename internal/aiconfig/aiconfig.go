// Package aiconfig AI 配置（profiles / prompts / preferences / 审批白名单）落盘为
// appdata 下的 ai-config.json。localStorage 继续保留一份镜像，便于旧版本回退；
// 文件存在时以文件为准。
package aiconfig

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
)

// FileMax 单文件上限。
const FileMax = 1 << 20

// Path 返回 ai-config.json 的绝对路径；应用数据目录不可用时返回空。
func Path() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "ai-config.json")
}

// ReadFile 读取指定路径的配置；文件不存在返回空串。
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
	if info.Size() > FileMax {
		return "", fmt.Errorf("AI 配置超过 %d KB", FileMax/1024)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// WriteFile 原子写入指定路径的配置（0600）。
func WriteFile(path, data string) error {
	if path == "" {
		return errors.New("无法定位应用数据目录")
	}
	if len(data) > FileMax {
		return fmt.Errorf("AI 配置超过 %d KB", FileMax/1024)
	}
	return atomfile.WriteFileAtomicMode(path, []byte(data), 0o600)
}

// Read 读取默认配置路径。
func Read() (string, error) { return ReadFile(Path()) }

// Write 写入默认配置路径。
func Write(data string) error { return WriteFile(Path(), data) }

// Store 暴露给 App 的绑定服务。
type Store struct{}

func (*Store) AIConfigRead() (string, error) { return Read() }

func (*Store) AIConfigWrite(data string) error { return Write(data) }
