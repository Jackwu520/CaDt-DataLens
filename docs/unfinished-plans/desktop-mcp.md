# Windows 桌面操作 MCP（评估与规划）

> 状态：**未开工**（2026-11-16 调研成文，本轮只评估与规划，未修改实现代码）
> 复核：**2026-11-17** 二次核对代码与上游，修正 §5.2 / §5.3 / §7 的事实，并把分阶段调整为 §12.8；仍未改实现代码。
> 复核：**2026-11-21** v3 迁移完成后三审（§13）：`toolsForScope` 第三参已就位（P1 变薄）、工具数 68→78（懒加载前移）、应用自身 MCP server 变体落地（方向重定位）、多窗口 grant 争用为新风险；仍未改实现代码。
> 触发：用户要求参考 `dsh-windows-mcp`，给 CaDt-DataLens 加一套类似的 Windows 操作 MCP。
> 范围：把桌面自动化能力以**外部 stdio MCP server** 的形态挂进现有 MCP 客户端；在本项目内补齐「会话授权 + 依赖安装 + 懒加载 + 诊断」这层产品化外壳。
> 非目标：不自研 UIA / 截图 / 输入引擎；不做 MCP server 暴露；不做 Streamable HTTP；不打包 Python / uv；不改现有 MCP 协议层；不做 OS 沙箱。

---

## 1. 结论摘要

`dsh-windows-mcp` 本身不是桌面自动化引擎，而是一个 **carrier bundle**：它把 CursorTouch / `windows-mcp@0.8.8`（Python，stdio 子进程）挂到 DSH 自带的 MCP 客户端桥上，自己只贡献四样东西：

1. 默认关闭、按会话生效、不落盘的 **Computer Use 硬开关**；
2. 设置页里的 **依赖安装 / 版本切换 / 回滚**；
3. 默认开启的 **懒加载工具目录**（`windows_desktop` 一个入口换 18 个 schema）；
4. `windows_mcp_doctor` **诊断**。

本项目的 MCP 客户端（P0–P3 已完成，见 `docs/finished-plans/mcp-client.md`）已经具备：stdio JSON-RPC、多 server 编排、工具世代原子交换、工具白名单、命名纯函数、审批对接、env 清洗、进程树 + Job Object 清理、留痕只记结构不记值。因此**协议层零改动**，真正缺的是上面四样外壳，以及一块必须补上的安全边界：MCP 工具参数目前**不经过工作区路径闸**。

推荐路线：**B — 产品化内置示例**。先用零代码的 P0 验证 UIA / 高 DPI / 模型图像输入，再按 P1→P4 逐步补外壳。不要走 C（自研 Go 桌面 server）：收益（单 exe 零依赖）远低于 UIA 元素定位、高 DPI、非英文 Windows 兼容性的成本。

---

## 2. dsh-windows-mcp 事实核对

| 项 | 事实 |
|---|---|
| 定位 | 不重新实现 MCP SDK；`DSH agent → @deepseek-ai/dsh-mcp-client → uvx windows-mcp@0.8.8 serve → UIA / Win32` |
| 工具数 | 上游 21 个，默认排除 `App` / `PowerShell` / `FileSystem` 三个，剩 **18 个**；`ControlStatus` 上游强制保留、无法排除 |
| 工具清单 | `Screenshot`、`Snapshot`（无障碍树，纯文本）、`DisplayInventory`、`Click` / `Move` / `Scroll`、`Type` / `Shortcut`、`Wait` / `WaitFor`、`Scrape`、`MultiSelect` / `MultiEdit`、`Clipboard`、`Process`、`Notification`、`Registry`、`ControlStatus` |
| 授权开关 | Composer 里 Computer Use pill；**默认关闭**；开关属于当前会话，内存态、重启清空、不写 `state.json`；关闭后下一步起工具从模型可见列表消失，派发阶段仍拒绝；子代理继承父会话授权，fork 的会话默认 blind |
| 新会话默认值 | `Settings → Desktop → Tool exposure → Grant new sessions by default`，默认关闭；pill 仍可按会话覆盖 |
| 懒加载 | 默认开启；模型只看 `windows_desktop` 一个入口，`{"query":"screenshot"}` 或 `{"names":[...]}` 按需揭示；揭示按会话有效；关闭总开关时入口也隐藏 |
| 依赖 | Windows 10/11；`uv` 需在 PATH（也会搜 `%USERPROFILE%\.local\bin`）；截图要模型支持图像输入；验证环境 Win11 + DSH 0.2.0-rc.2，启动约 1.5 s |
| 启动纪律 | bridge row **出厂 disabled**，避免 `uvx` 首次解析依赖阻塞 DSH 启动；设置页安装后改成直接指向已安装 exe，此后启动不再联网 |
| 默认 env | `WINDOWS_MCP_SCREENSHOT_SCALE=0.75`、`WINDOWS_MCP_DISABLE_FLASH=1`、`WINDOWS_MCP_SCREENSHOT_BACKEND=auto`、`WINDOWS_MCP_MAX_TREE_ELEMENTS=500`、`WINDOWS_MCP_WATCHDOG=off`、`ANONYMIZED_TELEMETRY=false` |
| 诊断 | `windows_mcp_doctor` 打印 uv/python 路径、生效 bridge row、真实注册工具、当前会话开关、UIA / 显示器探测 |
| 已知坑 | 高 DPI 截图缩放导致坐标偏移；UIA 会话失败（上游 #607）会让 Click/Type「成功但无反应」；非英文 Windows 上 `App` 不稳；用户 10 秒内物理输入触发上游 `USER_CONTROL` 拒绝 |

