// Package aiimagepolicy：AI 图片上限的单一真源——源准入 / 归一化 / 请求预算三层阈值，
// 以及批量准入校验的纯函数。
//
// 数值口径对齐 deepseek-harness 的两层结构（源准入宽松 + 归一化兜底 + 请求层硬预算），
// 前端经 Wails 绑定 AIImageLimits 拉取同一份数值（投影），传输层 validate 用同一份常量强制，
// 避免前后端各写一份而漂。
//
// 归一化本身在前端 canvas（frontend/src/ai/ai-image-encode.js）完成：Go 侧不做图像处理、
// 不引入 sharp/libvips 等原生依赖（win32-x64 三件合计约 40 MB，会让单 exe 体积翻倍）。
package aiimagepolicy

import "fmt"

// 三层阈值（全部硬编码，不进 config.json、不暴露设置页——与 codex / opencode / ZCode / dsh 一致）。
const (
	// 源准入层：入口先把大图收下来，不在这里压（对齐 dsh 的 50 MiB / 200 MiB 口径）。
	MaxImagesPerMessage   = 10
	MaxSourceImageBytes   = 50 << 20  // 50 MiB 单个源文件
	MaxMessageSourceBytes = 200 << 20 // 200 MiB 单条消息源文件合计
	MaxImagePixels        = 64_000_000
	MaxImageDimension     = 65535

	// 归一化层：前端 canvas 兜底后的目标（长边 / 编码后 base64）。
	MaxNormalizedDimension = 2048
	MaxNormalizedBase64    = 4 << 20 // 4 MiB 单张编码后

	// 请求层：真正进模型的硬预算（对齐 codex 的 32 MiB base64 档，留在 Go 侧 128 MiB 兜底之内）。
	MaxRequestImageBytes = 32 << 20
)

// mediaTypes 是归一化后允许进模型的格式（与前端 AI_IMAGE_MIMES、fileio 的图片扩展名表一致）。
var mediaTypes = []string{"image/png", "image/jpeg", "image/webp", "image/gif"}

// ImageLimits 是三层限制的冻结快照；JSON 字段供 Wails 绑定投影到前端。
type ImageLimits struct {
	// 源准入层
	MaxImagesPerMessage   int `json:"maxImagesPerMessage"`
	MaxSourceImageBytes   int `json:"maxSourceImageBytes"`
	MaxMessageSourceBytes int `json:"maxMessageSourceBytes"`
	MaxImagePixels        int `json:"maxImagePixels"`
	MaxImageDimension     int `json:"maxImageDimension"`
	// 归一化层
	MaxNormalizedDimension int `json:"maxNormalizedDimension"`
	MaxNormalizedBase64    int `json:"maxNormalizedBase64"`
	// 请求层
	MaxRequestImageBytes int      `json:"maxRequestImageBytes"`
	MediaTypes           []string `json:"mediaTypes"`
}

// Get 返回当前限制的冻结副本（MediaTypes 也复制：调用方改不动真源）。
func Get() ImageLimits {
	types := make([]string, len(mediaTypes))
	copy(types, mediaTypes)
	return ImageLimits{
		MaxImagesPerMessage:    MaxImagesPerMessage,
		MaxSourceImageBytes:    MaxSourceImageBytes,
		MaxMessageSourceBytes:  MaxMessageSourceBytes,
		MaxImagePixels:         MaxImagePixels,
		MaxImageDimension:      MaxImageDimension,
		MaxNormalizedDimension: MaxNormalizedDimension,
		MaxNormalizedBase64:    MaxNormalizedBase64,
		MaxRequestImageBytes:   MaxRequestImageBytes,
		MediaTypes:             types,
	}
}

// ErrorCode 是批量准入的拒绝原因码，前端按码区分文案。
type ErrorCode string

const (
	// ErrTooManyImages 张数超上限。
	ErrTooManyImages ErrorCode = "TOO_MANY_IMAGES"
	// ErrSourcesTooLarge 源文件单张或合计超上限。
	ErrSourcesTooLarge ErrorCode = "SOURCES_TOO_LARGE"
	// ErrRequestImagesTooLarge 编码后单张或合计超上限。
	ErrRequestImagesTooLarge ErrorCode = "REQUEST_IMAGES_TOO_LARGE"
)

// Error 是带原因码的准入拒绝。
type Error struct {
	Code    ErrorCode
	Message string
}

func (e *Error) Error() string { return e.Message }

// IsCode 判断 err 是否为指定原因码的准入拒绝。
func IsCode(err error, code ErrorCode) bool {
	ae, ok := err.(*Error)
	return ok && ae.Code == code
}

// ValidateBatch 按三层阈值校验一批图片：先张数、再源文件单张与合计、最后编码后单张与合计。
// 与 dsh 的 assertMessageImages + 逐图字节校验同序；任一失败即拒，调用方据此整批不收。
// sourceBytes 与 requestBase64Bytes 按图片顺序给出各自的字节数（长度可与 count 不同，逐项校验各自长度）。
func ValidateBatch(count int, sourceBytes, requestBase64Bytes []int) error {
	limits := Get()
	if count < 0 {
		count = 0
	}
	if count > limits.MaxImagesPerMessage {
		return &Error{
			Code:    ErrTooManyImages,
			Message: fmt.Sprintf("每条消息最多附加 %d 张图片", limits.MaxImagesPerMessage),
		}
	}
	var sourceTotal int64
	for i, b := range sourceBytes {
		if b < 0 {
			b = 0 // 负值不计入合计，避免「负数把总量冲小」掩盖超限
		}
		if b > limits.MaxSourceImageBytes {
			return &Error{
				Code:    ErrSourcesTooLarge,
				Message: fmt.Sprintf("第 %d 张图片源文件超过 %d MB 上限", i+1, limits.MaxSourceImageBytes>>20),
			}
		}
		sourceTotal += int64(b)
	}
	if sourceTotal > int64(limits.MaxMessageSourceBytes) {
		return &Error{
			Code:    ErrSourcesTooLarge,
			Message: fmt.Sprintf("图片源文件合计超过 %d MB 上限", limits.MaxMessageSourceBytes>>20),
		}
	}
	var requestTotal int64
	for i, b := range requestBase64Bytes {
		if b < 0 {
			b = 0
		}
		if b > limits.MaxNormalizedBase64 {
			return &Error{
				Code:    ErrRequestImagesTooLarge,
				Message: fmt.Sprintf("第 %d 张图片编码后超过 %d MB 上限", i+1, limits.MaxNormalizedBase64>>20),
			}
		}
		requestTotal += int64(b)
	}
	if requestTotal > int64(limits.MaxRequestImageBytes) {
		return &Error{
			Code:    ErrRequestImagesTooLarge,
			Message: fmt.Sprintf("图片编码后合计超过 %d MB 上限，请减少图片", limits.MaxRequestImageBytes>>20),
		}
	}
	return nil
}
