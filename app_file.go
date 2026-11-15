package main

// 文件读写与编码：打开/保存（含外部修改校验）、图片与二进制判定、编码探测与转换。
// 从 app.go 拆出（同包）。

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"datalens/internal/chardec"
)

func (a *App) OpenFile(path string, enc string) (*FileData, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		name := filepath.Base(path)
		if name == "." || name == string(filepath.Separator) || name == "" {
			name = path
		}
		return &FileData{Path: path, Name: name, IsDir: true}, nil
	}
	if info.Size() > maxFileBytes {
		return nil, fmt.Errorf("文件超过 100 MB，拒绝打开：%s", filepath.Base(path))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	name := filepath.Base(path)
	imageFile := isImageFile(path, raw)
	if strings.EqualFold(filepath.Ext(path), ".bin") || imageFile || looksBinary(raw) {
		shown := len(raw)
		if shown > imageHexLimit {
			shown = imageHexLimit
		}
		return &FileData{
			Path:     path,
			Name:     name,
			Content:  imageHexDump(raw),
			Size:     info.Size(),
			Eol:      "lf",
			Enc:      "binary",
			Binary:   true,
			Image:    imageFile,
			HexShown: int64(shown),
			Mtime:    formatFileMtime(info.ModTime()),
		}, nil
	}
	hasBom := len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF
	if hasBom {
		raw = raw[3:]
	}
	eol := "lf"
	if strings.Contains(string(raw), "\r\n") {
		eol = "crlf"
	}
	text, usedEnc, err := chardec.DecodeBytes(raw, enc)
	if err != nil {
		return nil, err
	}
	return &FileData{
		Path:    path,
		Name:    name,
		Content: text,
		Enc:     usedEnc,
		Size:    info.Size(),
		Eol:     eol,
		HasBom:  hasBom,
		Large:   info.Size() > largeFileBytes,
		Mtime:   formatFileMtime(info.ModTime()),
	}, nil
}

var imageExtensions = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".jfif": true, ".gif": true, ".bmp": true,
	".webp": true, ".ico": true, ".tif": true, ".tiff": true, ".avif": true, ".heic": true,
	".heif": true, ".psd": true, ".raw": true, ".cr2": true, ".nef": true, ".arw": true, ".dng": true,
}

func isImageFile(path string, raw []byte) bool {
	if imageExtensions[strings.ToLower(filepath.Ext(path))] {
		return true
	}
	if len(raw) >= 8 && bytes.Equal(raw[:8], []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}) {
		return true
	}
	if len(raw) >= 3 && raw[0] == 0xFF && raw[1] == 0xD8 && raw[2] == 0xFF {
		return true
	}
	if len(raw) >= 6 && (string(raw[:6]) == "GIF87a" || string(raw[:6]) == "GIF89a") {
		return true
	}
	if len(raw) >= 12 && string(raw[:4]) == "RIFF" && string(raw[8:12]) == "WEBP" {
		return true
	}
	if len(raw) >= 4 && bytes.Equal(raw[:4], []byte{0x00, 0x00, 0x01, 0x00}) {
		return true
	}
	if len(raw) >= 4 && (bytes.Equal(raw[:4], []byte{'I', 'I', 0x2A, 0x00}) || bytes.Equal(raw[:4], []byte{'M', 'M', 0x00, 0x2A})) {
		return true
	}
	if len(raw) >= 4 && string(raw[:4]) == "8BPS" {
		return true
	}
	if len(raw) >= 12 && string(raw[4:8]) == "ftyp" {
		brand := string(raw[8:12])
		if brand == "avif" || brand == "avis" || brand == "heic" || brand == "heix" || brand == "hevc" || brand == "mif1" {
			return true
		}
	}
	return false
}

const imageHexLimit = 1 << 20

func looksBinary(raw []byte) bool {
	sample := raw
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	if len(sample) == 0 {
		return false
	}
	control := 0
	for _, b := range sample {
		if b == 0 {
			return true
		}
		if b == '\t' || b == '\n' || b == '\r' {
			continue
		}
		if b < 0x20 || b == 0x7F {
			control++
		}
	}
	return control*10 > len(sample)
}

