// Package memo：快捷便签 面板的磁盘存储。工作区 <ws>/.cadt/memo/ 与全局
// <appdata>/memo/ 两个作用域各一份 memo.json（真源）+ img/ 贴图目录。
// 写入是单文件整份原子替换（atomfile），另带 mtime CAS：多窗口是多进程，
// 靠文件系统时间戳协调，冲突时让前端重载，不做合并。
// 结构级上限（块/条目/文本长度）由前端归一化统一执行，这里只卡总量与图片字节。
package memo

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"datalens/internal/atomfile"
)

const (
	scopeWorkspace = "workspace"
	scopeGlobal    = "global"

	docLimitBytes   = 512 << 10    // memo.json 总量上限
	imageLimitBytes = 16 << 20     // 单张贴图上限，与会话附图同口径
	mtimeSlackMs    = 2000         // FAT 类文件系统秒级时间戳粒度的放宽（只对「文件更旧」方向生效）
	conflictPrefix  = "conflict: " // SaveResult.Error 前缀：冲突错误（前端据此重载）
)

// imageExtByMIME 放行的贴图类型（只信魔数嗅探结果，剪贴板图片基本都是 PNG）。
var imageExtByMIME = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpg",
	"image/gif":  "gif",
	"image/webp": "webp",
	"image/bmp":  "bmp",
}

// Deps 外部动作注入：全局作用域落在应用数据目录。
type Deps struct {
	AppDataDir func() string
	Logf       func(format string, args ...any)
}

var deps Deps

// SetDeps 注入依赖（根壳启动时调用一次）。
func SetDeps(d Deps) { deps = d }

// SaveResult 保存结果：Conflict 为真表示别的窗口先写了，前端应重载后重试；
// MtimeMs 是写入后文件的新修改时间，前端直接更新缓存，省一次 Load。
type SaveResult struct {
	OK       bool   `json:"ok"`
	Conflict bool   `json:"conflict,omitempty"`
	Error    string `json:"error,omitempty"`
	MtimeMs  int64  `json:"mtimeMs,omitempty"`
}

// envelope Load 的返回信封：data 是 memo.json 原文，mtimeMs 用于写回时 CAS。
type envelope struct {
	Data    string `json:"data"`
	MtimeMs int64  `json:"mtimeMs"`
}

func defaultDoc() string {
	return `{"version":1,"updatedAt":0,"blocks":[]}`
}

// Load 读 memo.json。文件缺失返回空文档；坏 JSON 兜底成默认结构（不动原文件，
// 等 CAS 保存自然覆盖），避免用户手改坏后面板永远打不开。
func Load(scope, workspace string) (string, error) {
	root, err := resolveRoot(scope, workspace)
	if err != nil {
		return "", err
	}
	path := docPath(root)
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return envelopeJSON(defaultDoc(), 0), nil
		}
		return "", fmt.Errorf("读取快捷便签 失败：%s", err.Error())
	}
	if info.Size() > docLimitBytes {
		return "", fmt.Errorf("快捷便签 文件超过上限（%d KB），拒绝加载", docLimitBytes>>10)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("读取快捷便签 失败：%s", err.Error())
	}
	data := string(raw)
	if !json.Valid(raw) {
		if deps.Logf != nil {
			deps.Logf("memo: %s 不是合法 JSON，返回默认结构（原文件未动）", path)
		}
		data = defaultDoc()
	}
	return envelopeJSON(data, info.ModTime().UnixMilli()), nil
}

// Save 整份写 memo.json。baseMtimeMs>0 时做 CAS：文件比读入时新（哪怕毫秒级）
// 即视为其他窗口先写，返回 Conflict 让前端重载；「文件更旧」只在超出时间戳粒度
// 放宽时才算冲突。baseMtimeMs==0 表示载入时还没有文件，此时若文件已存在也报冲突。
func Save(scope, workspace, doc string, baseMtimeMs int64) SaveResult {
	root, err := resolveRoot(scope, workspace)
	if err != nil {
		return SaveResult{Error: err.Error()}
	}
	doc = strings.TrimSpace(doc)
	if doc == "" {
		return SaveResult{Error: "没有可保存的内容"}
	}
	if len(doc) > docLimitBytes {
		return SaveResult{Error: fmt.Sprintf("快捷便签 内容超过上限（%d KB）", docLimitBytes>>10)}
	}
	if !json.Valid([]byte(doc)) {
		return SaveResult{Error: "内容不是合法 JSON"}
	}
	path := docPath(root)
	info, statErr := os.Stat(path)
	if baseMtimeMs > 0 {
		switch {
		case os.IsNotExist(statErr):
			// 读到的 mtime>0 说明当时文件存在，现在没了：也是别处动过
			return SaveResult{Conflict: true, Error: conflictPrefix + "快捷便签 已在其他窗口删除"}
		case statErr != nil:
			return SaveResult{Error: "检查快捷便签 状态失败：" + statErr.Error()}
		}
		// 文件比读入时新（毫秒级即算）：别的窗口先写了；只有比读入时旧且超出
		// 精度放宽才放过——FAT 类文件系统时间戳有秒级粒度，自家上次写入可能
		// 被记成比缓存略早的时间。
		fileMs := info.ModTime().UnixMilli()
		if fileMs > baseMtimeMs || baseMtimeMs-fileMs > mtimeSlackMs {
			return SaveResult{Conflict: true, Error: conflictPrefix + "快捷便签 已在其他窗口修改"}
		}
	} else if statErr == nil && info.Size() > 0 {
		// 载入时还没有文件，期间已有人写入了内容：同样让前端重载，不静默覆盖
		return SaveResult{Conflict: true, Error: conflictPrefix + "快捷便签 已在其他窗口创建"}
	}
	if err := atomfile.WriteFileAtomic(path, []byte(doc)); err != nil {
		return SaveResult{Error: "写入快捷便签 失败：" + err.Error()}
	}
	mtimeMs := int64(0)
	if info, err := os.Stat(path); err == nil {
		mtimeMs = info.ModTime().UnixMilli()
	}
	return SaveResult{OK: true, MtimeMs: mtimeMs}
}

