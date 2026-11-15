# generate_image 参考图编辑（图生图 / edits 端点）（方案）

> 状态：**未开工**（2026-11-16 评估成文，当日未实施）
> 决策依据：生成条目配置已上线（`docs/finished-plans/ai-gen-models.md`），`generate_image` 只发纯 prompt——而主流生图服务商（SenseNova `/v1/images/edits`、豆包、通义万相等）都提供「参考图 + 编辑指令」的图生图接口，且 SenseNova 类接口是 **JSON body**、支持 base64 Data URL 输入，现有哑通道即可承载；用户指定先出方案
> 范围：`generate_image` 工具新增参考图参数；条目新增编辑端点；同步型 JSON-body 的 edits 接口

## 1. 背景与现状（代码事实）

- **工具参数**：`generate_image` 现有 `prompt/model/size/n/outputPath/review`（ai-tool-defs.js），全部只服务于纯文生图。
- **模板层**：占位符词表 `GEN_PLACEHOLDERS = [prompt, model, size, n, seed, apiKey, jobId]`（ai-gen-model.js），条目无编辑端点字段；带 reference 时没有任何通路把图片塞进请求体。
- **本地图片读取（现成通道）**：`backend.ReadImageAsDataURL(path)`（app_file.go，上限 `imagePreviewLimit` 32MB）返回标准 `data:image/png;base64,…` 形态——正好是 SenseNova 类接口要求的 Data URL 输入格式；路径授权链 `resolveReadPathWithApproval`（read/edit 档弹卡、auto/full 直读、用户点名直读）与 read_file 同源。
- **Go 哑通道**：`AIGenHTTPRequest` 的 `spec.body` 是前端渲染好的字符串，Go 对请求体无大小校验（只限响应体 64MB）；`AIGenSaveProducts` 落盘不变。
- **同类先例**：SenseNova `/v1/images/edits`（JSON body，`images: [{image_url}]`，至多 5 张，`image_url` 接受公网 URL 或完整 Data URL，`size: "auto"` 自动适配主图）；豆包/万相等 JSON-body edits 同构。**OpenAI 官方 `/v1/images/edits` 是 multipart/form-data**，JSON 模板做不了——明确排除（见非目标）。

## 2. 目标与非目标

### 目标

1. `generate_image` 新增 `reference` 参数（string[]，至多 5 张）：元素为工作区相对路径、已授权的工作区外绝对路径，或 http(s) 图片 URL。
2. 条目新增 `editPath`（同步型编辑端点）与 `editImageWrap`（数组元素包装字段名，默认 `image_url`，空 = 裸字符串）；带 reference 的调用走 `editPath`，`bodyTemplate` 里用新占位符 `{{images}}`。
3. 参考图为本地文件时按 read 授权链解析（与 read_file 同源），读成 Data URL；URL 形态原样透传（由服务商拉取）。
4. 审批卡与工具卡展示参考图清单；留痕记录参考图数量（不记内容）。

### 非目标

- **multipart/form-data 的 edits 接口不支持**（OpenAI 官方 edits 是 multipart）——JSON 模板体系做不了 multipart，文档里明确标注兼容性，用户按服务商文档判断。
- 异步型（submit→poll）的编辑端点不做（当前已知 edits 接口均为同步）。
- `generate_video` 的参考图不做（视频服务参考图形态各家差异大，另行评估）。
- 参考图不做裁剪/预处理（原样投喂，尺寸适配交给 provider 的 auto）。

## 3. 设计

### 3.1 工具层

- `generate_image` 新增参数：`reference`（string[]，≤5）。传空数组 / 缺省 = 现状纯文生图。
- 带 `reference` 时：
  1. 逐个解析元素——`http(s)://` 开头原样保留；否则按工作区路径解析并走 `resolveReadPathWithApproval`（read_file 同链）。
  2. 本地文件 `ReadImageAsDataURL` 读成 Data URL；单张 >4MB 报错提示压缩（见 §3.4 尺寸预算）。
  3. 条目必须有 `editPath`，否则明确报错：「该条目未配置编辑端点（editPath），不支持参考图」。
  4. 请求走 `entry.editPath`；不带 reference 的调用行为完全不变（走 `entry.path`）。

