# generate_image 参考图编辑（图生图 / edits 端点）（实施记录）

> 状态：**已完成**（2026-11-16 实施；`npm test` 792 项全绿、`vite build` 通过。真实服务商图生图与阈值体验待手动验收，见 §5）
> 决策依据：生成条目配置已上线（`docs/finished-plans/ai-gen-models.md`），`generate_image` 只发纯 prompt——而主流生图服务商（SenseNova `/v1/images/edits`、豆包、通义万相等）都提供「参考图 + 编辑指令」的图生图接口，且 SenseNova 类接口是 **JSON body**、支持 base64 Data URL 输入，现有哑通道即可承载。
> 范围：`generate_image` 工具新增参考图参数；条目新增编辑端点；同步型 JSON-body 的 edits 接口

## 0. 与方案的三处偏离（实施时发现）

1. **审批卡文案改内联**：原计划在 command 里用换行追加参考图清单，但审批卡的 `.ai-cmd-text` 不保留换行（`white-space` 默认），换行会被压成空格、读起来更乱。改成括号内联：`generate_image · 条目：<prompt>（参考图 N 张：a.png、https://…）`。
2. **参考图清单存绝对路径**：本地图在快照里存 `resolved.path`（绝对）而不是模型传进来的相对路径——工具卡重绘与重启后回放都要按路径现读缩略图，相对路径在别的 cwd 下会读错。
3. **补了两条硬校验（方案里没有）**：`data:` / `file:` 等带协议但不吃文件的输入直接拒绝（data URL 会同时绕开文件授权与 4MB 预算，`file:` 在服务商侧毫无意义）；条目模板里没有 `{{images}}` 时直接报错，否则参考图会被静默丢掉——这类「模型以为传了、服务商收到空数组」的失败最难排查。

## 1. 背景与现状（代码事实）

- **工具参数**：`generate_image` 原为 `prompt/model/size/n/outputPath/review`（ai-tool-defs.js），全部只服务于纯文生图。
- **模板层**：占位符词表原为 `GEN_PLACEHOLDERS = [prompt, model, size, n, seed, apiKey, jobId]`（ai-gen-model.js），条目无编辑端点字段；带参考图时没有任何通路把图片塞进请求体。
- **本地图片读取（现成通道）**：`backend.ReadImageAsDataURL(path)`（`internal/fileio`，上限 32MB）返回标准 `data:image/png;base64,…` 形态——正好是 SenseNova 类接口要求的 Data URL 输入格式；路径授权链 `resolveReadPathWithApproval`（read/edit 档弹卡、auto/full 直读、用户点名直读、应用数据目录硬拒、子代理不弹卡）与 read_file 同源。
- **Go 哑通道**：`AIGenHTTPRequest` 的 `spec.body` 是前端渲染好的字符串，Go 对请求体无大小校验（只限响应体 64MB）；`AIGenSaveProducts` 落盘不变。**本次 Go 侧零改动**。
- **同类先例**：SenseNova `/v1/images/edits`（JSON body，`images: [{image_url}]`，至多 5 张，`image_url` 接受公网 URL 或完整 Data URL，`size: "auto"` 自动适配主图）；豆包/万相等 JSON-body edits 同构。**OpenAI 官方 `/v1/images/edits` 是 multipart/form-data**，JSON 模板做不了——明确排除（见非目标）。

## 2. 目标与非目标

### 目标（全部落地）

1. `generate_image` 新增 `reference` 参数（string[]，至多 5 张）：元素为工作区相对路径、已授权的工作区外绝对路径，或 http(s) 图片 URL。
2. 条目新增 `editPath`（同步型编辑端点）与 `editImageWrap`（数组元素包装字段名，默认 `image_url`，空 = 裸字符串）；带参考图的调用走 `editPath`，`bodyTemplate` 里用新占位符 `{{images}}`。
3. 参考图为本地文件时按 read 授权链解析（与 read_file 同源），读成 Data URL；URL 形态原样透传（由服务商拉取）。
4. 审批卡与工具卡展示参考图清单；留痕记录参考图数量（不记内容）。

### 非目标

