# AI 图片上限：两层限制 + 单一真源投影 + 三层校验（按 dsh 架构）

Status: implemented
Date: 2026-11-19

## 问题

消息框一次能附加的图片上限是 6 张、单张编码后 3 MiB、每消息 base64 合计 6 MiB（`frontend/src/ai/ai-constants.js` 旧值）。用户要求放宽到 10 张并放宽总预算，并明确要求「对齐 deepseek-harness（dsh）的架构」。

## 四家参照 harness 的调研结论

| harness | 源准入（宽松） | 归一化后发模型 | 请求层总量 | 张数 |
|---|---|---|---|---|
| dsh | 50 MiB/张、200 MiB/消息 | 2048²px / 4 MiB | — | 20 |
| codex | 79 MiB~1 GiB/张 | 2048px | 32 MiB base64 | 无硬限 |
| opencode | 20 MiB/张 | 2000px / 5 MiB base64 | 无（选择器 20 MiB） | 无 |
| ZCode | 20 MiB/张 | 2000px / 5 MiB base64 | 40 MiB | 8 附件 |

共性：四家全是「宽松源准入 + 归一化兜底 + 请求层硬预算」；限制几乎全是硬编码常量（opencode 的归一化参数可配置是唯一例外）；dsh / ZCode 有「后端定义 + 投影到前端」。

关键事实：**dsh 的 200 MiB 是源文件准入，不是发模型的预算**。源文件经归一化（sharp）压到 2048²/4 MiB 后才进模型请求。

## 核心取舍：不引入 sharp

dsh 的归一化用 sharp。npm registry 实测（0.35.5 / win32-x64）：

| 组件 | 解压后 |
|---|---|
| `sharp` 本体 | 962 KB |
| `@img/sharp-win32-x64` | 19.8 MB |
| `@img/sharp-libvips-win32-x64` | 19.8 MB |
| **合计** | **≈ 40.6 MB** |

CaDt 是 Wails 单 exe（全包约 31.5 MB），引入 libvips 会让 exe 翻倍并破坏零依赖。同一能力 CaDt 已有零成本实现：前端 canvas（`frontend/src/ai/ai-image-encode.js` 的 `fitImageSize` 等比缩放 + `encodeCanvasPayload` PNG→JPEG 0.86→0.45 降质），跑在 WebView2 里、不占 exe 一个字节，且已同时服务输入框附图与 `read_image` 工具。

因此**照搬 dsh 的架构思想**（单一真源 + 投影 + 三层校验 + 宽松准入 + 归一化兜底），**归一化用 canvas 实现**。

## 最终数值

| 层 | 阈值 |
|---|---|
| 源准入 | 10 张、单源 50 MiB、单消息源合计 200 MiB、单图 6400 万像素、单边 65535px、png/jpeg/webp/gif |
| 归一化（canvas） | 长边 2048px、编码后 4 MiB |
| 请求预算 | 单消息 base64 合计 32 MiB、单张 4 MiB |

视频不变（1 个 / 16 MiB / 24 MiB base64）。限制**不暴露设置页**——与四家一致，全是代码常量 + 投影。

## 三层校验落点

1. **前端源准入 + 预检**：`ai-composer.js` 的粘贴入口先 `checkSourceBatch` 整批校验（对齐 dsh「违规整批拒收 + 点名上限」），`addAttachment` 走张数 + `checkRequestBudget`。源层白名单比归一化白名单宽（额外放行 bmp / svg / `image/jpg`）：画布能把它们转成 png/jpeg，不该在入口就拒。注：AI 输入区当前没有独立的拖拽 drop 通道（窗口级拖文件走「作为标签页打开」）。
2. **前端发送前兜底**：`ai-panel.js` 的 `startSessionTurn` 在组装请求前查张数与 `checkRequestBudget`（覆盖编辑重发 / 支线重发 / 队列冲刷这些绕过 composer 的路径），超限返回 `images_too_large` 并提示，不发起往返。
3. **Go 强制校验**：`internal/aitransport/validate.go` 用 `aiimagepolicy.Get()` 校验张数、单张 base64、单条消息合计（长度/格式/合计先判，base64 解码最后做，避免历史图片每轮大块分配），并核对 MIME 白名单与 base64 合法性。

工具侧注入（`read_image` / `browser_screenshot` / `generate_image` 回传）不经过 composer 两层，只受 Go 第 3 层强制 + 同一份归一化阈值约束。

## 单一真源与投影

- `internal/aiimagepolicy/policy.go`：`ImageLimits` 结构 + 常量 + `Get()` + `ValidateBatch()`。唯一真源。
- `ai_image_policy_app.go`：`AIImageLimits()` Wails 绑定，前端启动时拉一次（与 dsh 的 `imageLimits` 投影同构）。
- `frontend/src/ai/ai-image-policy.js`：`DEFAULT_IMAGE_LIMITS`（镜像快照，投影不可用时兜底）、`createImagePolicyStore`、`normalizeImageLimits`、`checkSourceBatch`、`checkRequestBudget`。
- 一致性由两侧测试锁定：Go `policy_test.go` 与前端 `ai-image-policy.test.mjs` 都断言同一组数值。

## 改动清单

新增：
- `internal/aiimagepolicy/policy.go`、`policy_test.go`
- `ai_image_policy_app.go`
- `frontend/src/ai/ai-image-policy.js`、`frontend/test/ai/ai-image-policy.test.mjs`
- 本文档