### 3.2 模板层（ai-gen-model.js）

- `GEN_PLACEHOLDERS` 增加 `images`；`GEN_IMAGE_WRAP` 语义由条目字段 `editImageWrap` 控制（默认 `image_url`）。
- `{{images}}` 渲染为 JSON 数组字面量：包装字段非空时为 `[{"image_url":"<url|data-url>"},…]`，为空时为 `["…",…]`。模板示例（SenseNova）：

```json
{"model":{{model}},"images":{{images}},"prompt":{{prompt}},"size":"auto","response_format":"url","watermark":false}
```

- 部分更新语义沿用 `mergeGenModelEntry`；`set_gen_model` 的 skill 文档（cadt-gen-models）补 `editPath / editImageWrap / reference` 说明与兼容性标注（JSON-body edits 才可用）。

### 3.3 安全与边界

- **参考图 URL = 把图片地址交给第三方**：审批卡 command 文本追加「参考图 N 张：<逐个路径/URL>」，用户批准时看得见外传内容；URL 域名不进 web 规则（它们是 generate_image 审批的一部分，不单过 kind:'web'）。
- **本地文件读取**与 read_file 同授权链；读出的 Data URL 只进请求体，不落日志、不进模型上下文。
- **尺寸预算**：Data URL 经 base64 膨胀 1.33×，且 body 要跨 Wails IPC（JSON 字符串）——v1 限制**单张 ≤4MB、至多 5 张**（base64 后约 27MB，IPC 单字符串可承受）；超限报错提示用户压缩。4K 响应仍走 resultType url（响应体小）为佳。
- `n` 语义：edits 接口普遍仅支持 1，模板示例硬编码 `"n":1`（与 SenseNova 文档一致）。

### 3.4 渲染与留痕

- `toolMessage.gen` 快照增加 `references: [相对路径或URL]`（不含 Data URL 本体，避免会话 JSONL 膨胀——本地图重新渲染时按路径现读缩略图）。
- 工具卡：参考图行（小缩略图条，复用现有 `ai-gen-thumbs` 通道按路径现读）。
- `activity.log('ai', toolName, {…, refCount})`：只记数量与路径摘要。

## 4. 工作量与体量估算

| 位置 | 内容 | 估算 |
| --- | --- | --- |
| ai-gen-model.js | `images` 占位符渲染（含 editImageWrap 包装）、editPath 归一化、参考图解析纯函数（路径/URL 分类、大小校验） | ~90 行 |
| ai-panel.js | executeTool 里 reference 解析 + 授权链接线、快照 references、审批卡文案 | ~80 行 |
| ai-tool-defs.js / 卡片 / 技能（cadt-gen-models） | 参数声明、参考图缩略条、skill 文档补段 | ~70 行 |
| ai_gen.go | 无需改动（body 本就由前端拼好；请求体无上限校验） | 0 |
| 测试 | 占位符/解析/大小校验表驱动 | ~90 行 |

合计约 330 行，零新依赖。

## 5. 测试与验收

- 纯函数：`{{images}}` 渲染（包装字段/裸字符串/混合 URL+本地）、路径分类（http/相对/绝对）、大小上限、editPath 缺失报错文案。
- 手动验收：SenseNova U1.5 真实图生图（本地工作区图片为参考图 + URL 参考图各一次）；read 档下工作区外参考图弹读审批卡；>4MB 参考图被拒；不带 reference 的调用行为与老版本完全一致（回归）。

## 6. 未决项

1. **multipart 接口**（OpenAI 官方 edits）：需要 Go 侧新的 multipart 组装绑定，或引导用户走支持 JSON 的中转——先观察需求再立项。
2. 参考图缓存：同一图片多次编辑时重复读盘/转 base64（低频场景可接受，暂不做缓存）。
3. `review` 回传与参考图叠加时的图片数量预算分配（AI_IMAGE_MESSAGE_BUDGET 6MB 内取舍）。
4. 异步型编辑端点（任务型图生图）是否出现——出现后与视频 job 引擎合并评估。
