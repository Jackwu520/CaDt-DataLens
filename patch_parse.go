package main

// 补丁解析：把 .patch/.diff 文本切成文件段与 hunk，含 git 风格引号路径解码。
// 从 patch.go 拆出（同包），对外入口见 patch_app.go / patch_cli.go。

import (
	"fmt"
	"strconv"
	"strings"
)

// ===== 解析 =====

func parsePatchText(text string) (*patchDoc, error) {
	text = strings.TrimPrefix(text, "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	if strings.TrimSpace(text) == "" {
		return nil, newPatchError(patchErrEmpty, "补丁内容为空")
	}
	lines := strings.Split(text, "\n")
	doc := &patchDoc{}
	cur := -1
	var hunk *patchHunk

	finishHunk := func() error {
		if hunk == nil || cur < 0 {
			return nil
		}
		oldCount, newCount := 0, 0
		for _, ln := range hunk.Lines {
			if ln.T != '+' {
				oldCount++
			}
			if ln.T != '-' {
				newCount++
			}
		}
		if oldCount != hunk.OldCount || newCount != hunk.NewCount {
			return &patchError{
				Code:   patchErrParse,
				Msg:    fmt.Sprintf("hunk 行数与 @@ 头不一致（第 %d 行）", hunk.LineNo),
				Detail: fmt.Sprintf("头部声明 -%d,%d +%d,%d，实际数出 -%d +%d", hunk.OldStart, hunk.OldCount, hunk.NewStart, hunk.NewCount, oldCount, newCount),
			}
		}
		doc.Files[cur].Hunks = append(doc.Files[cur].Hunks, *hunk)
		doc.Files[cur].Added += countCtx(hunk, '+')
		doc.Files[cur].Removed += countCtx(hunk, '-')
		hunk = nil
		return nil
	}

	for i := 0; i < len(lines); i++ {
		raw := lines[i]
		lineNo := i + 1
		switch {
		case strings.HasPrefix(raw, "diff --git "):
			if err := finishHunk(); err != nil {
				return nil, err
			}
			oldPath, newPath := parseGitDiffHeader(raw)
			doc.Files = append(doc.Files, patchFile{RawOld: oldPath, RawNew: newPath, Kind: "modify"})
			cur = len(doc.Files) - 1
		case strings.HasPrefix(raw, "new file mode"):
			if cur >= 0 {
				doc.Files[cur].Kind = "add"
			}
		case strings.HasPrefix(raw, "deleted file mode"):
			if cur >= 0 {
				doc.Files[cur].Kind = "delete"
			}
		case strings.HasPrefix(raw, "rename from "), strings.HasPrefix(raw, "rename to "),
			strings.HasPrefix(raw, "old mode "), strings.HasPrefix(raw, "new mode "):
			if cur >= 0 {
				doc.Files[cur].Kind = "unsupported"
				doc.Files[cur].UnsupportedMsg = "重命名 / 权限位变更"
			}
		case strings.HasPrefix(raw, "Binary files "), strings.HasPrefix(raw, "GIT binary patch"):
			if cur >= 0 {
				doc.Files[cur].Kind = "unsupported"
				doc.Files[cur].UnsupportedMsg = "二进制补丁"
			}
		case strings.HasPrefix(raw, "--- "):
			if err := finishHunk(); err != nil {
				return nil, err
			}
			oldPath := strings.TrimSpace(raw[4:])
			if cur < 0 || (doc.Files[cur].RawOld != "" && len(doc.Files[cur].Hunks) > 0) {
				doc.Files = append(doc.Files, patchFile{Kind: "modify"})
				cur = len(doc.Files) - 1
			}
			if doc.Files[cur].RawOld == "" {
				doc.Files[cur].RawOld = oldPath
			}
			if isDevNull(oldPath) && doc.Files[cur].Kind == "modify" {
				doc.Files[cur].Kind = "add"
			}
		case strings.HasPrefix(raw, "+++ "):
			if cur < 0 {
				return nil, &patchError{Code: patchErrParse, Msg: "+++ 之前没有对应的 ---", Detail: fmt.Sprintf("第 %d 行", lineNo)}
			}
			newPath := strings.TrimSpace(raw[4:])
			doc.Files[cur].RawNew = newPath
			if isDevNull(newPath) && doc.Files[cur].Kind == "modify" {
				doc.Files[cur].Kind = "delete"
			}
		case strings.HasPrefix(raw, "@@"):
			if cur < 0 {
				return nil, &patchError{Code: patchErrParse, Msg: "@@ 之前没有文件头", Detail: fmt.Sprintf("第 %d 行", lineNo)}
			}
			if err := finishHunk(); err != nil {
				return nil, err
			}
			m := patchHunkRe.FindStringSubmatch(raw)
			if m == nil {
				return nil, &patchError{Code: patchErrParse, Msg: "无法解析 hunk 头", Detail: fmt.Sprintf("第 %d 行：%s", lineNo, raw)}
			}
			oldStart := atoiSafe(m[1])
			oldCount := 1
			if m[2] != "" {
				oldCount = atoiSafe(m[2])
			}
			newStart := atoiSafe(m[3])
			newCount := 1
			if m[4] != "" {
				newCount = atoiSafe(m[4])
			}
			hunk = &patchHunk{OldStart: oldStart, OldCount: oldCount, NewStart: newStart, NewCount: newCount, Header: raw, LineNo: lineNo}
			if len(doc.Files[cur].Hunks) >= patchMaxHunks {
				return nil, newPatchError(patchErrLimit, fmt.Sprintf("单文件 hunk 超过 %d 个", patchMaxHunks))
			}
		case hunk != nil && (strings.HasPrefix(raw, " ") || strings.HasPrefix(raw, "+") || strings.HasPrefix(raw, "-")):
			noEOL := false
			body := raw[1:]
			if i+1 < len(lines) && strings.HasPrefix(lines[i+1], "\\ No newline at end of file") {
				noEOL = true
				i++
			}
			hunk.Lines = append(hunk.Lines, patchLine{T: raw[0], Text: body, NoEOL: noEOL})
		case hunk != nil && raw == "":
			// 传输过程常把「空上下文行」（单个空格）的尾空格吃掉，按空上下文处理；
			// 但补丁文本末尾的分隔空行不能算进去，否则行数永远对不上。
			oc, nc := 0, 0
			for _, ln := range hunk.Lines {
				if ln.T != '+' {
					oc++
				}
				if ln.T != '-' {
					nc++
				}
			}
			if oc < hunk.OldCount && nc < hunk.NewCount {
				hunk.Lines = append(hunk.Lines, patchLine{T: ' ', Text: ""})
			}
		case strings.HasPrefix(raw, "\\ No newline at end of file"):
			if hunk != nil && len(hunk.Lines) > 0 {
				hunk.Lines[len(hunk.Lines)-1].NoEOL = true
			}
		default:
			// 前言（From / Subject / index / similarity 等）与补丁尾部杂项，忽略
		}
	}
	if err := finishHunk(); err != nil {
		return nil, err
	}
	// 没有 hunk 的文件（例如只有 diff --git 头）剔除
	kept := doc.Files[:0]
	for _, f := range doc.Files {
		if f.Kind == "unsupported" || len(f.Hunks) > 0 || f.Kind == "add" || f.Kind == "delete" {
			kept = append(kept, f)
		}
	}
	doc.Files = kept
	if len(doc.Files) == 0 {
		return nil, newPatchError(patchErrEmpty, "补丁里没有任何文件改动（至少需要一个 @@ hunk）")
	}
	if len(doc.Files) > patchMaxFiles {
		return nil, newPatchError(patchErrLimit, fmt.Sprintf("文件数超过 %d 个", patchMaxFiles))
	}
	for i := range doc.Files {
		doc.Added += doc.Files[i].Added
		doc.Removed += doc.Files[i].Removed
	}
	return doc, nil
}