// SaveImage 把贴图 data URL 解码落盘到 <root>/img/，返回相对 doc 的引用路径
// （img/xxx.png）。类型只信魔数嗅探，命名用纳秒时间戳天然防覆盖。
func SaveImage(scope, workspace, dataURL string) (string, error) {
	root, err := resolveRoot(scope, workspace)
	if err != nil {
		return "", err
	}
	raw, ext, err := decodeImage(dataURL)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(root, "img")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建贴图目录失败：%s", err.Error())
	}
	name := fmt.Sprintf("img-%s.%s", strconv.FormatInt(time.Now().UnixNano(), 36), ext)
	if err := os.WriteFile(filepath.Join(dir, name), raw, 0o644); err != nil {
		return "", fmt.Errorf("写入贴图失败：%s", err.Error())
	}
	return "img/" + name, nil
}

// resolveRoot 解析作用域根目录：workspace → <ws>/.cadt/memo，global → <appdata>/memo。
func resolveRoot(scope, workspace string) (string, error) {
	switch scope {
	case scopeGlobal:
		if deps.AppDataDir == nil {
			return "", fmt.Errorf("应用数据目录未就绪")
		}
		base := strings.TrimSpace(deps.AppDataDir())
		if base == "" {
			return "", fmt.Errorf("应用数据目录不可用")
		}
		return filepath.Join(base, "memo"), nil
	case scopeWorkspace:
		ws := strings.TrimSpace(workspace)
		if ws == "" {
			return "", fmt.Errorf("没有打开的工作区，工作区快捷便签 不可用")
		}
		wsAbs, err := filepath.Abs(ws)
		if err != nil {
			return "", fmt.Errorf("工作区路径无效：%s", err.Error())
		}
		dir := filepath.Join(wsAbs, ".cadt", "memo")
		if checkRel, relErr := filepath.Rel(wsAbs, dir); relErr != nil ||
			checkRel == ".." || strings.HasPrefix(checkRel, ".."+string(filepath.Separator)) {
			return "", fmt.Errorf("memo 目录越出工作区")
		}
		return dir, nil
	default:
		return "", fmt.Errorf("未知作用域 %q（支持 workspace / global）", scope)
	}
}

func docPath(root string) string { return filepath.Join(root, "memo.json") }

func envelopeJSON(data string, mtimeMs int64) string {
	out, _ := json.Marshal(envelope{Data: data, MtimeMs: mtimeMs})
	return string(out)
}

// decodeImage 解 data URL：base64 解码 + 魔数嗅探定扩展名。嗅不出白名单类型一律拒绝。
func decodeImage(dataURL string) ([]byte, string, error) {
	const marker = "base64,"
	idx := strings.Index(dataURL, marker)
	if idx < 0 {
		return nil, "", fmt.Errorf("无效的图片数据")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(dataURL[idx+len(marker):]), ""))
	if err != nil {
		return nil, "", fmt.Errorf("图片 base64 解码失败：%s", err.Error())
	}
	if len(raw) == 0 {
		return nil, "", fmt.Errorf("图片数据为空")
	}
	if len(raw) > imageLimitBytes {
		return nil, "", fmt.Errorf("图片超过大小上限（%d MB）", imageLimitBytes>>20)
	}
	ext := sniffImageExt(raw)
	if ext == "" {
		return nil, "", fmt.Errorf("不支持的图片类型（只放行 png/jpg/gif/webp/bmp）")
	}
	return raw, ext, nil
}

// sniffImageExt 按魔数识别图片类型，识别不出返回空串。
func sniffImageExt(raw []byte) string {
	switch {
	case len(raw) >= 8 && raw[0] == 0x89 && raw[1] == 'P' && raw[2] == 'N' && raw[3] == 'G':
		return "png"
	case len(raw) >= 3 && raw[0] == 0xFF && raw[1] == 0xD8 && raw[2] == 0xFF:
		return "jpg"
	case len(raw) >= 6 && string(raw[:3]) == "GIF":
		return "gif"
	case len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WEBP":
		return "webp"
	case len(raw) >= 2 && raw[0] == 'B' && raw[1] == 'M':
		return "bmp"
	}
	return ""
}
