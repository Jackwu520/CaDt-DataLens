// Package aicatalog：模型配置表的远端拉取、校验与 appdata 缓存读写。
// 字段归一与合并规则在前端 model-catalog.js（单一来源），Go 侧只搬原始文本。
package aicatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"datalens/internal/appdata"
	"datalens/internal/atomfile"
)

// 模型配置表（model catalog）：内置快照在前端 model-catalog.js，远端由 cadt-datalens-data/model-catalog
// 仓库的 catalog.json 提供。Go 侧只做三件事——拉取并挡掉明显垃圾、落到 appdata 缓存、把缓存读回前端；
// 字段归一与合并规则全在 model-catalog.js（单一来源），两边各写一份必然会漂。
const modelCatalogFileMax = 2 << 20

// 独立 client：不走 AI 请求的代理配置（那张表属于工作区设置，和这里无关），
// 但保留环境变量代理，跟随系统。
var modelCatalogHTTPClient = &http.Client{Timeout: 15 * time.Second}

// Blob 是前后端之间搬的原始文本：Text 为 catalog.json 原文，
// FetchedAt 是缓存落盘时间（Unix 秒，0 = 从未同步）。
type Blob struct {
	Text      string `json:"text"`
	FetchedAt int64  `json:"fetchedAt"`
}

// 宿主注入（main 包的根壳在 init 中接线）。
var (
	// AppDataDir 应用数据根目录（main/appdata.go 的 appDataRoot）。
	AppDataDir func() string
	// Version 应用版本，用于 User-Agent（main/app_core.go 的 appVersion）。
	Version = ""
)

func Path() string {
	if AppDataDir == nil {
		return ""
	}
	root := AppDataDir()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "model-catalog.json")
}

// 缓存读写单独抽出来（路径入参），测试用 t.TempDir() 隔离，不碰真实 appdata。
func readFile(path string) (*Blob, error) {
	if path == "" {
		return nil, appdata.ErrNoRoot
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Blob{}, nil
		}
		return nil, err
	}
	if info.Size() > modelCatalogFileMax {
		return &Blob{}, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return &Blob{Text: string(raw), FetchedAt: info.ModTime().Unix()}, nil
}

func writeFile(path, text string) (*Blob, error) {
	if path == "" {
		return nil, appdata.ErrNoRoot
	}
	if err := atomfile.WriteFileAtomicMode(path, []byte(text), 0o600); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &Blob{Text: text, FetchedAt: info.ModTime().Unix()}, nil
}

// fetch 只接受 http/https（挡掉 file:// 之类把本地文件读成「配置表」的玩法）。
func fetch(ctx context.Context, rawURL string) (string, error) {
	addr := strings.TrimSpace(rawURL)
	if addr == "" {
		return "", errors.New("同步地址为空")
	}
	parsed, err := url.Parse(addr)
	if err != nil {
		return "", fmt.Errorf("同步地址不合法：%v", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", errors.New("同步地址必须是 http 或 https")
	}
	if parsed.Host == "" {
		return "", errors.New("同步地址缺少主机名")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, addr, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "CaDt-DataLens/"+Version)
	res, err := modelCatalogHTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("拉取失败：%v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("拉取失败：HTTP %d", res.StatusCode)
	}
	// 多读 1 字节用来判超限，避免无上限读进内存
	body, err := io.ReadAll(io.LimitReader(res.Body, modelCatalogFileMax+1))
	if err != nil {
		return "", fmt.Errorf("读取响应失败：%v", err)
	}
	if len(body) > modelCatalogFileMax {
		return "", fmt.Errorf("配置表超过 %d KB", modelCatalogFileMax/1024)
	}
	text := string(body)
	if err := validate(text); err != nil {
		return "", err
	}
	return text, nil
}

// validate 只做「别把 HTML 错误页当配置表存下来」这一级校验：
// 必须是 JSON 对象、models 为非空数组、至少一条带非空 id。
// 字段级归一交给前端，那边有一套和运行时一致的 clamp。
func validate(text string) error {
	var probe struct {
		Version string            `json:"version"`
		Models  []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal([]byte(text), &probe); err != nil {
		return errors.New("不是合法的 JSON（检查地址是否指向 raw 文件）")
	}
	if len(probe.Models) == 0 {
		return errors.New("配置表缺少 models 数组")
	}
	var entry struct {
		ID string `json:"id"`
	}
	for _, item := range probe.Models {
		entry.ID = ""
		if err := json.Unmarshal(item, &entry); err == nil && strings.TrimSpace(entry.ID) != "" {
			return nil
		}
	}
	return errors.New("配置表里没有带 id 的模型条目")
}

// Cached 读缓存；没有缓存返回空 blob（不是错误——内置表兜底）。
func Cached() (*Blob, error) {
	return readFile(Path())
}

// Sync 拉取远端表：校验通过才落盘，失败时旧缓存原样保留。
func Sync(ctx context.Context, rawURL string) (*Blob, error) {
	text, err := fetch(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	return writeFile(Path(), text)
}