func countCtx(h *patchHunk, t byte) int {
	n := 0
	for _, ln := range h.Lines {
		if ln.T == t {
			n++
		}
	}
	return n
}

func atoiSafe(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

func isDevNull(p string) bool { return strings.TrimSpace(p) == "/dev/null" }

func parseGitDiffHeader(line string) (string, string) {
	rest := strings.TrimSpace(strings.TrimPrefix(line, "diff --git "))
	// 形如 a/x b/x；带空格路径会被引号包起来
	if strings.HasPrefix(rest, "\"") {
		if idx := strings.Index(rest[1:], "\" \""); idx >= 0 {
			return rest[:idx+2], rest[idx+4:]
		}
		return rest, rest
	}
	idx := strings.Index(rest, " b/")
	if idx < 0 {
		return rest, rest
	}
	return rest[:idx], rest[idx+1:]
}

// unquoteGitPath 解码 git 的 C 风格引号路径："a/\344\270\255.txt"
func unquoteGitPath(s string) string {
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return s
	}
	body := s[1 : len(s)-1]
	var out []byte
	for i := 0; i < len(body); i++ {
		c := body[i]
		if c != '\\' || i+1 >= len(body) {
			out = append(out, c)
			continue
		}
		i++
		switch body[i] {
		case 'n':
			out = append(out, '\n')
		case 't':
			out = append(out, '\t')
		case 'r':
			out = append(out, '\r')
		case '"', '\\':
			out = append(out, body[i])
		case '0', '1', '2', '3', '4', '5', '6', '7':
			if i+2 < len(body) {
				v, err := strconv.ParseUint(body[i:i+3], 8, 8)
				if err == nil {
					out = append(out, byte(v))
					i += 2
					continue
				}
			}
			out = append(out, body[i])
		default:
			out = append(out, body[i])
		}
	}
	return string(out)
}

