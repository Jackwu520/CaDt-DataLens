package main

// 只读审阅解析的 Wails 入口：解析与行号组装都在 internal/patch
// （ParseReviewText / patchHunkToOut，后者也被 PatchPlan.ToPreview 复用）。

import "datalens/internal/patch"

// PatchParseText 解析补丁文本供只读审阅展示，不生成任何可应用的计划。
func (a *App) PatchParseText(text string) (*patch.PatchPreview, error) {
	return patch.ParseReviewText(text)
}
