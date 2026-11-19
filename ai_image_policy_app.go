package main

// ai_image_policy_app.go：AI 图片上限的 Wails 绑定——引擎在 internal/aiimagepolicy，
// 这里只把单一真源投影给前端（前端启动时拉一次，与 dsh 的 imageLimits 投影同构）。
//
// 限制值刻意不暴露设置页：与 codex / opencode / ZCode / dsh 一致，全部硬编码在引擎包内，
// 前端只消费同一份数值，避免前后端各写一份而漂。

import "datalens/internal/aiimagepolicy"

// AIImageLimits 返回当前图片三层限制（源准入 / 归一化 / 请求预算）。
// 前端 ai-image-policy.js 的 load() 调它；失败或缺值回落到前端内置的镜像默认值。
func (a *App) AIImageLimits() aiimagepolicy.ImageLimits {
	return aiimagepolicy.Get()
}
