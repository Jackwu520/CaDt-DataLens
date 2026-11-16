# read_image：给 AI 一条直读图片的通道（实施记录）

> 状态：**已完成**（2026-11-16，`npm test` 638 项全绿、`vite build` 通过）
> 起因：用户在编辑器里打开 `{工作区}/.cadt/gen/image/2026-11/xxx.png` 问「这张图怎么样」。模型翻了工具表发现只有 `read_file`（文本）与 `app_control`（窗口截图），于是打的算盘是「截应用窗口来看图」——绕一大圈、还要多花一次截图的上下文，且截的是渲染后的界面而不是原图。`read_file` 对图片的正确行为是报错：`二进制文件不可作为文本读取`（`readTextFile`）。也就是说**图片这条路原本不存在**，模型只能靠截图凑。

## 1. 决策

1. **独立工具而不是给 `read_file` 加分支**：`read_file` 的契约是「返回文本、可 offset/limit 分页、写文件前必须先读」，图片是「附加到对话、占上下文、不能分页」，混在一起会让工具描述自相矛盾（模型会尝试 `offset` 读图片）。
2. **复用既有的「图片进对话」注入链**，不新建通道：`backend.ReadImageAsDataURL` 读 data URL → `ai-image-encode.prepareImagePayload` 降采样 → `aiNormalizeImage` 归一化 → 挂成 `{role:'user', images:[…]}`。与用户粘贴图片、`browser_screenshot`、`generate_image review` 完全同一条链，服务商适配、落盘（`images/` 目录 + `file` 引用）、上下文估算、压缩归档都不用改。
3. **路径授权与 `read_file` 同源**：直接调 `resolveReadPathWithApproval(ctx, 'read_image', path)`——工作区外点名直读、`auto/full` 直读、`read/edit` 弹审批卡、应用数据目录硬拒、子代理不弹卡只报回，六条规则一处不改。
4. **图片消息延迟到工具批次结束再落盘**（本次唯一的架构性改动）：直接在 `executeTool` 里 `session.messages.push` 会插在 `assistant(tool_calls)` 与后续 `tool` 结果之间，OpenAI 会以「must be followed by tool messages」拒收整轮请求（多工具批次必踩）。新增 `pendingToolImages`（`WeakMap<session, message[]>`）+ `queueSessionImage` / `flushToolImages`，主循环与子代理循环都在批次边界 flush，紧挨着「push 新 assistant + `renderMessages`」——图片顺势渲染，不需要额外的重绘时机。**顺手修掉了 `generate_image review` 的同一个隐患**（它原来也是直接 push）。
5. **多模态门用「明确否定」语义**：只在 `entry.modalities.image === false` 时拒绝（那是用户在模型设置里明确关掉的）；字段缺省表示「不知道」，放行由服务商判定——与 `genReviewImages` 的 `=== true` 严格门有意不同：那边是**自动**回传图片，这边是模型**主动**要看。
6. **顺手补了发现性**：系统提示词的「当前活动文件」在图片上追加「（图片文件：要看画面用 read_image，read_file 读二进制会报错）」——用户开着图片提问是最常见的误判点，提示词不写，模型就会去截图。

## 2. 实现落点

| 部分 | 位置 |
|---|---|
| 图片编码单一来源 | **新增** `frontend/src/ai/ai-image-encode.js`：`isReadableImagePath` / `fitImageSize` / `encodeCanvasPayload` / `drawImagePayload` / `prepareImagePayload`。从 `ai-composer.prepareImageAttachment` 抽出（PNG→JPEG 0.86 起、每步 −0.1、下限 0.45，**行为逐字保留**），输入框与 `read_image` 共用 |
| 编码单测 | **新增** `frontend/src/ai/ai-image-encode.test.mjs`（9 例：扩展名白名单 / 等比缩放含 0 宽高兜底 / 预算内保持 PNG / 降质至预算内 / 压不下去与编码失败 / 画布缩放注入 / 上下文缺失 / 空数据与非图片串 / Blob 超限） |
| 工具定义 | `ai-tool-defs.js`：`read_image` def（description 写明分工、上下文成本、1600 长边与授权规则）+ `AI_TOOL_CATALOG` 条目（`read` 组）+ `toolsForScope` 基础表（**所有档位 + 计划模式**都下发，它只读）+ 工具链 `看画面：… read_image …` + `spawn_agent` 描述补「看图片」 |
| 执行分支 | `ai-panel.js` `case 'read_image'`：授权 → 多模态门 → `ReadImageAsDataURL` → `prepareImagePayload`（`AI_IMAGE_MAX_DIM/BASE64`）→ `aiNormalizeImage` → `queueSessionImage`（`app.kind='read-image'`）→ 返回「尺寸 + 格式 + 字节数」文本 |
| 批次边界 flush | `ai-panel.js`：`pendingToolImages` / `queueSessionImage` / `flushToolImages`；主循环工具批次后 flush；`genReviewImages` 改走队列 |
| 子代理 | `ai-subagents.js`：`subToolsForScope` 加 `read_image`；注入 `flushToolImages` 并在批次后（停止分支也）flush；`AI_SUB_SYSTEM_PROMPT` 的只读范围加「看图片」 |
| 工具卡 | `ai-tool-cards.js`：`toolMeta`（动词「看图」/ icon image）、`toolPrimary`（文件名 + 目录）、`toolFileVerb`（带文件类型图标）、路径可点击打开图片（保留展开正文看尺寸） |
| 消息卡 | `ai-app-message.js`：`read-image` kind → icon `image`；`ai-panel.renderAppMessage` 的带图页脚对非 browser/app kind 改取正文（去方括号），避免误标成「应用窗口截图」 |
| 系统提示词 | `ai-system-context.js`：活动文件是图片时追加 `read_image` 提示（`isReadableImagePath` 单一来源） |
| 测试清单 | `frontend/package.json` test 脚本加 `src/ai/ai-image-encode.test.mjs`；`ai-tool-defs.test.mjs` 新增「四档 + 计划模式都下发、只收 path、必须写进目录」 |