// stripPatchPath 去掉前 n 级目录，并做安全校验；返回相对路径（正斜杠）。
func stripPatchPath(raw string, strip int) (string, *patchError) {
	p := strings.TrimSpace(raw)
	if p == "" || isDevNull(p) {
		return "", nil
	}
	p = strings.ReplaceAll(p, "\\", "/")
	if strings.Contains(p, "\"") {
		p = unquoteGitPath(p)
	}
	p = strings.TrimPrefix(p, "./")
	parts := strings.Split(p, "/")
	if strip > 0 {
		if len(parts) <= strip {
			return "", &patchError{Code: patchErrPathDenied, Msg: "路径层级超出实际深度", Detail: raw}
		}
		parts = parts[strip:]
	}
	clean := strings.Join(parts, "/")
	if clean == "" {
		return "", &patchError{Code: patchErrPathDenied, Msg: "路径为空", Detail: raw}
	}
	if strings.HasPrefix(clean, "/") || strings.Contains(clean, ":") {
		return "", &patchError{Code: patchErrPathDenied, Msg: "不允许绝对路径或盘符", Detail: raw}
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." {
			return "", &patchError{Code: patchErrPathDenied, Msg: "不允许上跳目录", Detail: raw}
		}
		if seg == "." || seg == "" {
			return "", &patchError{Code: patchErrPathDenied, Msg: "路径含空段或 .", Detail: raw}
		}
		if strings.HasSuffix(seg, " ") || strings.HasSuffix(seg, ".") {
			return "", &patchError{Code: patchErrPathDenied, Msg: "路径段以空格或点结尾（Windows 非法）", Detail: raw}
		}
	}
	lower := strings.ToLower(clean)
	if lower == ".git" || strings.HasPrefix(lower, ".git/") {
		return "", &patchError{Code: patchErrPathDenied, Msg: "不允许修改 .git 目录", Detail: raw}
	}
	if strings.HasPrefix(lower, ".cadt/patches/") || lower == ".cadt/patches" ||
		lower == ".cadt/permissions.json" {
		return "", &patchError{Code: patchErrPathDenied, Msg: "不允许修改补丁目录或权限配置", Detail: raw}
	}
	return clean, nil
}