- **multipart/form-data 的 edits 接口不支持**（OpenAI 官方 edits 是 multipart）——JSON 模板体系做不了 multipart，技能文档里明确标注兼容性，用户按服务商文档判断。
- 异步型（submit→poll）的编辑端点不做（当前已知 edits 接口均为同步）。
- `generate_video` 的参考图不做（视频服务参考图形态各家差异大，另行评估；工具层直接拒绝而不是忽略）。
- 参考图不做裁剪/预处理（原样投喂，尺寸适配交给 provider 的 auto；超 4MB 只提示压缩，不自动改图）。

## 3. 设计（按实施后的实际形态）

### 3.1 工具层（ai-panel.js）

- `generate_image` 新增参数 `reference`（string[]，≤5）。空数组 / 缺省 / 空白元素 = 现状纯文生图。
- 带参考图时（`runGenerateTool`）：
  1. 空白元素先剔除（否则 `reference: ""` 会误触发「未配编辑端点」）。
  2. 条目必须是同步型且配了 `editPath`，模板里必须有 `{{images}}`，否则逐条明确报错。
  3. 逐个解析：`http(s)://` 原样保留；其余按工作区路径解析并走 `resolveReadPathWithApproval`（read_file 同链），`ReadImageAsDataURL` 读成 Data URL；单张 >4MB 报错提示压缩。
  4. 解析在写审批**之前**完成——审批卡要把「哪几张图会外传」摆给用户看。
- 解析失败一律抛错（不是返回文本），工具卡直接标红：静默丢图比失败更难排查。

### 3.2 模板层（ai-gen-model.js）

- `GEN_PLACEHOLDERS` 增加 `images`；`renderGenJson` 对 `images` 特别处理：直接取 `vars.images`（已渲染好的字面量），不再走 `jsonLiteralOf` 包引号。
- `renderGenImages(values, wrap)`：包装字段非空时为 `[{"image_url":"…"},…]`，为空时为 `["…",…]`；字段名严格校验（拼错会让服务端静默忽略参考图）。示例（SenseNova）：

```json
{"model":{{model}},"images":{{images}},"prompt":{{prompt}},"size":"auto","response_format":"url","watermark":false}
```

- `classifyGenRef` / `dataURLBytes` / `genRequestPath` 三个纯函数分别负责：元素分类（url / path / invalid / empty）、Data URL 字节估算、端点选择（带参考图且有 editPath → editPath，否则 path）。端点选择单一来源，`ai-gen-jobs.runSync` 只调它。
- 部分更新语义沿用 `mergeGenModelEntry`；`set_gen_model` 与内置技能 `cadt-gen-models` 补 `editPath / editImageWrap / reference` 说明与兼容性标注（只有 JSON-body edits 可用）；`get_gen_models` 视图与保存回执也带上 `editPath / editImageWrap`，AI 才看得见条目能不能吃参考图。

### 3.3 设置页（ai-gen-settings.js）

编辑器「请求」组新增两行：**编辑端点 editPath**（占位 `/v1/images/edits（留空 = 不支持参考图）`）与**参考图包装字段**（占位 `image_url（留空 = 裸字符串数组）`）；请求体模板的说明补 `{{images}}` 示例；条目列表摘要行在配了编辑端点时追加「图生图 <端点>」。

### 3.4 安全与边界

- **参考图 URL = 把图片地址交给第三方**：审批卡 command 内联参考图清单，用户批准时看得见外传内容；URL 域名不进 web 规则（它们是 generate_image 审批的一部分，不单过 `kind:'web'`）。
- **本地文件读取**与 read_file 同授权链；读出的 Data URL 只进请求体，不落日志、不进模型上下文、不写会话 JSONL。
- **尺寸预算**：Data URL 经 base64 膨胀 1.33×，body 要跨 Wails IPC——单张 ≤4MB、至多 5 张（base64 后约 27MB）。`dataURLBytes` 只按 base64 段长度估算（floor(len×3/4)），不解析图片，够做上限判断。
- `n` 语义：edits 接口普遍仅支持 1，模板里硬编码 `"n":1`（与 SenseNova 文档一致）。