修改：
- `internal/aitransport/types.go`（删掉本地图片常量，改引单一真源）
- `internal/aitransport/validate.go`（三层校验 + `containsString`）
- `internal/aitransport/transport_test.go`（图片边界用例）
- `frontend/src/dev/mock-backend.js`（`AIImageLimits` mock）
- `frontend/src/ai/ai-constants.js`（阈值更新 + 镜像说明）
- `frontend/src/ai/ai-composer.js`（两层准入接入）
- `frontend/src/ai/ai-panel.js`（投影 store 注入、启动加载、发送前兜底、文案）
- `frontend/package.json`（测试清单登记）
- `CHANGELOG.md`

## 验证

- `go test -timeout 300s ./internal/aiimagepolicy/... ./internal/aitransport/...` 全绿。
- `npm test` 全绿（含新增 `ai-image-policy.test.mjs` 与守卫）。
- `wails build -devtools` 通过，exe 体积无明显增长（零新增依赖）。

## 已知边界

- 归一化用 canvas，格式面与 dsh 一致（png/jpeg/webp/gif）；bmp/svg 源层放行、由画布统一转成 png/jpeg。
- 大图（接近 50 MiB）解码在主线程，可能短暂卡顿；如需优化可移到 Worker（现有 structure-worker 有先例），本次未做。
- 32 MiB 请求预算仍在 Go `aiMaxRequestBytes = 128 MiB` 兜底之内。
- 张数 10 × 单张 4 MiB = 40 MiB > 32 MiB 请求预算：「10 张」对高清截图实际约 8 张，超出时按合计上限提示。

## 视频与通用文件：为什么没有纳入统一投影（2026-11-19 调研结论）

查了四家参照实现，结论是**非图片附件都没有统一投影的先例**，据此保持现状：

| | 视频 | 音频 | 通用二进制 | 非图片限制投影 |
|---|---|---|---|---|
| dsh | ✗ 明确列为 future work | ✗ | ✓ 零限制，逐字节存，给模型路径 + 指令 | 无 |
| codex | ✗ 全仓无 video 分支 | ✓ 50 MiB / 5 格式 | 仅 MCP 通路 512 MiB，用户侧无入口 | 无（四套独立常量） |
| opencode | ✗ 识别 mime 但静默丢弃 | ✗ | 20 MiB；PDF 原样传，docx/zip 丢弃 | 无（20 MiB 在 3 处复制） |
| ZCode | ✓ 30 MiB 全局 / 20 MiB inline | ✗ 降级成 file | 20 MiB；二进制降级为路径引用 | 部分（只投影协议字节上限） |

CaDt 现状：视频 1 个 / 16 MB / mp4（`ai-constants.js:75-78` + `validate.go:189-212`，只支持 OpenAI 兼容协议）；文本附件 64 KB 单件 / 256 KB 合计（`ai-composer.js`）。

不纳入投影的理由：视频只有 2 个数值、1 个消费点，且已与 `fileio.ReadVideoAsDataURL`、`aiMaxVideoBase64` 三处注释对齐；投影它只是消除 3 行常量，收益与"图片 8 个阈值 × 3 个消费点"不在一个量级。连做得最全的 ZCode 也只投影了协议字节上限、没投影视频产品上限。

## 通用二进制文件：路径引用降级（已实施）

原本 `readTextFile` 对二进制与 >10 MB 直接抛错，等于 docx/zip/pdf 完全传不进对话。现对齐 ZCode：

- `ai-file-tools.js` 的 `attachmentPathHint(path, reason)` 纯函数按扩展名生成「未读入正文 + 路径 + 读法」文本（pdf→ocr、office→ocr/docx 技能、压缩包→先解压、图片→read_image、mp4→read_video、其余→read_file）。
- `ai-composer.js` 的 `attachPath` 捕获 `code: 'binary' | 'large'` 后降级为路径引用附件；`readTextFile` 给这两类错误加了 `code`（其他调用方只读 message，不受影响）。
- `attachFilesDialog` 改为按类型分派：视频 → `attachVideoPath`、图片 → `attachImagePath`（新增，复用同一套源准入 + 降采样）、其余 → `attachPath`。顺带修掉"选 png 被当文本读"的既有缺口。

## 审查修正（2026-11-19，双路只读审查后）

- 源层白名单以前误用「归一化后」白名单，会让 bmp/svg/`image/jpg` 在入口被拒、与 canvas 转码能力矛盾；改为源层白名单额外放行这三种，并给「格式不支持」单独的 `UNSUPPORTED_SOURCE_TYPE` 码。
- 源层失败原本 `return` 会连同批视频一起丢弃；改为只跳过图片循环。
- `startSessionTurn` 补张数校验（编辑/重发/队列路径此前只查预算不查张数）；`flashTurnStartFailure` 补 `images_too_large` 分支（此前支线等路径会把 reason 码直接露给用户）。
- 解压炸弹防护：投影的 `maxImagePixels` / `maxImageDimension` 此前无人消费，现于 `decodeSource` 解码后按阈值拒收，`maxNormalizedDimension` 也改由投影驱动。
- Go 侧把「合计超限」判定提到 base64 解码之前，避免历史图片每轮大块临时分配；负数字节按 0 计，不再冲小合计。
- 清理三处死常量（`AI_IMAGE_MAX_SOURCE_BYTES` / `AI_IMAGE_MAX_MESSAGE_SOURCE_BYTES` / `AI_IMAGE_MESSAGE_BUDGET`）与两处失效 import；新增「镜像常量 ↔ 投影默认值」漂移守卫测试。