版本提示：网上仍有引用 `dsh-windows-mcp.state.json` 的旧文（0.2.3 时代）。当前 README（npm 0.2.11）明确旧状态文件**不再读取**，授权只存内存。本方案按当前行为设计。

---

## 3. 本项目现状（代码事实）

### 3.1 已有能力

- MCP 客户端：`internal/mcp/`（`mcp_config.go` / `mcp_rpc.go` / `mcp_client.go` / `mcp_manager.go` / `mcp_generation.go` / `mcp_name.go` / `mcp_env.go` / `mcp_proc_windows.go`），根壳 `mcp_app.go`。只支持 **stdio**；`MCPServerConfig` 没有 `transport` / `url` 字段。
- 配置：`%APPDATA%\CandySweet\CaDt-DataLens\mcp.json`，0600 原子写，写入期校验，重复 JSON 键拒绝。`EnabledTools` 空数组 = 一个都不授权。
- 发现与调用：`MCPSnapshot()` 触发惰性启动 → `mcp__<server>__<tool>` 公开名 → `ai-mcp.js` 整代快照替换 → `toolsForScope` 注入（写权限档、非计划模式）→ `executeTool` 的 `mcp__` 前缀分支 → `invokeMcpToolWithApproval` → `MCPCallTool` 查表发原始名。
- 安全已有：首次添加确认、工具白名单默认全不勾、annotations 只作 hint 且审批绝不读它、描述加 `[MCP:server]` 前缀并截断 500 字符、server instructions 不注入、env 清洗、失败路径脱敏、进程树 + Job Object、留痕只记 keys/bytes/hash/openWorld。
- 会话级放行先例：`ai-permission-settings.js:449-484` 的 `commandApprovalRules`（按 `session.id` 存内存，重启失效）。
- 内置示例：`mcp_samples.go` 目前 3 条（TTS / OCR / ASR）；`MCPInstallSample(id)` 只做「释放脚本 + 写 mcp.json」，**不负责安装 Python / uv 等外部依赖**。
- 工具上限：`aiMaxToolDefs = 128`（`internal/aitransport/types.go`），当前 MCP 注入约 18 个工具不会触顶，但有上下文成本。

### 3.2 缺口

| 能力 | dsh | 本项目 | 结论 |
|---|---|---|---|
| stdio 桥接 | 宿主自带 | `internal/mcp` 已完整 | 复用 |
| 工具白名单 / 审批 / 留痕 | 有 | 有，且更保守 | 复用 |
| 依赖安装 / 版本回滚 | 设置页一键 | 无 | **新增** |
| Computer Use 会话硬开关 | 有 | 无；当前每次 MCP 调用都按 write 档审批 | **新增** |
| 懒加载工具目录 | 有 | 无；18 个 schema 每轮都进上下文 | **新增（可后置）** |
| 桌面 doctor | 有 | 只有通用 `MCPProbeServer` | **新增** |
| MCP 参数级路径闸 | 依赖宿主既有工具 | `invokeMcpToolWithApproval` 只判权限档，不解析 args 里的 `path` | **风险，靠工具白名单规避** |

### 3.3 可复用但不可直接调用的 Windows 能力

Go / Wails 层已有 `CaptureAppScreenshot`、`GetClipboardText`、`SetContextMenu`、`TermCreate`、`RunExec`、`BrowserSnapshot`、`Registry` 相关绑定等，但它们都挂在 `package main` 的 `*App` 上且依赖窗口 ctx；独立 MCP 子进程**不能直接调用**。这也是不推荐路线 C 的原因之一：要复用就得先做 App 去 App 化下沉。

---

## 4. 路线评估

| 路线 | 做法 | 改动量 | 优点 | 主要问题 |
|---|---|---|---|---|
| A 零代码接入 | 用户自装 uv + windows-mcp，手写 `mcp.json` | 0 | 立刻验证能力；不动任何代码 | 无开关、无安装向导；每次点击都弹审批，桌面循环不可用 |
| **B 产品化内置（推荐）** | A + 内置示例 + 安装器 + 会话闸门 + 懒加载 + doctor | 中等，集中于前端新模块与一个 Go 安装器 | 体验对齐 dsh；协议零改动；全部安全机制继承 | 需要设计会话授权与"按需装依赖"的用户预期 |
| C 自研 Go MCP server | 新增 `--mcp-server` CLI，用 Go 重写 UIA / 截图 / 输入 | 大 | 真正单 exe 零依赖 | UIA 元素定位、高 DPI、非英文 Windows 成本极高；与已有截图 / 终端 / 浏览器工具重叠 |