### 3.5 渲染与留痕

- `toolMessage.gen` 快照增加 `references: [绝对路径或URL]`（不含 Data URL 本体，避免会话 JSONL 膨胀）；`normalizeGenSnapshot` 去空、截断到 5 条。
- 工具卡：状态行 → 停止钮 → **参考图行**（本地图 56px 小缩略图，按路径现读、可点开；远程 URL 只显示地址不代拉取——卡片重绘不该产生网络请求）→ 产物缩略图条。
- `activity.log('ai', toolName, {…, refCount})`：只记数量；`refCount` 为 0 时不写字段。

## 4. 工作量（实际）

| 位置 | 内容 | 实际 |
| --- | --- | --- |
| ai-gen-model.js | `images` 占位符（含 `renderGenJson` 特判）、`editPath`/`editImageWrap` 归一、`classifyGenRef` / `renderGenImages` / `dataURLBytes` / `genRequestPath`、快照 references | +71 |
| ai-panel.js | `resolveGenReferences` + 编辑端点校验 + 审批文案 + 快照/留痕 + 桥接视图字段 | +93 |
| ai-gen-jobs.js | `runSync` 端点选择 | +4 |
| ai-gen-settings.js | 编辑端点 / 包装字段两行 + 模板说明 + 列表摘要 | +19 |
| ai-tool-defs.js / ai-tool-cards.js / style.css / ai-constants.js | 参数声明、描述、参考图缩略行与样式、技能文档 | +8 / +45 / +9 / +6 |
| Go 侧 | 无需改动（body 本就由前端拼好；请求体无上限校验） | 0 |
| 测试 | `ai-gen-model.test.mjs` 新增 8 例（渲染 / 分类 / 字节估算 / 端点选择 / 快照） | +101 |

合计约 355 行，零新依赖。

## 5. 测试与验收

- **已自动覆盖**（`frontend/test/ai/ai-gen-model.test.mjs`，20 例全绿）：`{{images}}` 渲染（缺省包装 / 自定义字段 / 裸数组 / 非法字段名抛错）、`classifyGenRef`（http、盘符路径、相对路径、`data:`/`file:`/`ftp:` 拒绝、空白丢弃）、`dataURLBytes`（含换行、非 data URL 给 0）、`genRequestPath`（带/不带参考图、未配 editPath 回落）、`buildGenVars` + `renderGenJson` 端到端（解析回 JSON 比对 images 数组）、`normalizeGenSnapshot` 的 references（去空、截断）、`editImageWrap` 空串不被归一化改回默认。
- **待手动验收**（需要真实服务商 Key，本次未做）：
  1. SenseNova U1.5 真实图生图：工作区本地图片作参考图 + URL 参考图各一次，产物正常落盘。
  2. read 档下工作区外参考图弹「想读取工作区外 …」审查卡；拒绝后整单失败且不发起请求。
  3. >4MB 参考图被拒并提示压缩；6 张被拒并提示上限。
  4. 不带 reference 的调用与老版本逐字一致（回归）：同一个条目、同一段 prompt，请求体字符串不变。
  5. 审批卡在 read/edit 档显示参考图清单；auto/full 档不弹卡但仍记录 `refCount`。
  6. 重启应用后回放旧会话，参考图行仍能显示缩略图（按绝对路径现读）。

## 6. 未决项

1. **multipart 接口**（OpenAI 官方 edits）：需要 Go 侧新的 multipart 组装绑定，或引导用户走支持 JSON 的中转——先观察需求再立项。
2. 参考图缓存：同一图片多次编辑时重复读盘/转 base64（低频场景可接受，暂不做缓存）。
3. `review` 回传与参考图叠加时的图片数量预算分配（AI_IMAGE_MESSAGE_BUDGET 6MB 内取舍）。
4. 异步型编辑端点（任务型图生图）是否出现——出现后与视频 job 引擎合并评估。
5. 参考图体积上限（4MB）与张数（5 张）都是保守值，若真实服务商允许更大，可按条目配置化（`editRefMaxBytes` / `editRefLimit`）；别急着全局放宽——放宽后 IPC 单字符串体积会先撞上。
