# 内置 PDF / xlsx / docx 预览（分期方案）

> 状态：**未开工**（2026-11-18 评估成文，方案随外部预览选型调研 `docs/reports/external-file-viewers.md` 的讨论定稿；未改实现代码）
> 触发：作者确认「格式覆盖是核心价值」，批准按分期路线补齐预览缺口；PDF / xlsx / docx 三期，每期单独报批体积例外。
> 范围：三个高价值格式的**只读预览**（binary 视图族新增成员），走 vendor 懒加载 + 现有组件复用，不引入 open-file-viewer / kkFileView（选型依据见 `docs/reports/external-file-viewers.md`）。
> 非目标：不做编辑/回写（xlsx 写盘、PDF 表单）；不做 pptx / OFD / CAD / 3D / 压缩包预览；不给 AI 加 PDF 文本提取工具；不接 sqlview 到 xlsx；不改文件大小硬闸。

---

## 1. 结论摘要

三个格式全部按「binary 视图族新成员」接入——Go 侧 fileio 分类旗标 + 前端新视图/复用视图，与 image/video/audio 完全同构：

| 期 | 格式 | 引擎 | exe 增量（约） | 复用 | 新依赖 |
|---|---|---|---|---|---|
| **P1** | PDF | pdfjs-dist 6.5.438（Apache-2.0） | 1.5–2 MiB | image 视图的加载/回退模式 | vendor 2 件 |
| **P2** | xlsx | SheetJS 社区版 0.20.x（Apache-2.0） | 0.9–1 MiB | `editor-csv-view.js` 表格全套 | vendor 1 件 |
| **P3** | docx | 无（Go `internal/reading` 现成解析） | ≈0 | `ParseReadingDocx` + `reading-render.js` | **零** |

合计约 2.4–3 MiB，落在 visualizer 例外（+2.69 MiB）同量级；每期独立报批、独立构建实测。引擎均以 **vendor 构建文件**（`public/vendor/` + `licenses/` 登记）进包，**不走 npm**——不增加 node_modules 依赖树，供应链面最小化。

---

## 2. 本项目现状（代码事实，2026-11-18 核对）

### 2.1 Go 侧分类链（`internal/fileio/fileio.go`）

- `GetFileContent` 分类流 fileio.go:67-91：`isImageFile / isVideoFile / isAudioFile(path, raw)` 扩展名 + 魔数双闸，互斥优先级 视频 > 图片 > 音频；`.bin`/image/video/`chardec.LooksBinary(raw)` → 二进制 `FileData`（带 `Image/Video/Audio` 旗标，Content 是 `imageHexDump`）。
- 扩展名表：`videoExtensions` fileio.go:173、`audioExtensions` :201、`imageExtensions` :130——**与前端 `core/formats.js` 同表约定**（formats.js:322 注释明确）。
- 大小闸：>100 MB 拒开（fileio.go:59）；hex 截断 `imageHexLimit`（fileio.go:84）。
- `ReadImageAsDataURL(path)`：图片视图取真实字节的绑定（app_file.go，32 MB 预览上限）——PDF/xlsx 取字节的现成模板。
- `ParseReadingDocx(path) → reading.ReadingDocx`：**docx 块级解析绑定已存在**（frontend/wailsjs/go/main/App.d.ts:439，引擎在 `internal/reading`）。

### 2.2 前端接线点

- 二进制 doc 创建 editor-groups.js:1263-1291：`format = formats.image/video/audio/bytes`（formats.js:288-318，binary 条目 `rawOnly: true`、无 parse/stringify），`mode: defaultMediaMode(data) || 'binary'`（formats.js:342）。
- 视图创建 editor-groups.js:1260-1265：`if (fmt.image) createImageView(doc)` 等四连；视图工厂在 editor-split-preview.js（`createImageView` :516）。
- 图片视图加载/回退模式 editor-split-preview.js:652-672：`ReadImageAsDataURL` → 失败 `flash` + `switchMode('binary')`——**PDF 视图照抄**。
- 表格视图输入契约 editor-csv-view.js：`createCsvTableView(doc)` 消费 `doc.tableHeaders` / `doc.tableRows`（`csvViewIndices` :108），排序/筛选/列统计/缩放都在这两份数据上工作——**xlsx 填两字段即可白得全套**。
- 视图选项 writing-ui.js `viewOptionsFor` :81：image/video/audio/bytes 各有清单；虚拟文档返回 `[]`。
- 模式校验 editor-groups.js:378-381 与 `viewDisabled`——新 mode 要进这两处。
- 卸载 closeDocNow editor-groups.js:1582：`releaseVideo / releaseAudio` 先断源再摘节点的先例 :1590-1592。
- `isSupportedFile` formats.js:403（文件树可点击白名单）、`openFileFilters` formats.js:416（打开对话框）。
- vendor 懒加载先例：mermaid `ensureMermaidScript()`（main.js）、d3-cloud `@vite-ignore` 动态 import（wordcloud-render.js）、资源与许可登记 `public/vendor/` + `licenses/`。
- mock 二进制文档形状 mock-backend.js:743（`{binary: true, image: true, content: …}`）；内联 base64 字面量先例 mockImageDataUrl :291。
- fileicons.js 无 pdf/xlsx/docx 图标（今天全落通用图标）。

