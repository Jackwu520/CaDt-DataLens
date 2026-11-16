package main

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

	"datalens/internal/atomfile"
)

// 模型配置表（model catalog）：内置快照在前端 model-catalog.js，远端由 cadt-datalens-data/model-catalog
// 仓库的 catalog.json 提供。Go 侧只做三件事——拉取并挡掉明显垃圾、落到 appdata 缓存、把缓存读回前端；
// 字段归一与合并规则全在 model-catalog.js（单一来源），两边各写一份必然会漂。
const modelCatalogFileMax = 2 << 20

// 独立 client：不走 AI 请求的代理配置（那张表属于工作区设置，和这里无关），
// 但保留环境变量代理，跟随系统。
var modelCatalogHTTPClient = &http.Client{Timeout: 15 * time.Second}

// ModelCatalogBlob 是前后端之间搬的原始文本：Text 为 catalog.json 原文，
// FetchedAt 是缓存落盘时间（Unix 秒，0 = 从未同步）。
type ModelCatalogBlob struct {
	Text      string `json:"text"`
	FetchedAt int64  `json:"fetchedAt"`
}

func modelCatalogFilePath() string {
	root := appDataRoot()
	if root == "" {
		return ""
	}
	return filepath.Join(root, "model-catalog.json")
}

// AIModelCatalogCached 读缓存；没有缓存返回空 blob（不是错误——内置表兜底）。
func (a *App) AIModelCatalogCached() (*ModelCatalogBlob, error) {
	return readModelCatalogFile(modelCatalogFilePath())
}

// AIModelCatalogSync 拉取远端表：校验通过才落盘，失败时旧缓存原样保留。
func (a *App) AIModelCatalogSync(rawURL string) (*ModelCatalogBlob, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	text, err := fetchModelCatalog(ctx, rawURL)
	if err != nil {
		return nil, err
	}
	return writeModelCatalogFile(modelCatalogFilePath(), text)
}

// 缓存读写单独抽出来（路径入参），测试用 t.TempDir() 隔离，不碰真实 appdata。
func readModelCatalogFile(path string) (*ModelCatalogBlob, error) {
	if path == "" {
		return nil, errors.New("无法定位应用数据目录")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &ModelCatalogBlob{}, nil
		}
		return nil, err
	}
	if info.Size() > modelCatalogFileMax {
		return &ModelCatalogBlob{}, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return &ModelCatalogBlob{Text: string(raw), FetchedAt: info.ModTime().Unix()}, nil
}

func writeModelCatalogFile(path, text string) (*ModelCatalogBlob, error) {
	if path == "" {
		return nil, errors.New("无法定位应用数据目录")
	}
	if err := atomfile.WriteFileAtomicMode(path, []byte(text), 0o600); err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &ModelCatalogBlob{Text: text, FetchedAt: info.ModTime().Unix()}, nil
}

// fetchModelCatalog 只接受 http/https（挡掉 file:// 之类把本地文件读成「配置表」的玩法）。
func fetchModelCatalog(ctx context.Context, rawURL string) (string, error) {
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
	req.Header.Set("User-Agent", "CaDt-DataLens/"+appVersion)
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
	if err := validateModelCatalog(text); err != nil {
		return "", err
	}
	return text, nil
}

// validateModelCatalog 只做「别把 HTML 错误页当配置表存下来」这一级校验：
// 必须是 JSON 对象、models 为非空数组、至少一条带非空 id。
// 字段级归一交给前端，那边有一套和运行时一致的 clamp。
func validateModelCatalog(text string) error {
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
