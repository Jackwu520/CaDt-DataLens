package recycle

// $I 元数据文件的解析（跨平台纯逻辑，便于单测）；平台相关的扫描逻辑在 recycle_windows.go。

import (
	"encoding/binary"
	"fmt"
	"strings"
	"unicode/utf16"
)

const (
	// Vista+ 的 $I 文件：2(header) + 8(size) + 8(filetime) + 4(pathLen) + pathLen*2(UTF-16LE)
	metaHeaderVista = 2
	metaFixedSize   = 28
	// 容错上限：路径最长 32766 个 UTF-16 单元，异常值一律拒绝
	maxMetaPathUnits = 32768
)

// originalPathFromMeta 解析 $I 元数据里的原始路径。
// 只认 Vista+ 格式；旧版（header=1）不猜，避免把错误路径还原到错位置。
func originalPathFromMeta(data []byte) (string, error) {
	if len(data) < metaFixedSize {
		return "", fmt.Errorf("$I 元数据过短")
	}
	if binary.LittleEndian.Uint64(data[0:8]) != metaHeaderVista {
		return "", fmt.Errorf("$I 元数据格式不支持")
	}
	units := int(binary.LittleEndian.Uint32(data[24:28]))
	if units <= 0 || units > maxMetaPathUnits {
		return "", fmt.Errorf("$I 元数据路径长度异常")
	}
	if len(data) < metaFixedSize+units*2 {
		return "", fmt.Errorf("$I 元数据被截断")
	}
	chars := make([]uint16, units)
	for i := 0; i < units; i++ {
		chars[i] = binary.LittleEndian.Uint16(data[metaFixedSize+i*2:])
	}
	// 尾部可能带 NUL 填充，去掉后再解码，避免路径末尾混入 \x00
	for len(chars) > 0 && chars[len(chars)-1] == 0 {
		chars = chars[:len(chars)-1]
	}
	return string(utf16.Decode(chars)), nil
}

// deletedAtFromMeta 取 $I 元数据里的删除时间（FILETIME 原始值），用于同名多次删除时选最近一次。
func deletedAtFromMeta(data []byte) uint64 {
	if len(data) < 24 {
		return 0
	}
	return binary.LittleEndian.Uint64(data[16:24])
}

// dataNameFromMeta 由 $I 文件名推出对应的 $R 数据文件名（两者只有前缀不同）。
func dataNameFromMeta(metaName string) string {
	if !strings.HasPrefix(metaName, "$I") || len(metaName) <= 2 {
		return ""
	}
	return "$R" + metaName[2:]
}

// sameOriginalPath 比较还原目标与 $I 记录的原路径：统一斜杠、去尾部分隔符、忽略大小写（Windows 语义）。
// 这里刻意不做符号链接 / 8.3 短名解析——那会把"还原"变成猜测，错了就是覆盖用户数据。
func sameOriginalPath(a, b string) bool {
	norm := func(s string) string {
		s = strings.ReplaceAll(strings.TrimSpace(s), "/", "\\")
		s = strings.TrimRight(s, "\\")
		return strings.ToLower(s)
	}
	left, right := norm(a), norm(b)
	return left != "" && left == right
}
