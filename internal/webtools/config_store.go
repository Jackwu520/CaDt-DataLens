package webtools

// external-tools.json 的默认位置与保存合并规则（原 main/webtools_config.go 的路径与掩码逻辑）。

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/appdata"
	"datalens/internal/sessionlock"
)

// configLockWait 跨进程写锁等待上限：读-改-写只在保存瞬间争用，3s 足够覆盖另一窗口的落盘。
const configLockWait = 3 * time.Second

// lockConfigStore 拿「读-改-写」的跨进程互斥（多窗口是多进程，包级 sync.Mutex 不够）。
// apiKey 留空表示保持原值，所以整段读旧值 → 合并 → 落盘必须串行：否则 B 读到 A 写之前的
// 旧文件、合并后写回，把 A 刚设置的新 key 回滚掉。
func lockConfigStore(path string) (*sessionlock.FileLock, error) {
	return sessionlock.LockFile(path+".lock", configLockWait)
}

// ConfigPath 返回 external-tools.json 的绝对路径；应用数据目录不可用时返回空。
func ConfigPath() string {
	root := appdata.Root()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "external-tools.json")
}

// LoadDefaultConfig 从默认路径加载配置。
func LoadDefaultConfig() (Config, error) {
	path := ConfigPath()
	if path == "" {
		return Config{}, appdata.ErrNoRoot
	}
	return LoadConfig(path)
}

// MergeAndSaveConfig 用前端 payload 更新默认路径配置；apiKey 留空表示保持原值。
func MergeAndSaveConfig(payload map[string]interface{}) error {
	path := ConfigPath()
	if path == "" {
		return appdata.ErrNoRoot
	}
	lock, err := lockConfigStore(path)
	if err != nil {
		return err
	}
	defer lock.Release()
	old, err := LoadConfig(path)
	if err != nil {
		// 旧文件损坏时允许用本次保存覆盖修复；目录不可写会在 SaveConfig 报错
		old = DefaultConfig()
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var next Config
	if err := json.Unmarshal(raw, &next); err != nil {
		return err
	}
	if strings.TrimSpace(next.APIKey) == "" {
		next.APIKey = old.APIKey
	}
	return SaveConfig(path, next)
}

// ClearDefaultAPIKey 清空服务提供商 API Key（其余配置保留）。
func ClearDefaultAPIKey() error {
	path := ConfigPath()
	if path == "" {
		return appdata.ErrNoRoot
	}
	lock, err := lockConfigStore(path)
	if err != nil {
		return err
	}
	defer lock.Release()
	cfg, err := LoadConfig(path)
	if err != nil {
		return err
	}
	cfg.APIKey = ""
	return SaveConfig(path, cfg)
}