## 3. 边界与预算

- **格式**：png / jpg / jpeg / gif / webp / bmp / svg（后端 `ReadImageAsDataURL` 的 mime 表）。bmp / svg 不在 `AI_IMAGE_MIMES` 内，由画布统一转 png（超预算再转 jpeg）；gif 只取首帧。
- **体积**：源文件 >30MB 由后端拒绝；编码后 base64 上限 `AI_IMAGE_MAX_BASE64`（3MB）、长边 `AI_IMAGE_MAX_DIM`（1600）。压不下去明确报「压缩后图片仍然过大」，不静默丢图（与截图 / 引用同一「超限宁可拒绝」的口径）。
- **上下文**：每张约 800–1600 token（`aiEstimateImageTokens`），工具描述里直接写清楚「同一张图不要反复读」。
- **不做**：data URL 入参、裁剪/区域选择（v1 整图投喂）、图片编辑回写（属于 `docs/finished-plans/ai-gen-image-edit.md` 的图生图范围）。URL 入参已于 2026-11-17 补上，见第 5 节。

## 4. 手工回归清单

1. 打开一张 png → 问「这张图里有什么」，模型应调 `read_image` 而不是 `app_control`；对话里出现「读取图片」应用卡 + 图片，工具卡显示「看图 a.png · 1.2MB」。
2. 4K 截图（>2.2MB）→ 自动降采样，返回的尺寸应为缩后值（长边 1600）。
3. `bmp` / `svg` → 能看；`gif` → 看首帧。
4. 未勾选图像输入的模型 → 明确报错文案，不产生半条图片消息。
5. `read/edit` 档读工作区外图片 → 弹「想读取工作区外 …」审批卡（与 `read_file` 同一张卡）。
6. 一轮里并行调 `read_image` + `read_file` → 下一轮请求不被 400 拒收（图片消息必须在全部 tool 结果之后）。
7. 子代理派单「看一下这张截图」→ 能读；详情视图里出现「[图片：…]」正文块。
8. 会话重开后图片仍在（`images/` 目录 + `file` 引用正常）。
9. 给一个公网图片直链（如 `https://picsum.photos/640/360`）问「这张图里是什么」→ 模型应调 `read_image(path=<URL>)`；卡头显示「看图 picsum.photos/640/360」、出现「读取网络图片」应用卡 + 图片。给同一个链接让模型 `web_fetch` → 报错文案应指向 `read_image`。
10. 网图地址指向内网（如 `http://127.0.0.1/a.png`）→ 明确拒绝；项目规则 deny 该域名 → 直接拒绝、不抓取；ask 档 → 弹与 `web_fetch` 同一张「网络请求」审批卡。

## 5. 补：网图直读（2026-11-17）

起因：模型拿到 `https://picsum.photos/640/360` 去试 `web_fetch`，`web_fetch` 按文本契约拒绝（「该地址返回 image/jpeg」），模型只能回答「URL 有效、但工具不支持图片」——用户想看的画面一张也没看到。

1. **入口放 `read_image`，不放 `web_fetch`**：`web_fetch` 契约是「返回可截断文本 + 标题 + 链接」，图片是「附加到对话、占 token、不可分页」，合并会让模型拿 `maxChars` 截 JPEG；这也是第 1 节「独立工具而不是给 `read_file` 加分支」的同一条理由。
2. **不新增参数**：`path` 兼收 `http(s)://` 直链，少一个字段少一次填错（测试里锁死「只有 path」）。
3. **后端只加取字节那一步**：`webtools.FetchImage` 复用 `webRequest` → 内网/保留地址拒绝、重定向逐跳校验、超时与代理免费继承；专属差异是 16 MB 上限（网页 4 MB 按文本估，照片会被误判成截断）、`Accept: image/*`、**只信魔数**（`webImageMime`：SVG 按开头标记、AVIF 按 `ftyp` 品牌，其余靠 `http.DetectContentType`；站点谎报 `image/jpeg` 塞 HTML 明确报错）。
4. **安全与规则与 `web_fetch` 同源**：抽出 `gateWebTarget`（联网开关 → 项目域名规则 → 审批卡），`deny` 直接拒、`ask` 弹同一张卡、子代理不弹卡。审批对象新增 `web` 标记（`isWebApproval` 单一判定）：卡片文案按「访问网址」渲染（「本会话允许该网址」）、审计 kind 记 `web` 而不是 `command`——`read_image` 的**本地**读图审批仍是 `read`，不受影响。抓回来的图照旧走 `prepareImagePayload` → `aiNormalizeImage` → `queueSessionImage`，落盘与会话重开可见都无差别。
5. **可发现性**：`web_fetch` 遇到 `image/*` 的报错直接写「要看画面请用 read_image 并把这个 URL 作为 path 传入」；工具描述与只读工具链提示同步。
6. **卡片**：网图卡头显示「域名 + 路径」（`primary` 去掉 scheme、`dir` 空），且不挂本地文件链接、不渲染文件类型图标。

边界：需要登录 / 防盗链 / 返回 HTML 落地页的图片地址取不到，报错会如实说明；同一 URL 反复读会重复烧 token（描述里已写「同一张图不要反复读」）。
