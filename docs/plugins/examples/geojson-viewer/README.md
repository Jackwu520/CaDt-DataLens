# GeoJSON 地图预览（示例插件）

演示两个扩展点，零第三方依赖（核心包体积预算 = 0）：

| 扩展点 | 位置 | 做什么 |
| --- | --- | --- |
| `cadt.registerViewer` | `main.js` 末尾 | 把 `.geojson` 加一个「地图」视图：canvas 等距圆柱投影，画出 Polygon / LineString / Point；`resize()` 跟随容器、`setTheme()` 跟随主题、`destroy()` 断干净监听 |
| `cadt.registerImporter` | `main.js` 中部 | 内置解析不了的 `.bin` → 只读虚拟文档里的十六进制取样表（`ctx.readBinaryFile` 取 base64） |

安装方式：把本目录整个复制到 设置 → 插件与市场 → 「添加插件文件夹」选中的目录下（或插件目录里），然后在插件列表启用。

用法：打开一个 `.geojson` 文件 → 标签页右上角视图按钮或底栏「视图」里选「地图」；打开一个 `.bin` 文件 → 弹框选「导入」。

**插件作者注意**：视图只渲染、不改数据——要落地修改请调 `ctx.requestSave(text)`；`destroy()` 里必须释放定时器 / `ResizeObserver` / `window` 监听，宿主在切视图与关标签时只会调一次 `destroy()`。完整约定见 [`../../README.md`](../../README.md) 的 `cadt.registerViewer` / `cadt.registerImporter` 两节。