结论：**B**。P0 先用 A 的方式零代码证伪环境风险，再实施 B。

---

## 5. 推荐方案设计

### 5.1 总体链路

```
AI 工具调用 (mcp__windows__*)
  → 会话授权闸门（默认关 / 内存态 / 子代理继承）
  → 现有 MCP 客户端（白名单 → 写档审批 → 项目 deny → 留痕）
  → windows-mcp@0.8.8（stdio 子进程，App/PowerShell/FileSystem 已排除）
  → Windows 桌面（UIA / Win32 输入 / GDI 截图）
```

### 5.2 会话授权闸门（核心）

- 新模块 `frontend/src/ai/ai-desktop-control.js`，状态 `Map<session.id, {granted, revealed:Set, grantedAt}>`，**只存内存**。不写 `localStorage`、不写会话 JSONL、不写应用数据目录。
- 判定桌面工具只认 server 名：公开名形如 `mcp__windows__<tool>`，且快照里 `server === 'windows'`。**绝不读 annotations**，也不靠描述文本猜。
- 默认关闭。开启后：
  - `toolsForScope` 通过 ctx getter 注入桌面工具定义（仅在写权限档、非计划模式）；
  - `invokeMcpToolWithApproval` 传 `sessionAllow: true`，但 `decidePermission` 的 `rules` 仍来自项目规则，**deny 优先不变**；
  - 子代理**不继承**（2026-11-17 修正）：`subToolsForScope` 是一张独立白名单，一条 MCP 工具都没有，原「继承父会话 grant」是空转代码；真要继承得先让子代理拿到桌面工具，与「子代理只做只读探索」的定位冲突。见 §12.3。
- 关闭后**立即生效**：下一步起工具从工具表消失，`executeMcpTool` 派发入口也要硬拒绝并提示「先开启 Computer Use」，不等重启、不留半轮窗口。
- Composer 在 `#ai-permission` 旁加 `#ai-computer-use` pill：显示当前真实注册数，`aria-pressed` 表状态，`data-tip` 说明「仅本会话授权，重启后失效；关闭立即收回」。tooltip 遵守 `core/tooltip.js` 的时机规则，不自造。
- 设置项「新会话默认授权」默认关闭，且 pill 始终可覆盖；**不提供写盘持久化开关**。

### 5.3 依赖安装器

- 新 Go 文件建议 `internal/mcpdesktop/`（纯引擎：探测 uv、拼安装参数、生成 bridge 配置、回滚）+ 根壳 `mcp_desktop_app.go`（Wails 绑定），与 `mcp_app.go` 的薄包装约定一致。
- 安装步骤：探测 `uv`（PATH 与 `%USERPROFILE%\.local\bin`）→ `uv tool install windows-mcp@0.8.9 --tool-dir <appdata>/builtin-mcp-samples/windows-mcp/toolchain`（0.8.6 起 **requires-python ≥3.14**，uv 会自行下载托管解释器，首次安装体积与耗时必须在 UI 上说明）→ 生成 server 行：`args: ["serve", "--tools", "<白名单>"]`（**用白名单而非 `--exclude-tools`**：黑名单 fail-open，上游新增工具会自动暴露；白名单拼错会启动即失败并列出可用工具，属确定性失败）→ 带上 §2 的默认 env（人机争用另按需配 `--control-policy` / `WINDOWS_MCP_CONTROL_IDLE_TIMEOUT`）→ 经 `MCPWriteConfig` 校验后原子落盘（写前备份 `mcp.json`）。
- **bridge 行默认 `enabled: false` / `EnabledTools: []`**：安装完仍要用户进设置页勾选工具；安装过程不阻塞启动，失败不留半配置。
- 设置页在「设置 → AI → 外部工具」增加一张 Desktop MCP 卡片（安装 / 重装 / 回滚 / 诊断入口 + 日志流），复用 `settings-pane-external-tools.js` 的既有布局。
- 不打包 Python / uv，不把依赖塞进 `frontend/dist`；这与「单 exe 零依赖」哲学一致：不配置就是零额外进程。

### 5.4 懒加载（P3，可后置）

- 新增内置工具 `windows_desktop`（非 `mcp__` 前缀，走普通 app_control 分派），参数 `{query?: string, names?: string[]}`。
- 调用后返回匹配的工具定义文本，并把公开名写入当前会话 `revealed`；下一步起这些定义进入工具表。未揭示的桌面工具被直接调用时确定性拒绝并提示先 reveal。
- 揭示按会话有效；总开关关闭时入口也隐藏，不能绕过人工授权。
- 只有在实测确认 18 份 schema 的 token 成本明显时才做；否则维持全量注入以简化实现。

### 5.5 doctor

