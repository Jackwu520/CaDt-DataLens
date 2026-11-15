// Package chardec：文本编解码纯函数（GBK/GB18030/ISO-8859-1/US-ASCII/UTF-8）。
// 从 app_file.go 同包拆出（2026-11-16），app_file / reading / sqlview / webtools /
// internal/patch 共用同一套实现，两侧不得各写一份。
package chardec

import (
	"bytes"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

// DecodeBytes 把原始字节按 enc 解码为文本；enc 为空时自动探测
// （UTF-8 有效即 UTF-8，否则试 GBK，最后按 UTF-8 兜底）。
// 返回实际使用的编码名。
func DecodeBytes(raw []byte, enc string) (string, string, error) {
	switch enc {
	case "gbk":
		text, err := decodeWith(simplifiedchinese.GBK.NewDecoder(), raw)
		return text, "gbk", err
	case "gb18030":
		text, err := decodeWith(simplifiedchinese.GB18030.NewDecoder(), raw)
		return text, "gb18030", err
	case "iso-8859-1", "us-ascii":
		text, err := decodeWith(charmap.ISO8859_1.NewDecoder(), raw)
		used := enc
		if enc == "us-ascii" {
			used = "us-ascii"
		}
		return text, used, err
	case "utf-8":
		return string(raw), "utf-8", nil
	}
	if utf8.Valid(raw) {
		return string(raw), "utf-8", nil
	}
	if text, err := decodeWith(simplifiedchinese.GBK.NewDecoder(), raw); err == nil {
		return text, "gbk", nil
	}
	return string(raw), "utf-8", nil
}

func decodeWith(dec *encoding.Decoder, raw []byte) (string, error) {
	out, _, err := transform.Bytes(dec, raw)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func encoderFor(enc string) *encoding.Encoder {
	switch enc {
	case "gbk":
		enc := simplifiedchinese.GBK.NewEncoder()
		return enc
	case "gb18030":
		enc := simplifiedchinese.GB18030.NewEncoder()
		return enc
	case "iso-8859-1", "us-ascii":
		enc := charmap.ISO8859_1.NewEncoder()
		return enc
	}
	return nil
}

// EncodeString 把文本编码为指定编码字节；未知编码按 UTF-8 原样返回，
// 无法表示的字符经 ReplaceUnsupported 替换。
func EncodeString(text, enc string) ([]byte, error) {
	if enc == "us-ascii" {
		for _, r := range text {
			if r > 0x7F {
				return nil, fmt.Errorf("包含非 ASCII 字符，无法用 US-ASCII 编码保存")
			}
		}
		return []byte(text), nil
	}
	encImpl := encoderFor(enc)
	if encImpl == nil {
		return []byte(text), nil
	}
	var buf bytes.Buffer
	writer := transform.NewWriter(&buf, encoding.ReplaceUnsupported(encImpl))
	if _, err := writer.Write([]byte(text)); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// CanEncode 判断文本能否用指定编码无损表示（不启用替换模式）。
func CanEncode(content, enc string) bool {
	encImpl := encoderFor(enc)
	if encImpl == nil {
		return true
	}
	var buf bytes.Buffer
	if _, err := transform.NewWriter(&buf, encImpl).Write([]byte(content)); err != nil {
		return false
	}
	return true
}

// BuildSaveBytes 按目标文件的换行风格 / BOM / 编码把文本转成落盘字节。
func BuildSaveBytes(content, eol string, hasBom bool, enc string) ([]byte, error) {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	if eol == "crlf" {
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}
	raw, err := EncodeString(content, enc)
	if err != nil {
		return nil, err
	}
	if hasBom && (enc == "" || enc == "utf-8" || enc == "auto") {
		raw = append([]byte{0xEF, 0xBB, 0xBF}, raw...)
	}
	return raw, nil
}
