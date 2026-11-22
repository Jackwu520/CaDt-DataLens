// mcp_image.go：MCP 工具返回的图片落地。
// 为什么需要：模型只能收文本，image content 直接塞给它就是一行「[image: ...]」废话。
// 落地成 PNG 后把绝对路径写进结果文本，模型再调 read_image <路径> 就真能看到画面——
// 桌面控制的 Screenshot / Snapshot(use_vision=True) 全靠这条路。
package mcp

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DefaultImageSaver 是未注入自定义 saver 时的落地实现。
// 落点 %TEMP%/CaDt-DataLens/mcp-images：
//   - 不写应用数据目录（那里 AI 一律不可读，写了也看不见）；
//   - 不写工作区（MCP 是应用级，多窗口工作区不同；临时截图不该污染仓库）。
// 文件名带时间戳 + 随机串，同一次会话多次截图不会互相覆盖。
func DefaultImageSaver(mime string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("图片内容为空")
	}
	dir := filepath.Join(os.TempDir(), "CaDt-DataLens", "mcp-images")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	suffix := ".png"
	switch mime {
	case "image/jpeg", "image/jpg":
		suffix = ".jpg"
	case "image/webp":
		suffix = ".webp"
	case "image/gif":
		suffix = ".gif"
	}
	var randBytes [4]byte
	if _, err := rand.Read(randBytes[:]); err != nil {
		return "", err
	}
	name := time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(randBytes[:]) + suffix
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// imageSaver 取当前生效的 saver：宿主注入优先（测试 / 特殊部署），否则用默认实现。
func imageSaver() func(string, []byte) (string, error) {
	if ImageSaver != nil {
		return ImageSaver
	}
	return DefaultImageSaver
}

var _ = fmt.Sprintf // 保持与 mcp_client.go 同包导入风格（fmt 在那边已用）