- 新增 AI 工具 `desktop_mcp_doctor`（或设置页按钮调用同一 Wails 绑定），输出：uv / python 解析路径、生效的 server 配置（env 值脱敏）、实际注册的 `mcp__windows__*` 列表、当前会话授权状态、UIA 窗口数与显示器缩放。
- 只诊断、不修复；修复动作仍走设置页的显式按钮 + 确认。

---

## 6. 分阶段实施

> 2026-11-17 复核后调整：P0 拆成 P0a / 决策点，P2 降级，P3 视 token 实测前移——**排期以 §13.5 为准**（2026-11-21 三审替换 §12.8），下表保留作原始排期记录。

| 阶段 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **P0 零代码验证** | 本机装 uv + windows-mcp；手写 `mcp.json`；勾 6 个工具；跑 `Snapshot → Click → Screenshot` | AI 拿到无障碍树并完成一次真实点击；确认高 DPI 坐标换算 | 删 server 行 |
| **P1 会话闸门** | `ai-desktop-control.js` + test；`index.html` pill；`ai-panel.js` / `ai-tool-defs.js` 接线；派发硬拒绝 | 新会话无工具；开→出现、关→消失且被拒；项目 deny 仍生效 | 移除 getter 与派发分支 |
| **P2 安装器** | `internal/mcpdesktop` + 根壳 + 设置页卡片 + `mcp_samples.go` 登记 | 一键安装成功；重启后 1~2 s 就绪；卸载 / 回滚干净 | 恢复备份的 `mcp.json` |
| **P3 懒加载** | `windows_desktop` 入口 + `revealed` 集合 + 测试 | 每轮不再塞 18 份 schema；关闭开关时入口隐藏 | 关掉懒加载开关，回全量 |
| **P4 doctor** | 诊断绑定 + 设置页按钮 + 失败文案 | 工具缺失时能定位到 uv / 配置 / 授权 / UIA 哪一层 | 无副作用，直接移除 |

每阶段独立提交，同步 `CHANGELOG.md`「未发布」段；P4 完成后本方案移入 `docs/finished-plans/`。

---

## 7. 文件清单（实施时）

### 新建

- `frontend/src/ai/ai-desktop-control.js` + `frontend/src/ai/ai-desktop-control.test.mjs`
- `internal/mcpdesktop/`（安装器引擎 + 测试）
- `mcp_desktop_app.go`（Wails 薄包装）——照 `internal/mcp/client.go` 的现状：绑定方法放在 `internal/mcpdesktop` 的 Service 上，根壳只做 `init()` 注入与退出钩子
- `docs/mcp-samples/windows-mcp.md`（说明与手动安装步骤）

### 修改

- `frontend/index.html`：Composer pill、设置页卡片 DOM
- `frontend/src/ai/ai-panel.js`：创建模块、ctx 注入、派发硬拒绝、doctor 分派
- `frontend/src/ai/ai-tool-defs.js`：`toolsForScope` 增第三参 session（现签名只有 `scope, planMode`，见 §12.2）；`windows_desktop` 定义
- `frontend/src/ai/ai-subagents.js`：子代理继承父 grant
- `frontend/src/settings/settings-pane-external-tools.js`：安装 / 回滚 / 诊断按钮
- `internal/mcpsamples/samples.go`：登记示例（不是已只剩 embed 的 `mcp_samples.go`）
- `frontend/package.json`：**手动把新 `.test.mjs` 加进 test 列表**
- `CHANGELOG.md`、「外部工具」帮助文案 / README 相关段落

> 实施前必须重新 `git status`：2026-11-16 早些时候 `ai-panel.js` / `main.js` / `ai-permissions.js` 曾有在途改动；成文时工作树干净，但不能保证实施时仍如此。

---

## 8. 测试方案

- 前端单测：默认关闭、开启后注入、关闭后派发拒绝、项目 deny 优先、子代理继承、fork 不继承、reveal 按会话隔离、重启后状态清空。
- Go 单测：uv 探测路径优先级、安装参数与 `--exclude-tools` 文案、生成配置的字段完整性、env 脱敏、写前备份与失败回滚、不阻塞启动。
- 手工验收清单（Win11）：新装后无工具 → 安装依赖 → 勾选 6 工具 → 开 pill → Snapshot → Click → Screenshot → 关 pill → 立即拒绝 → 重启后重新 blind。
- 不写「截图内容正确」的自动断言；UIA / 高 DPI 属上游行为，只做 doctor 与人工记录。

---

## 9. 风险与红线

1. **不启用 `FileSystem` / `PowerShell`**：dsh 默认排除，理由正是宿主已有同类工具；本项目更应避免 MCP 参数绕过工作区路径闸。
2. `Registry` / `Process` 首版默认不勾；勾上后建议单独二次确认，不与普通点击共用会话授权。
3. 会话授权是「免逐次审批」的**显式降险决定**，不是免死金牌：项目规则 deny、计划模式、只读档仍然否决。
4. 不接 `server instructions` 进 prompt；工具描述继续走 500 字符截断 + `[MCP:windows]` 前缀 + workspace_rules 防注入。
5. 与 `docs/finished-plans/subagent-sandbox.md` 的关系：那个方案是**文件效应兜底**，已实施（阶段 A–D）；本方案不承诺沙箱，也不得被描述成沙箱。
6. 高 DPI 坐标、非英文 Windows、UIA 会话失败、模型不支持图像输入都是上游限制；只能靠 doctor 与文档说明。
7. 18 个工具 + 现有约 50 个内置工具仍在 128 上限内，但上下文成本要实测；懒加载不要因为「看起来高级」就抢在 P1 前做。

