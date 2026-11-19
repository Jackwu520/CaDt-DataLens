# 外部文件预览方案评估：open-file-viewer 与 kkFileView

> 状态：**评估完成，结论为不引入**（2026-11-18 调研成文，只做选型评估，未修改任何实现代码；当日结论：**两者均不引入**；2026-11-21 从 `unfinished-plans/` 归档到 `reports/`——它不会再产生实施动作，留作选型依据与决策记录）
> 触发：用户要求研究 open-file-viewer 与 kkFileView 两个开源预览项目跟本项目的适配程度。
> 范围：候选项目事实核对 + 与本项目设计约束逐项对照 + 缺口分析 + 路线建议。
> 非目标：不立项 PDF / Office 预览的实现（如开工另立方案）；不评估其他候选（dhjz/file-preview 等）；不动 formats.js 与插件层。

---

## 1. 结论摘要

**两个都不引入。** 它们代表文件预览的两条路线，与本项目的匹配度分别是：

| 候选 | 形态 | 许可证 | 结论 |
|---|---|---|---|
| [open-file-viewer](https://github.com/xushanpei/open-file-viewer) | 纯前端预览 SDK（per-format 插件，渲染进调用方给的 DOM 容器，不开新窗口） | MIT 核心；CAD 插件依赖 GPL-3.0 LibreDWG | **不整体引入**：方向一致但撞体积与供应链红线（§4）；架构形态可借鉴（§6） |
| [kkFileView](https://github.com/kekingcn/kkFileView) | 服务端集中预览（Spring Boot + JDK 21 + 内置 LibreOffice 转码，REST 出预览页） | Apache-2.0（已核 LICENSE 原文） | **不引入**：产品路线根本错位——企业内网统一预览服务 vs 单 exe 零依赖本地直读（§4） |

盘点现状后的真实缺口只有一项高频能力：**PDF 原生预览**（xlsx/pptx 次之，可接受继续走系统默认程序）。docx/epub 已有 reading 模式只读覆盖、音视频已有系统引擎，均无需外部方案。

---

## 2. 候选项目事实核对

### 2.1 open-file-viewer（xushanpei/open-file-viewer）

| 项 | 事实（2026-11-18 核对 GitHub README + npm 元数据） |
|---|---|
| 版本 | npm `@open-file-viewer/core` dist-tags：`latest=1.0.0` / `rc=1.0.0-rc.2`——刚离开长期 rc 期，API 未经过完整稳定周期 |
| 架构 | core + React/Vue/Svelte 三个适配器的 monorepo（pnpm workspace）；每个格式一个插件，渲染进调用方给的 DOM 容器；自动检测 qiankun/micro-app 沙箱并修 jszip 的 setImmediate（微前端向） |
| 能力边界 | **纯只读**：缩放/旋转/下载/全屏/打印/搜索、多文件队列、分页；没有任何编辑能力 |
| 格式覆盖 | 图片（jpg/png/gif/webp/avif/svg/tiff/heic）、音视频（mp4/webm/mkv/m3u8/mp3/flac）、文本/代码、PDF（pdfjs-dist）/epub/xps/oxps、Office（docx/xlsx/pptx/odt/rtf/wps，旧版 ppt 走本地 OLE 解析）、OFD、压缩包（zip/rar/7z/tar）、邮件（eml/msg/mbox）、画板（drawio/excalidraw/tldraw）、XMind、CAD（dxf/dwg/step/iges/ifc）、3D（gltf/obj/stl/fbx）、GIS（geojson/kml/shp）。官方口径：复杂格式为渐进增强，不一定高保真 |
| 体积 | 核心包解压 **7,379,406 字节 ≈ 7.04 MiB**；**25 个直接 dependencies**：three 0.184、mermaid 11、leaflet、hls.js、mammoth、xlsx（@stackline/xlsx 别名）、docx-preview、jszip、marked 18、prismjs、dompurify、postal-mime、ag-psd、utif、pako、shpjs、hyparquet、seek-bzip、xz-decompress、topojson-client、@mapbox/togeojson、@kenjiuno/msgreader、@aiden0z/pptx-renderer、heic2any、emf-converter；另有 **5 个 optional peerDependencies**（lodash-es、pdfjs-dist、@mlightcad/data-model、@mlightcad/libredwg-web、@mlightcad/cad-simple-viewer）；有 `lite` 入口（只含运行时 + 图片/PDF/fallback 插件）收敛依赖图 |
| 重活外包 | Office 大文件可经 `officePlugin({ convertRemote })` 调外部转换服务（可选增强）；未集成 LibreOffice/WPS 服务端 |
| 许可证 | 核心 MIT；**dwg 能力依赖 @mlightcad/libredwg-web（GPL-3.0）**——引入即踩本仓库 Apache-2.0 分发的红线，必须整体剔除 CAD |
| 安全 | DOMPurify 清洗，与本项目 `core/markdown.js` 同一清洗标准（好） |

### 2.2 kkFileView（kekingcn/kkFileView）

| 项 | 事实（2026-11-18 核对仓库 README 与 raw LICENSE） |
|---|---|
| 定位 | 文件文档**在线预览解决方案**，9.9k+ star，企业内网统一预览服务；v5.x 起要求 **JDK 21+** |
| 技术栈 | Spring Boot + Freemarker + Redisson + JodConverter；Redis 可选（默认不需要）；**内置 LibreOffice 7.5.3 Portable**（Windows 发行版自带，Linux/Docker 自动装，macOS 手动装） |
| 部署 | Jar / Docker（`keking/kkfileview`，支持 ARM64）/ zip·tar.gz 一键脚本；默认端口 **8012**；转换结果多线程异步 + 定时缓存清理（cron 可配） |
| 接入 | REST——传文件 URL（Base64 + urlencode **双重编码**以兼容特殊文件名）；`trust.host` 信任站点（5.0.0 起支持通配符与 CIDR）；水印 / Basic 认证 / AES 加密 / 防重复转换等参数化；配置项全部可走环境变量（集群向） |
| 格式覆盖 | Office 全家、WPS（wps/dps/et）、odt/ods、Visio（vsd/vsdx）、PDF/OFD/RTF、epub、eml/msg、psd/eps、wmf/emf、xmind、bpmn、drawio、dcm 医学影像、3D（obj/stl/gltf/fbx）、CAD（dwg/dxf）、纯文本渲染、压缩包、图片（含 heic/tif/svg/tga）、音视频——靠服务端 LibreOffice 转码，覆盖面是两者中最广的 |
| 许可证 | **Apache-2.0**（已核对 raw LICENSE 全文），与本项目同许可 |
| 安全 | **5.0.1–5.0.3 连续修复 SSRF / 路径穿越 / XSS**，官方强烈建议旧版升级——作为常驻网络服务，攻击面持续存在；接入时与本项目 `webValidateURL` 的 SSRF 防护文化是两套威胁模型，需分开对待 |

---

## 3. 本项目现状（代码事实）

- 支持格式注册在 `frontend/src/core/formats.js`（536 行）：JSON/JSONL、YAML、XML/SVG、CSV/TSV、TOML、INI、Markdown、代码文本；**图片已有**（`imageExtensions` formats.js:321）；**音视频已有**（`videoExtensions` formats.js:328 / `audioExtensions` formats.js:332，走系统媒体引擎）。
- **PDF 未注册**：formats.js 无 pdf 分支（全文件 grep 无命中），`.pdf` 落到 binary/hex 视图 + `shellexec`（ShellExecuteW）用系统默认程序打开。
- **docx/epub 已有只读渲染**：`frontend/src/reading/reading-render.js:3`（docx 块 → HTML、epub 经 DOMParser 清洗套阅读排版 + LRU 缓存，纯 JS 自研，零外部依赖）。阅读模式整体只读（AGENTS.md 明令禁止调写接口）。
- **重格式扩展点已预留两处**：`registerPluginFormat`（formats.js:360，插件注册新格式驱动）与 `cadt.registerDocConverter`（shell/plugins.js，文档格式转换器；「真 .docx/PDF 等重格式能力在插件侧」是既定方针，官方插件 export-word 走此口）。
- AI 侧通路：`frontend/src/ai/ai-constants.js:460-479` 的 docx/pdf 技能明确指示经终端用 LibreOffice（`soffice --headless --convert-to`）/ python-docx / pypdf 完成——重格式已有可用的命令行出口。
- 体积基线（docs/reports/optimization-proposals.md）：mermaid 2.57 MB 是当前 vendor 天花板（懒加载，`ensureMermaidScript()` 先例）；可视化引擎例外（ECharts 6 1.07 MiB + ELK.js 1.57 MiB + 词云 52 KiB = **+2.69 MiB**，预算 ≤5 MB，2026-11-13 作者批准，`public/vendor/` 懒加载、只出静态 SVG，见 docs/finished-plans/visualizer.md——**不要拿这个例外给别的依赖开绿灯**）。
- 文件大小硬闸：>10 MB 只读、>100 MB 拒开（app_core.go `largeFileBytes` / `maxFileBytes`），任何预览增强都要在这之内工作。

---

## 4. 逐项对照设计约束

| 约束（AGENTS.md） | open-file-viewer | kkFileView |
|---|---|---|
| **单 exe、零依赖、系统提供引擎** | ✅ 纯前端，WebView2（系统 Chromium）即可跑，与「系统提供引擎」哲学同向 | ❌ 根本性错位：JDK 21 + LibreOffice Portable 合计数百 MB + 常驻 localhost:8012 服务 |
| **体积第一约束**（新依赖先问能否不引入；不打包 Chromium/Node/rg/SQLite/LSP） | ❌ 核心 7.04 MiB 起步 + 25 直接依赖的传递树；即使 `lite` 入口，PDF.js + WASM 也是 MB 级；会引入第二份 mermaid/hljs/marked 与现有渲染链重复 | ❌ 量级根本不在一个世界 |
| **不许 GPL 进包**（Apache-2.0 仓库分发 exe） | ⚠️ dwg/dxf 能力必须整体剔除 | ✅ Apache-2.0 无冲突 |
| 与现有能力重叠 | 中：docx（docx-preview/mammoth）、epub 与 reading 模式重叠；mermaid/marked/prismjs 与现有 vendor 重叠 | 无重叠概念（外部服务） |
| API 稳定性 | ⚠️ 1.0.0 刚发（此前长期 rc） | 稳定，但接口是企业接入向（URL 双重编码、trust.host、水印、Basic 认证） |
| 安全基线 | ✅ DOMPurify，与 markdown.js 同标准 | ⚠️ 近期连修 SSRF/路径穿越/XSS，常驻服务攻击面 |

---

## 5. 差距分析

**已覆盖（不需要外部方案）**：docx/epub 只读（reading 模式自研渲染）、音视频（系统媒体引擎）、全部数据格式与代码文本、未知格式兜底（hex + 系统默认程序）、AI 侧 docx/pdf 重格式（LibreOffice 命令行技能 + 插件市场）。

**真实缺口只有一项：PDF 原生预览**。现在 `.pdf` 只能 hex 或弹外部程序，与其「多格式数据查看器」的定位不符，且 PDF 是业务文件中出现频率最高的格式。xlsx/pptx 次之——业务上通常装有 Office/WPS，走系统默认程序可接受，不必内置。

---

## 6. 结论与路线建议

1. **kkFileView：不引入。** 它解决的是「企业内网统一附件预览」问题（中心部署、HTTP 传 URL、服务端转码），与本项目「单 exe、零依赖、本地直读」是两条根本不同的产品路线，引入即违反全部设计约束。唯一理论接触点：作为**外部工具的可选能力源**——用户单位已有 kkFileView 部署时，经外部工具配置 + 内嵌浏览器标签页（`browser_app*.go` + `internal/browser`）打开预览 URL。属锦上添花，不值得主动投入。
2. **open-file-viewer：不整体引入，可借鉴形态。** 方向一致（桌面本地预览、纯前端、MIT、只读），其「per-format 插件注册、渲染进容器、不开新窗口」与本项目 `registerPluginFormat`（formats.js:360）的精神完全同构。但整体引入撞三条红线：① 体积（7.04 MiB 核心 + 依赖树，远超 visualizer 例外 +2.69 MiB 的量级）；② 供应链（25 个直接依赖的传递风险）；③ GPL（CAD 能力必须剔除，等于砍掉其宣传重点之一）。且其 mermaid/marked/prismjs 与现有渲染链重复，等于 vendor 两份。
3. **PDF 若要补**：按 visualizer 先例走「单库 + 懒加载 + 单独立项审批」，不搭 SDK 的车——
   - 引擎选 pdfjs-dist（MIT/Apache 双许可，构建后约 1–2 MiB 级，Mozilla 维护，事实标准），放 `public/vendor/` 按需 import，模式照抄 `ensureMermaidScript()`；
   - 立项时需作者单独批准体积例外（先例口径 ≤5 MB 单次批准）；
   - canvas 渲染 + DOMPurify 不适用（canvas 不走 DOM 清洗），安全边界以「只渲染、禁脚本、禁外链资源」为准，参照 chart-render.js 的白名单思路；
   - xlsx/pptx 不内置，优先系统默认程序 + 插件市场（`cadt.registerDocConverter`）。

---

## 7. 重新评估的触发条件

- open-file-viewer 按格式拆包发布（或 `lite` 入口的依赖图收敛到可直接审计的规模），且 mermaid/marked/prismjs 等与现有渲染链重复的依赖可复用本项目 vendor。
- 用户明确提出 PDF 内置预览需求，作者批准新的体积例外。
- 用户单位已有 kkFileView 部署，需要外部工具来源接入时再议（工作量小：一个能力来源配置 + 内嵌浏览器标签页）。
