package patch

// 补丁元数据（sidecar）：记录「这份补丁是基于哪一版文件生成的」，用于检测漂移。
// 不写进 .patch 本身（保持标准格式），按补丁内容 sha256 存本地。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Sidecar 与某个补丁内容 sha256 对应的生成基线。
type Sidecar struct {
	ID        string            `json:"id"`
	Summary   string            `json:"summary"`
	CreatedAt int64             `json:"createdAt"`
	PatchSHA  string            `json:"patchSha"`
	Root      string            `json:"root"`
	Files     map[string]string `json:"files"` // relPath(小写) -> 生成时内容 sha256
}

// MetaDir 返回补丁库的元数据目录。
func MetaDir(store string) string { return filepath.Join(store, "meta") }

// LoadSidecar 读取指定补丁 sha 的元数据；不存在或损坏返回 nil。
func LoadSidecar(store, patchSHA string) *Sidecar {
	if store == "" || patchSHA == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(MetaDir(store), patchSHA+".json"))
	if err != nil {
		return nil
	}
	var sc Sidecar
	if json.Unmarshal(b, &sc) != nil {
		return nil
	}
	return &sc
}

// SaveSidecar 持久化补丁元数据；失败静默（元数据是辅助信息）。
func SaveSidecar(store string, sc *Sidecar) {
	if store == "" {
		return
	}
	_ = os.MkdirAll(MetaDir(store), 0o755)
	b, err := json.MarshalIndent(sc, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(MetaDir(store), sc.PatchSHA+".json"), b, 0o644)
}

// ReadFileText 读取 .patch 文本：剥 BOM、统一换行，并做大小限制。
func ReadFileText(path string, limit int) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("这是一个目录：%s", filepath.Base(path))
	}
	if info.Size() > int64(limit) {
		return "", NewPatchError(PatchErrLimit, fmt.Sprintf("补丁文件超过 %d KB，请拆分后再用", limit/1024))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	text := strings.TrimPrefix(string(raw), "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return text, nil
}