---

## 10. 待决策（实施前需拍板）

| # | 问题 | 建议 |
|---|---|---|
| 1 | 先零代码 P0 验证，还是直接排 P1–P2？ | **先 P0**，半天内证伪 UIA / 高 DPI / 图像输入风险 |
| 2 | 接受按需安装 Python / uv、不随 exe 打包吗？ | 接受则走 B；不接受只能走 C |
| 3 | 首版工具白名单范围？ | 保守 6 个：`Screenshot` / `Snapshot` / `Click` / `Move` / `Scroll` / `Type` / `Shortcut` / `Clipboard` 中按实际需要取 6–8 个；`Registry` / `Process` 后置 |
| 4 | 懒加载放首版还是 P3？ | **P3 后置**，先量 token 成本 |

---

## 11. 参考

- `docs/finished-plans/mcp-client.md`：本项目 MCP 客户端方案（P0–P3 已实施），§10 安全模型、§15 决策记录
- `docs/finished-plans/ai-external-tools.md`：外部能力来源矩阵，本地能力走 MCP 的权威依据
- `docs/finished-plans/read-outside-workspace.md`：工作区外读取授权链与路径闸对照基准
- `docs/finished-plans/subagent-sandbox.md`：OS 级沙箱参考（已实施，勿混用）
- `dsh-windows-mcp`：https://github.com/helloHub1212/dsh-windows-mcp （npm 0.2.11 README 为准）

---

## 12. 复核（2026-11-17，代码与上游二次核对）

> 只读代码与上游，未改实现。路线 B 仍然成立，但 §1 的「协议层零改动」不成立（§12.1），P1 的改动量被低估（§12.2），子代理继承那条是空转（§12.3），上游版本与工具过滤方式已变（§12.4）。分阶段以 §12.8 为准。

### 12.1 关键：Screenshot 拿不到图，「协议层零改动」不成立

`internal/mcp/mcp_client.go:280-288` 把 MCP 结果的 image / audio content 降级成占位文本：

```go
case "image", "audio":
    b.WriteString(fmt.Sprintf("[%s: %s，base64 %d 字符]", item.Type, item.MimeType, len(item.Data)))
```

`CallResult`（同文件 245-248）只有 `Text` / `IsError`，没有任何图像通道。而 windows-mcp 的 `Screenshot` 返回的正是图像 content block（上游 README 专门提示高分辨率截图会撞 Claude Desktop 的 1 MB tool-result 上限）。所以模型拿到的是 `[image: image/png，base64 420000 字符]` 这一行字，看不见桌面——**§2 把「模型支持图像输入」记成上游限制，其实第一道闸在本项目自己的客户端**。

两条出路，必须在 P0 决策前选：

- **A（首版推荐）不勾 `Screenshot`**，纯 `Snapshot`（无障碍树文本）驱动。上游明确「Use Any LLM (Vision Optional)」，这条路成立，且真的保持协议零改动。代价：画布类 UI、游戏、纯图像应用等于瞎。
- **B 补一条图像结果通道**（真·协议层改动）：Go `CallResult` 增加 `images [{mime,data}]` 并设总体积上限 → 前端复用「工具批次结束后挂图」机制（`ai-panel.js:10374` 的 `flushToolImages`；批次中途 push 会插在 assistant(tool_calls) 与 tool 结果之间，整轮被拒收）→ 降采样沿用 `read_image` 的长边 1600 口径。工作量约等于新增半个 `read_image`，不能默认它免费。

### 12.2 `toolsForScope` 没有 session，P1 不只是「接线」

- `createAIToolDefs` 只在面板初始化时建一次（`ai-panel.js:5911`），`mcpToolDefs: () => mcpMod.mcpToolDefs()`（5913）**拿不到 session**；
- `toolsForScope(scope, planMode)` 只有两个参数（`ai-tool-defs.js:913`），生产调用 4 处（`ai-panel.js:9862` / `10010` / `10308` / `4967`）+ 目录推导 1 处（`ai-tool-defs.js:1001`）+ 测试 5 处。

按会话授权必须动签名。最省做法：注入 `desktopGrantOn: (session) => bool`，`toolsForScope` 增第三参 session（缺省视为未授权），调用处顺手传。**不要另加一层过滤**——`toolCatalogText` 由 `toolsForScope` 反推（`ai-tool-defs.js:1001`），两套判定会让系统提示里的工具目录与实际工具表分叉。

### 12.3 子代理继承是空转