func imageHexDump(raw []byte) string {
	shown := len(raw)
	if shown > imageHexLimit {
		shown = imageHexLimit
	}
	var b strings.Builder
	for off := 0; off < shown; off += 16 {
		end := off + 16
		if end > shown {
			end = shown
		}
		b.WriteString(fmt.Sprintf("%08x  ", off))
		for i := 0; i < 16; i++ {
			if off+i < end {
				b.WriteString(fmt.Sprintf("%02x ", raw[off+i]))
			} else {
				b.WriteString("   ")
			}
			if i == 7 {
				b.WriteString(" ")
			}
		}
		b.WriteString(" |")
		for i := off; i < end; i++ {
			c := raw[i]
			if c >= 32 && c < 127 {
				b.WriteByte(c)
			} else {
				b.WriteByte('.')
			}
		}
		b.WriteString("|\n")
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func (a *App) ReadImageDataURL(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", fmt.Errorf("没有图片路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", fmt.Errorf("不是图片文件")
	}
	if info.Size() > imagePreviewLimit {
		return "", fmt.Errorf("图片超过 32 MB，无法直接预览")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !isImageFile(path, raw) {
		return "", fmt.Errorf("不是可预览的图片")
	}
	mime := http.DetectContentType(raw)
	if !strings.HasPrefix(mime, "image/") {
		mime = imageMimeByExtension(path)
	}
	if mime == "" {
		mime = "application/octet-stream"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func imageMimeByExtension(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg", ".jfif":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".bmp":
		return "image/bmp"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".tif", ".tiff":
		return "image/tiff"
	case ".avif":
		return "image/avif"
	case ".heic", ".heif":
		return "image/heic"
	case ".psd":
		return "image/vnd.adobe.photoshop"
	}
	return ""
}

func (a *App) SaveFile(path, content, eol string, hasBom bool, enc string) error {
	if path == "" {
		return fmt.Errorf("没有目标文件")
	}
	raw, err := chardec.BuildSaveBytes(content, eol, hasBom, enc)
	if err != nil {
		return err
	}
	return os.WriteFile(path, raw, 0644)
}

// formatFileMtime 把修改时间格式化为纳秒字符串：JS 的 Number 存不下 1e18 级整数，
// 用字符串透传保证前后端比较精确。
func formatFileMtime(t time.Time) string {
	return strconv.FormatInt(t.UnixNano(), 10)
}

// FileStatInfo 文件磁盘状态（外部修改检测用）。
type FileStatInfo struct {
	Exists bool   `json:"exists"`
	Mtime  string `json:"mtime"`
	Size   int64  `json:"size"`
}

// GetFileStat 返回文件当前修改时间（UnixNano 字符串）；文件不存在时 Exists=false。
func (a *App) GetFileStat(path string) (*FileStatInfo, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("缺少文件路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &FileStatInfo{}, nil
		}
		return nil, err
	}
	return &FileStatInfo{Exists: true, Mtime: formatFileMtime(info.ModTime()), Size: info.Size()}, nil
}

// SaveFileResult 保存结果：Conflict=true 表示磁盘已被外部修改，本次未写入。
type SaveFileResult struct {
	OK       bool   `json:"ok"`
	Conflict bool   `json:"conflict"`
	Deleted  bool   `json:"deleted,omitempty"`
	Mtime    string `json:"mtime,omitempty"`
}

// SaveFileChecked 与 SaveFile 相同，但写入前校验磁盘 mtime：
// expectMtime 非空且与当前磁盘不一致时不写入并返回 Conflict，避免覆盖外部修改；
// expectMtime 为空表示不校验（新建 / 另存为 / 用户选择强制覆盖）。
func (a *App) SaveFileChecked(path, content, eol string, hasBom bool, enc string, expectMtime string) (*SaveFileResult, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("没有目标文件")
	}
	raw, err := chardec.BuildSaveBytes(content, eol, hasBom, enc)
	if err != nil {
		return nil, err
	}
	if expect := strings.TrimSpace(expectMtime); expect != "" {
		info, statErr := os.Stat(path)
		if statErr != nil {
			if os.IsNotExist(statErr) {
				return &SaveFileResult{Conflict: true, Deleted: true}, nil
			}
			return nil, statErr
		}
		if formatFileMtime(info.ModTime()) != expect {
			return &SaveFileResult{Conflict: true, Mtime: formatFileMtime(info.ModTime())}, nil
		}
	}
	if err := os.WriteFile(path, raw, 0644); err != nil {
		return nil, err
	}
	result := &SaveFileResult{OK: true}
	if info, statErr := os.Stat(path); statErr == nil {
		result.Mtime = formatFileMtime(info.ModTime())
	}
	return result, nil
}

func (a *App) CheckEncoding(content string, enc string) bool {
	if enc == "utf-8" || enc == "auto" {
		return true
	}
	if enc == "us-ascii" {
		for _, r := range content {
			if r > 0x7F {
				return false
			}
		}
		return true
	}
	return chardec.CanEncode(content, enc)
}
