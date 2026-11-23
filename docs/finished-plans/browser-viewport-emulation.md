# 内嵌浏览器：分辨率与显示比例解耦（页面视口仿真）

日期：2026-11-23
状态：已实现

## 问题

浏览器标签的「视口尺寸」菜单选了 `375 × 812（iPhone）`，页面完全没有变化：`innerWidth`、媒体查询命中、元素尺寸都还是标签页的宽度。选分辨率实际上只改了可视框大小，等于选了框的尺寸。

## 根因（本机实测，960×540 可视框，显示器 150%）

| 尝试 | 页面 `innerWidth` | `devicePixelRatio` | 结论 |
| --- | --- | --- | --- |
| `RasterizationScale = 1.25` | 640（= 物理宽 ÷ DPI 比例） | 1.5 | 只影响栅格化密度，**不参与布局** |
| `RasterizationScale = 3` | 640 | 1.5 | 同上，值确实写入（`get` 回读 3.0）但不生效 |
| CDP `Emulation.setDeviceMetricsOverride(1280×720, dsf 1, dontSetVisibleSize)` | 1280 | 1 | 布局钉住了，但**画面被可视框裁掉**（右下角固定元素在截图里消失，不是等比缩小） |
| 同上 + `deviceScaleFactor 0.75` | 1280 | 0.75 | 仍然裁切 |
| 同上 + `PutZoomFactor(0.75)` | 1707 | 0.75 | metrics 宽再被 zoom 除一次，两者不能叠加 |
| **`PutZoomFactor(0.5)`** | **1280** | **0.75** | ✅ 布局 1280、画面等比缩进 960×540（右下角元素出现在截图右下角） |

`COREWEBVIEW2_BOUNDS_MODE_USE_RASTERIZATION_SCALE` 能把 bounds 当逻辑尺寸（布局确实变成设定值），但 raw 尺寸 = 逻辑 × 显示器比例，等于把控件放大出去而不是缩进来，且 `RasterizationScale` 依旧不参与换算——也不能用。

## 方案（对齐 zcode 内置浏览器）

分辨率与显示比例是两件事：

- **分辨率** = 页面 CSS 视口（`doc.browserViewport = {mode:'fit'} | {mode:'fixed', width, height}`）
- **显示比例** = 预览缩放（`doc.browserZoom = 'fit' | 50 | 75 | 100`）

实现只用 WebView2 的页面缩放，一个属性解决问题：

```
CSS 视口宽 = 物理宽 ÷ (窗口 DPI 比例 × ZoomFactor)
⇒ ZoomFactor = 物理宽 ÷ (DPI 比例 × 视口宽)      // 宽、高各算一次取小，避免 1px 滚动条
⇒ 画面缩放   = 物理宽 ÷ 视口宽                    // 与 DPI 无关，正好铺满可视框
```

- 前端把逻辑宽高随 `BrowserSetBounds` 一起下传（`vpW/vpH`，自适应传 0），`Go` 侧用 `GetDpiForWindow` 取窗口 DPI 比例后重算 `ZoomFactor`，并把生效值缓存在实例上避免每次轮询重复设置。
- 导航会重置页面缩放：`NavigationCompleted` 后按记住的物理尺寸 / 逻辑视口重放一次。
- 前端 `browserViewportVisualScale = min(档位, contain 适配系数)`：档位超过「放得下」按 contain 兜底，按钮显示**真实生效比例**（`1280×720 · 70%`），不出现「选了 100% 却看不出区别」的错觉。原生控件没法像 `<webview>` 那样用 CSS transform 缩放，放大到超出容器会盖住界面，所以不提供 >100% 的超框缩放。
- 已知边界：`ZoomFactor` 合法区间 0.25–5。容器比分辨率小 4 倍以上（如 320px 宽的标签页里选 1440×900）时缩放被钳在 0.25，画面仍铺满可视框，但页面拿到的逻辑视口会小于设定值——宁可画面不错位，也不为了一个极端比例让整页溢出去盖住界面。

## 改动

- `internal/browser/browser_windows.go`：`BrowserSetBounds(id, x, y, w, h, vpW, vpH)`；新增 `browserApplyViewportZoom` / `browserWindowDpiScale`；删除 `browserApplyRasterScale` 与 `ctrl3` / `raster` 字段（含关闭时的接口释放）。
- `internal/browser/browser_other.go`：桩同步新签名。
- `frontend/src/editor/editor-browser-tab.js`：`browserZoom` 状态、`browserViewportVisualScale`、缩放档位菜单与真实比例文案、`browserSurfaceRect` 上报逻辑视口、`syncBrowserTab` 缓存键改为 `vpW/vpH`。
- `frontend/src/dev/mock-backend.js`、`frontend/src/ai/ai-panel.js`（`browser_resize` 返回文案）。
- 测试：`internal/browser/browser_viewport_windows_test.go`（冒烟，`-v` 显式运行）、`frontend/test/editor/editor-browser-tab.test.mjs` 补 3 例。

## 验证

- `go test ./internal/browser -run TestBrowserViewportEmulation -v -timeout 120s`：960×540 框 → 视口 1280×720 且 `dpr` 小于显示器比例；框减半 → 视口不变、`dpr` 更小；换 375×812 → 视口跟随；回自适应 → 物理宽 ÷ dpr。
- `npm test`、`npm run build`、`go build ./...` 通过。