`subToolsForScope`（`ai-subagents.js:250-264`）是一张独立白名单，一条 MCP 工具都没有，子代理压根碰不到 `mcp__` 工具。原 §5.2 的继承逻辑不写这张表就是死代码；写了等于给子代理桌面控制权。建议首版明盘「子代理不继承」，写进 pill 的 tooltip。

### 12.4 上游已变

| 项 | 原文 | 现在 |
|---|---|---|
| 版本 | 0.8.8 | PyPI **0.8.9**（2026-11-12）；钉 0.8.8 仍可装 |
| Python | 未提 | 0.8.6 起 **requires-python ≥3.14**，uv 会自下托管解释器 |
| 工具过滤 | `--exclude-tools App,PowerShell,FileSystem` | 另有 **`--tools` 白名单**（fail-closed，名字大小写不敏感，拼错启动即失败并列出可用工具）+ `WINDOWS_MCP_TOOLS` env |
| 占用 | 「不配置就是零额外进程」 | 配置后 appdata 约 +100 MB 量级（3.14 解释器 + fastmcp/pydantic/pywin32/pillow/dxcam 等），待实测 |
| 人机争用 | 10 秒内物理输入触发 USER_CONTROL（当坑） | 上游有 `--control/--no-control`、`--control-policy relaxed|balanced|strict`、`WINDOWS_MCP_CONTROL_IDLE_TIMEOUT`（默认 10s）、`ControlStatus`（可 release）——是可配置项 |

`--tools` 应替换 `--exclude-tools`：黑名单 fail-open，上游加新工具就自动暴露，与「默认关闭」叙事不一致。

### 12.5 路径与工作树

- MCP 绑定已下沉 `internal/mcp/client.go`（HEAD `aa6c0d0`），`mcp_app.go` 只剩 `init()` 注入 `Logf/AppDataDir/Version` 与 `mcpCloseAll`。
- 内置示例登记处是 `internal/mcpsamples/samples.go`（`tts_sapi` / `ocr_windows` / `asr_whisper`），`mcp_samples.go` 只剩 `//go:embed`。
- 工作树仍脏（40+ 文件，`ai-panel.js` +177、`main.js` +93、`ai-tool-defs.js`）。`index.html` 那 16 行新增落在设置页（AI 工作区选项 + 模型编辑器频率上限），**不撞 Composer pill 区**；但 `ai-panel.js` 的在途改动要先看清再动手。
- 会话级放行机制已存在：`commandApprovalRules`（`ai-permission-settings.js:450`，`Map<session.id, rules>`，纯内存，上限 30 条）+ `matchCommandRule(rules, name, 'MCP 工具')`（`ai-panel.js:7640`）。但它只支持精确工具名 / family 签名，**没有通配**（`ai-command-rules.js:204-218`）。新的 `ai-desktop-control.js` 别与它并行成两套真相：grant 只在派发入口判一次，审批仍走 `decidePermission`，`sessionAllow` 照旧只喂 `matchCommandRule`。

### 12.6 工具数

`AI_TOOL_DEFS` 现有 **68** 条。+18 桌面工具 = 86，仍在 `aiMaxToolDefs = 128` 内，但工具段上下文 +26%。所以 P3 懒加载不是「看起来高级」：P1 落地后先量一次工具段 token，超阈值就把 P3 提到 P2 之前。

### 12.7 新增风险（§9 之外）

1. **结果侧提示注入**：桌面快照里必然出现网页 / 邮件 / 文档正文，而下一跳就是 Click / Type——注入即成操作。§9.4 只防了工具描述侧。桌面工具结果需「数据非指令」包裹（对齐 web_fetch），动作类工具的结果标注来源窗口。
2. **256 KB 截断**（`mcp_client.go:25`）：Snapshot 在 `MAX_TREE_ELEMENTS=500` 下通常够，一旦截断就是半截结构。该 server 需放宽或让 Snapshot 分页。
3. **授权粒度不对等**：一个 pill 放开 18 个工具，`Screenshot` 与 `Registry` 差三个数量级。pill 只覆盖「观察 + 输入」组，`Registry` / `Process` / `Notification` / `App` 归二级开关，永不进会话免审。
4. **与既有能力抢活**：`app_control`（自身 UI）、`browser_*`（WebView2 + CDP）已覆盖不少场景。定位写死「原生第三方窗口的 GUI 自动化」，否则模型会拿桌面工具去点自己的界面。

### 12.8 建议排期（替换 §6）