---

## 3. P1：PDF 预览

### 3.1 依赖与加载

- **vendor**：`public/vendor/pdfjs/pdf.min.mjs` + `pdf.worker.min.mjs`（pdfjs-dist **6.5.438** 官方构建，Apache-2.0；许可登记 `licenses/`）。exe 增量打包实测后填入本方案。
- **loader**：`ensurePdfJs()` 放 editor-pdf-view.js 内——`import(/* @vite-ignore */ base + 'vendor/pdfjs/pdf.min.mjs')`，`GlobalWorkerOptions.workerSrc` 指同目录 worker（`new URL` 模式）；加载失败 flash 提示并停留 hex 视图。

### 3.2 Go 侧

- fileio.go：`pdfExtensions` 表（`.pdf`）+ `isPdfFile(path, raw)`（前 1 KiB 内 `%PDF-` 魔数）；`FileData` 加 `Pdf bool`；互斥优先级插在 video 之前（PDF 魔数不会与图片家族冲突）。
- 新绑定 `ReadPreviewFileBase64(path) (string, error)`：扩展名白名单 pdf/xlsx/docx + ≤32 MB（对齐 imagePreviewLimit）+ 现有路径/只读闸复用；返回 base64。图片视图的 `ReadImageAsDataURL` 保留不动（职责不同：白名单与上限语义各异）。

### 3.3 前端

- formats.js：`formats.pdf`（`rawOnly: true`，仿 formats.bytes :312）+ `pdfExtensions` 同表 + `defaultMediaMode` 加 `if (source.pdf) return 'pdf'`；`isSupportedFile` / `openFileFilters` 同步。
- 新模块 `src/editor/editor-pdf-view.js`（factory + deps 注入，照 editor-csv-view.js 先例）：
  - `getDocument({data: bytes, isEvalSupported: false, isScriptingEnabled: false, disableFontFace: false})` → canvas 渲染当前页；**不开 text layer**（不注入文本 span，搜索与选择 MVP 不做，安全面最小）；
  - 工具栏：页码输入（`createInput` 工厂，禁裸 `<input>`）+ 翻页按钮 + 缩放档位 + 适配宽度；图标按钮挂 `data-tip`（tooltip 规范：停留 1s 才出）；
  - 失败路径照图片视图先例：flash + `switchMode('binary')`；
  - `closeDocNow` 加 `releasePdf(doc)`：`pdfDoc.destroy()` + canvas 置空（照 releaseVideo 先例）。
- editor-groups.js：binary 分支 `format` 加 pdf 三元、`createPdfView(doc)` 调用点、mode 校验 :378-381 加 `'pdf'`、`viewDisabled` 加分支；writing-ui.js `viewOptionsFor` 加 `fmt.id === 'pdf'` → `[]`（单一视图，无切换）。
- fileicons.js：pdf 图标。

### 3.4 安全边界

- pdf.js 从不执行 PDF 内嵌 JS；显式关 `isEvalSupported` / scripting；无 text layer 即无链接注入面；不传 cMapUrl/standardFontDataUrl（字体缺失按 pdf.js 默认降级渲染，不外联）；canvas 产物不经 DOMPurify（无 DOM 注入）。
- 渲染用 `textContent` 一律不接文件内容进 innerHTML。

### 3.5 测试与登记

- Go：fileio_test.go 加 pdf 分类用例（扩展名 + 魔数 + 互斥）。
- 前端：页码 clamp / 缩放档位 / 适配宽度计算抽纯函数配 `frontend/test/editor/editor-pdf-view.test.mjs`，登记 `npm test` 清单。
- mock：手写单页最小 PDF 字面量（`%PDF-1.4 …` 数百字节）进 mock-backend `?pdf` 场景。

---

## 4. P2：xlsx 预览

### 4.1 依赖与加载

- **vendor**：`public/vendor/xlsx/xlsx.full.min.js`（SheetJS 社区版 **0.20.x**——npm 上的 0.18.5 已停更，从官方 cdn.sheetjs.com 取构建文件；Apache-2.0；许可登记 `licenses/`）。UMD 全局加载，`@vite-ignore` 动态注入 `<script>`（照 mermaid 先例）。

### 4.2 Go 侧

- fileio.go：Office zip 双格式判定 `isOfficeFile(path, raw)`（扩展名 `.xlsx`/`.xlsm`/`.docx` + `PK\x03\x04` 魔数）；`FileData` 加 `Xlsx bool` / `Docx bool`（P3 用）；优先级排在 LooksBinary 之后、兜底 bytes 之前。

