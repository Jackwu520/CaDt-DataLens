package patch

// 只读审阅解析：把补丁文本切成「文件卡 / hunk / 行」的展示数据。
//
// 与 PatchPreviewText 的区别（AI「本轮改动审阅」用这里）：
//   - 不调用 BuildPatchPlan：不读目标文件、不做上下文匹配、不算落点，也就是没有预检；
//   - 不 PutPatchPlan：返回的 PatchPreview.PlanID 为空，天然无法进入 ApplyPatchPlan；
//   - 不写盘、不建索引、不产生任何副作用。
// 前端 patch-view.js 的 review 分支只消费 Files/Hunks/Lines/Added/Removed。

import "strings"

// patchHunkToOut 把解析出的 hunk 转成前端展示结构（含逐行旧/新行号）。
// 预检路径（PatchPlan.ToPreview）也复用它，避免两套行号算法。
func patchHunkToOut(index int, h patchHunk) PatchHunkOut {
	out := PatchHunkOut{
		Index:    index,
		Header:   h.Header,
		OldStart: h.OldStart,
		OldCount: h.OldCount,
		NewStart: h.NewStart,
		NewCount: h.NewCount,
		Lines:    make([]PatchLineOut, 0, len(h.Lines)),
	}
	oldLine, newLine := h.OldStart, h.NewStart
	for _, ln := range h.Lines {
		pl := PatchLineOut{T: string(ln.T), Text: ln.Text}
		switch ln.T {
		case '-':
			pl.OldLine = oldLine
			oldLine++
		case '+':
			pl.NewLine = newLine
			newLine++
		default:
			pl.OldLine = oldLine
			pl.NewLine = newLine
			oldLine++
			newLine++
		}
		out.Lines = append(out.Lines, pl)
	}
	return out
}

// ParseReviewText 解析补丁文本供只读审阅展示，不生成任何可应用的计划。
func ParseReviewText(text string) (*PatchPreview, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, NewPatchError(PatchErrEmpty, "补丁内容为空")
	}
	if len(text) > PatchMaxTextBytes {
		return nil, NewPatchError(PatchErrLimit, "补丁超过 2 MB，请拆分成多个补丁")
	}
	doc, err := ParsePatchText(text)
	if err != nil {
		return nil, err
	}
	out := &PatchPreview{
		Files:   make([]PatchFileOut, 0, len(doc.Files)),
		Added:   doc.Added,
		Removed: doc.Removed,
	}
	strip := detectStripLevel(doc.Files)
	for i := range doc.Files {
		f := &doc.Files[i]
		raw := f.RawNew
		if f.Kind == "delete" || raw == "" || isDevNull(raw) {
			raw = f.RawOld
		}
		rel, pe := stripPatchPath(raw, strip)
		if pe != nil || rel == "" {
			// 审阅路径只用于展示，绝不参与写盘；安全校验不通过时退回原文（去掉 a/ b/ 前缀）。
			rel = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(raw), "a/"), "b/")
		}
		fo := PatchFileOut{
			RelPath: rel,
			Kind:    f.Kind,
			Added:   f.Added,
			Removed: f.Removed,
			Hunks:   make([]PatchHunkOut, 0, len(f.Hunks)),
		}
		for j := range f.Hunks {
			fo.Hunks = append(fo.Hunks, patchHunkToOut(j, f.Hunks[j]))
		}
		out.Files = append(out.Files, fo)
	}
	return out, nil
}