| 阶段 | 内容 | 理由 |
|---|---|---|
| **P0a 零代码** | 手写 mcp.json（`uvx windows-mcp serve --tools Snapshot,Click,Type`），勾 3 工具，跑 Snapshot → Click | 半天证伪「无障碍树够不够用」，不让 Screenshot 混淆结论 |
| **决策点** | 纯 Snapshot 能否完成一次真实点击？ | 能 → 首版砍 Screenshot（协议零改动）；不能 → 排 P1.5 或直接放弃 |
| **P1 会话闸门** | grant 模块 + `toolsForScope` 第三参 + pill + 派发硬拒绝 + 测试 | 唯一必须自己写的核心件，改签名是硬成本 |
| **P1.5（条件）** | MCP 图像结果通道（§12.1-B） | 只在决策点选 B 时做 |
| **P4 doctor** | 纯读诊断绑定 + 设置页按钮 | 便宜，省掉后续所有「为什么点不动」的排查 |
| **P2 安装器（降级）** | 先做「复制安装命令 + 一键写入 mcp.json 行」 | uvx 一条命令 + 设置页已有添加表单，产品化净收益低；新 internal 包 + 回滚 + 测试不划算 |
| **P3 懒加载** | 先量 token，超阈值再前移 | 68 + 18 条 schema 的成本已经不小 |

### 12.9 待决策补充

| # | 问题 | 建议 |
|---|---|---|
| 5 | 首版是否砍掉 `Screenshot`？ | **砍**，先证明纯文本快照够用；不够再补图像通道 |
| 6 | 子代理是否继承 grant？ | **不继承**，首版写死并在 UI 说明 |
| 7 | 安装器是否值得做？ | **先不做**，用「复制命令 + 写配置行」过渡 |

---

## 13. 复核（2026-11-21，v3 迁移完成后）

> 触发：Wails v3 迁移 P0–P3 落地（2026-11-20）+ 应用自身 MCP server 变体落地（`mcp_variant.go` / `tools/rebuild-exe.ps1 -IncludeMCP` / `docs/finished-plans/app-mcp-server.md`）。只读代码与上游，未改实现代码。

### 13.1 方向重定位：两个「桌面 MCP」方向已并存

原方案非目标里写「不做 MCP server 暴露」——已被现实超越，现在两方向并存：

- **方向 a（本方案）**：本应用的 AI 驱动 **Windows 桌面（第三方原生窗口）**——外部 windows-mcp server 接进本应用的 MCP 客户端；
- **方向 b（已完成）**：**外部 agent 驱动本应用**——v3 内置 MCP server（`-tags mcp` 构建变体，Streamable HTTP，`mcp_variant.go` 引导随机令牌 / 端口探测，标准构建零端点）。

两方向互不依赖。方向 b 的 `call_bound_method` 已让外部客户端能直调全部绑定，其威胁模型在 `docs/finished-plans/app-mcp-server.md` 按「全权驱动宿主」评估过。本方案维持方向 a，规划文档只需盯住它；文档引用处（`app-mcp-server.md` 开头）也已互相注明是两回事。

### 13.2 代码事实重验（§3 / §12 全量核对）

| 项 | §12 时 | 现在（2026-11-21） | 结论 |
|---|---|---|---|
| MCP 客户端图像降级 | `mcp_client.go:280-288` | **不变**（`mcp_client.go:288` 的 `case "image", "audio"` 仍降级占位文本；`CallResult` 仍只有 `Text`/`IsError`，`:250`） | §12.1 维持 |
| 256 KB 结果截断 | `mcp_client.go:25` | 不变（`mcpResultMaxBytes`） | §12.7-2 维持 |
| `toolsForScope` 签名 | 两参，加 session 是硬成本 | **三参 `(scope, planMode, session)` 已存在**（`ai-tool-defs.js:1129`）；session 现服务 `videoCapableOf`（read_video 按会话视频能力注入，`:1235`） | §12.2 的硬成本已被 read_video 工作付掉，见 §13.3-1 |
| `toolCatalogText` | 由 `toolsForScope` 反推 | 仍由它反推（`ai-tool-defs.js:1243`） | 「单一判定源、不另加过滤层」约束维持 |
| 子代理 MCP 工具 | `subToolsForScope` 无 MCP 工具 | 仍无；子代理现在甚至拿到 `run_command` + OS 沙箱三件套（`SUB_SANDBOX_MODE_BY_SCOPE`） | §12.3「不继承」维持 |
| `flushToolImages` | `ai-panel.js:10374` | 仍在：定义 `ai-panel.js:9379`、轮边界调用 `:12763` | §12.1-B 图像通道仍可行 |
| 工具数 | `AI_TOOL_DEFS` 68 | **78**（defs 与 catalog 同步 78） | 见 §13.3-3，懒加载压力加大 |
| 会话级放行 | `commandApprovalRules` Map<session.id>，无通配 | 不变（`ai-permission-settings.js:647`） | §12.5 维持 |
| MCP 绑定 | `internal/mcp/client.go` | 不变（`MCPWriteConfig` / `MCPSnapshot` / `MCPCallTool` / `MCPProbeServer`） | — |
| 上游版本 | windows-mcp 0.8.9（2026-11-12），Python ≥3.14 | **仍 0.8.9**，无新版本 | §12.4 全表维持 |

### 13.3 v3 迁移对本方案的实质影响