### 4.3 前端

- formats.js：`formats.xlsx`（`rawOnly`）+ 同表扩展名 + `isSupportedFile` / `openFileFilters`。
- 新模块 `src/editor/xlsx-grid.js`（**纯函数**）：SheetJS `read(arrayBuffer)` → 第一个可见 sheet → `sheet_to_json({header:1})` → `{headers, rows}`；含 sheet 选择、行列归一、**硬上限裁剪**（如 5 万行 / 500 列，超限截断 + 状态条提示，对齐 explorer 目录条目硬上限精神）；SheetJS 本体不进 node 测试。
- editor-groups.js：binary 分支 xlsx 路径——`xlsx-grid` 填 `doc.tableHeaders/tableRows` → **直接 `createCsvTableView(doc)`**，排序/筛选/列统计/缩放全套复用；mode 走 `'table'`，`viewOptionsFor` 对 xlsx 返回 `CSV_VIEWS` 或 `[]`（实施时定，倾向 `[]`——无 code 视图）。
- **只读红线**：不接 CSV 视图的单元格编辑与回写（xlsx 写盘涉及样式保持，明确不做）；视图内编辑路径以 `doc.readOnlyLocked` 关闭。
- 多 sheet：MVP 表格条内 sheet 切换按钮（行内控件，非新视图模式）。
- fileicons.js：xlsx 图标。

### 4.4 安全边界

- SheetJS 解析不执行宏/公式求值（默认行为即如此）；单元格值全部经 `textContent` 进 DOM，零 innerHTML。
- `isSqlSupportedDoc`（writing-ui.js:89）不动——sqlview 不接 xlsx（后续另议）。

### 4.5 测试与登记

- Go：fileio_test.go 加 Office zip 分类用例。
- 前端：`frontend/test/editor/xlsx-grid.test.mjs`（sheet 选择/裁剪/空表/行列归一），登记 `npm test`。
- mock：用 vendor SheetJS 现场生成一个两 sheet 工作簿（mock-backend `?xlsx` 场景）。

---

## 5. P3：docx 预览

### 5.1 零新依赖

- 解析复用 `ParseReadingDocx(path)`（App.d.ts:439，`internal/reading` 现成引擎）；渲染复用 `reading-render.js` 的 `renderDocxBlocks`（:208）——**实施时先核对该函数与 reading 模块的耦合度**（LRU、unit id），必要时把纯渲染部分提为独立导出，reading 模式不改行为。
- sanitize 硬要求不变：渲染走既有 DOMPurify 链（reading-render.js:259 已有 `ADD_ATTR` 白名单先例），**原始 HTML 不执行**。

### 5.2 前端

- 新模块 `src/editor/editor-docx-view.js`：`ParseReadingDocx` → `renderDocxBlocks` → 阅读排版样式复用（`.rd-` 前缀样式或提公共类，实施时定）；mode `'docx'`；`closeDocNow` 卸载。
- `formats.docx`（`rawOnly`）+ 同表扩展名 + `isSupportedFile` / `openFileFilters`；fileicons.js 加 docx 图标。
- **实施时核对**：`internal/reading` 的 docx blocks 是否含内嵌图——若不含，MVP 只渲染文本块，图片位置给占位提示，不做图提取。

### 5.3 测试与登记

- mock：最小 docx 生成——若 blocks 结构纯文本即可手写 JSON mock（`ParseReadingDocx` 在 dev mock 里直接返回假 blocks，无需真 docx 字节）。
- 渲染纯函数随 reading-render 既有测试覆盖；新增视图接线进 `npm test`。

---

## 6. 通用收尾（每期必做）

1. AGENTS.md 顶层格式清单（「项目概述」的支持格式句）与 README 对应小节同步；CHANGELOG 条目。
2. 构建实测 exe 增量回填本方案表格（对比 `docs/reports/optimization-proposals.md` 基线）；超预算即停，回报作者裁决。
3. `npm test` 清单登记（漏登记 = 测试从未跑过）；Go 侧 `go test ./internal/fileio/`（后台执行惯例）。
4. 提交一次一期，conventional commits + 中文描述，可单独 revert。

## 7. 验收与回退

- 每期验收：mock 场景 + 真实文件手测（正常/加密损坏/超 32 MB/超 100 MB 四态）；失败路径全部落到 hex/文本兜底视图（照图片视图先例），不出现空白标签页。
- 回退：每期一个 commit，revert 即回到 hex 兜底；vendor 目录随期删除。

## 8. 明确不做（本期边界）

- open-file-viewer / kkFileView 整体引入（见 `docs/reports/external-file-viewers.md` §6）；
- pptx / OFD / CAD / 3D / GIS / 压缩包 / eml 预览；
- PDF 文本层与搜索、PDF 外链点击、xlsx 编辑回写、docx 图片提取、AI 读 PDF 工具。