1. **P1 成本下调**：`toolsForScope` 第三参已就位，桌面授权**不需要动签名**——在 `createAIToolDefs` 的 ctx 上挂 `desktopGrantOn: (session) => bool` getter，MCP 注入分支（`ai-tool-defs.js:1224-1226`）加一个条件；`toolCatalogText` 从同一函数反推，自动跟随。`videoCapableOf` 是现成的同构先例（按会话能力决定一个工具是否注册），照抄模式即可。
2. **多窗口带来新风险——grant 争用（§12.7 之外）**：dsh 是单窗单会话产品，「按会话授权」语义天然成立；本项目 v3 后是多窗多会话（`windowmeta.go` 注册表 + `ai-session-scope.js` 工作区归属），两个窗口各开一个会话、各开各的 pill = **两个 agent 同时驱动同一套物理键鼠**。dsh 的 USER_CONTROL 只防「人抢 AI」，不防「AI 抢 AI」。建议首版做**单飞 grant**：应用级同一时刻只允许一个会话持有桌面授权——新 grant 挤掉旧 grant 并向旧会话投递通知（复用 `ai-agent-notices` 的 notice 通道），pill 显示当前持有者。备选「允许多 grant、争用自负」不推荐：桌面操作静默失败极难排查。
3. **懒加载（P3）优先级上调**：工具数 68→78，桌面若全量注入 +18 会把工具段推到 96 份 schema（仍在 `aiMaxToolDefs = 128` 内，但上下文成本已不是小事）。§12.6 的「P1 落地后量一次 token 再决定」改为**默认前移**：紧跟 P1 / P1.5 实施，且首版白名单只 reveal 观察组（Snapshot / Screenshot / DisplayInventory / Clipboard 等 6–8 个），输入组按需揭示。
4. **子代理与桌面自动化的一般逃逸**：子代理沙箱圈定的是**文件写效应**，不拦键鼠注入——沙箱里的 PowerShell `SendKeys` / UIA 模块照样能驱动桌面。这是 `docs/reports/incident-2026-11-18-workspace-wipe.md` §5「脚本内 shell 不受规则约束」盲区的具体表现：**桌面闸门只管专用桌面工具，管不住 `run_command` 的通用逃逸**。不新增机制（键鼠注入不落盘，wipeguard 的 watcher 覆盖不到，如实承认），但在 pill tooltip 与帮助文档明示「本开关挡不住命令通道」，与 §9.1 / §12.7-1 并列。
5. **「与既有能力抢活」清单更新（§12.7-4）**：`app_control`（自身 UI）与 `browser_*`（CDP）之外，v3 变体的 `mouse_*` / `keyboard_*` 证明**自家窗口的界面自动化已由 v3 原语覆盖**——但它们是往 WebView 里合成 DOM 事件（带动画光标视觉反馈），不是 OS 级 SendInput，只对自家页面有效。桌面工具定位收得更窄：**第三方原生窗口**（资源管理器、其他应用），自家界面一律不许用桌面工具，写进工具描述与守则。

### 13.4 路线复评

- **路线 B 维持推荐**：v3 没有提供任何 OS 级自动化原语（上述合成事件结论），路线 C（自研 Go 桌面 server）的成本判断不变——UIA 元素定位、高 DPI、非英文 Windows 的坑全在上游踩好了，继续白嫖。
- 排期相对 §12.8 的调整只有两处：P1 变薄（签名已就位）+ 新增单飞 grant；P3 懒加载默认前移。P0a 零代码验证不变。

### 13.5 建议排期（替换 §12.8）

| 阶段 | 内容 | 相对 §12.8 的变化 |
|---|---|---|
| **P0a 零代码** | 手写 mcp.json（`uvx windows-mcp serve --tools Snapshot,Click,Type`），勾 3 工具，跑 Snapshot → Click | 不变 |
| **决策点** | 纯 Snapshot 能否完成一次真实点击？ | 不变 |
| **P1 会话闸门** | `ai-desktop-control.js` + `ctx.desktopGrantOn`（**不动签名**）+ pill + **单飞 grant** + 派发硬拒绝 + 测试 | 变薄：签名已就位；加单飞 |
| **P1.5（条件）** | MCP 图像结果通道（§12.1-B） | 不变 |
| **P3 懒加载** | `windows_desktop` 入口 + revealed 集合，首版只 reveal 观察组 | **默认前移**，不再等 token 实测 |
| **P4 doctor** | 只读诊断绑定 + 设置页按钮 | 不变 |
| **P2 安装器（降级）** | 复制安装命令 + 一键写入 mcp.json 行 | 不变 |

### 13.6 待决策补充

| # | 问题 | 建议 |
|---|---|---|
| 8 | 多窗口 grant 争用策略？ | **单飞**：应用级一个会话持有，新 grant 挤旧 + 通知旧会话（§13.3-2） |
| 9 | 懒加载是否默认前移？ | **是**：78 基数 + 18 增量，工具段成本已不是「看起来高级」 |
| 10 | `run_command` 键鼠逃逸首版要不要堵？ | **不堵**：属 incident §5 已知盲区的通用形态，专用闸门管不了通用通道；pill tooltip 明示即可 |
