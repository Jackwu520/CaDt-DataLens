# 跨平台可行性（评估 + 已完成的护栏）

> 状态：**评估完成，只做了「保命」的那部分**（2026-11-17）。真正移植（macOS / Linux GUI）**未开工**，也**未批准**。
> 范围：整个应用（Go 内核 + 原生前端 + Wails 外壳）在 macOS / Linux 上的可行性；不含插件生态、不含发布渠道决策。
> 相关：`subagent-sandbox.md`（它的「不做 macOS/Linux」只限定沙箱后端，不是软件边界）、`go-layout.md`（本期已把引擎全部下沉 `internal/`，这是跨平台的前提）。

## 1. 结论摘要

| 平台 | 判定 | 理由 | 代价 |
| --- | --- | --- | --- |
| Windows | 现状，继续做深 | — | — |
| **macOS** | **唯一值得做的第二平台** | Wails 官方支持，外壳用系统 WKWebView（**体积与「零依赖」承诺都不破**） | 砍掉内嵌浏览器 ≈ 5–6 周；保留 ≈ 10–14 周 |
| Linux | **不做 GUI** | 必须 cgo + gtk3 + webkit2gtk 动态链接，`单 exe 零依赖`当场破功；AppImage 只是补救 | 14–20 周，且 Wayland 下无边框/多窗口/截图各有坑 |

一句话：**Go 内核早就接近可移植，拦住整件事的只有「内嵌浏览器」这一件真硬骨头**，其余都是体力活。

## 2. 现状实测（2026-11-17）

### 2.1 交叉编译结果

```
GOOS=linux  GOARCH=amd64 CGO_ENABLED=0 go build ./...   → 3 个包失败
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build ./...   → 同样 3 个包，报错逐字相同
```

失败点（已全部修复，见 §5）：

| 包 | 症状 | 性质 |
| --- | --- | --- |
| `internal/browser/browser_other.go:33` | `h redeclared`——`BrowserSetBounds` 的参数 `h int` 与接收者 `h *Host` 重名 | 桩文件**自身语法错误** |
| `internal/gitinfo/gitinfo.go:45`、`worktree.go:68/72/76/108` | 裸写 `syscall.SysProcAttr{HideWindow, CreationFlags}`、`syscall.UTF16PtrFromString`、`syscall.GetFileAttributes` | 平台专属调用写在引擎里 |
| `internal/plugins/plugins.go:604`、`plugins_test.go:220` | 同上 `HideWindow/CreationFlags` | 同上 |

**这组失败最重要的信息不是「有三个 bug」，而是「这些 `_other.go` 桩从来没被编译过一次」**——否则第一行那个重名参数当场就红了。

### 2.2 规模与已有铺垫

| 指标 | 数值 |
| --- | --- |
| Go 非测试非第三方 | 35,988 行 |
| 其中 `*_windows.go` | 6,234 行 |
| 前端 `frontend/src` | 31,008 行 |
| Wails 绑定（`func (a *App)`） | 132 个 |
| `//go:build windows` 文件 | 44 个 |
| `!windows` 桩 | 22 个 |

也就是说：**平台无关代码占比很高**，而且 `stage C/D`（引擎下沉 `internal/`）已经把「引擎不 import main」这条做完了——跨平台真正的大前提已经具备。

### 2.3 桩的可信度必须打折

这些桩能编译，但多数**只是占位**，不能算「已支持」：

| 桩 | 实际行为 | 风险 |
| --- | --- | --- |
| `internal/watch/watch_other.go` | `watchDirectory` 直接返回 error | 文件树外部变更刷新失效（`notifyFileChange` 那条链断） |
| `internal/recycle/recycle_other.go` | `os.RemoveAll` 直接删 | **绕过回收站**，删文件不可撤销 |
| `internal/envvars/envvars_other.go` | DPAPI 降级为明文 | 密钥落盘明文，必须在文档与设置页显式告知 |
| `internal/clipboard/clipboard_image_other.go` | 返回空串 | 粘贴图片退化为纯文本（可接受） |
| `internal/run/run_shells_other.go` | `运行代码暂只支持 Windows` | 「运行代码」整功能不可用 |
| `internal/terminal` | 非 Windows **只有 `Terminal{}` 与 `Emit`**，方法全部不存在 | `App` 内嵌 `*terminal.Terminal` ⇒ **绑定整体消失**（前端调用得到 undefined，不是优雅报错） |
| `internal/toolchain`、`internal/integration` | 同类：方法/实现缺席 | 语言环境检测、文件关联整体不可用 |

> 注意 `internal/terminal` 这一条与其它不同：它是**静默消失**而不是报错，属于「最差的一类降级」，将来移植时必须补 `terminal_other.go`（POSIX PTY），而不是让它继续缺席。

## 3. 分层盘点

| 层 | Windows 实现位置 | 可移植性 | 缺口 |
| --- | --- | --- | --- |
| L1 Go 内核（解析/存储/AI/检索/补丁/SQL） | 根 + `internal/*` | **高**：`modernc.org/sqlite` 纯 Go、`chardec` 纯 Go、`atomfile`/`sessionlock` 已有 POSIX 实现 | 无（已编译通过） |
| L2 平台薄层（原子替换/跨进程锁/回收站/环境变量/代理） | `internal/{atomfile,sessionlock,recycle,envvars,aitransport}` | 中：一半有真实现（flock、`os.Rename`、`http.ProxyFromEnvironment`） | 回收站要改 `gio trash` / `osascript`；watch 要换 fsnotify |
| L3 子进程（run / mcp / git / plugins / search_rg / cmdbridge） | `internal/{run,mcp,gitinfo,plugins,search,procctl,cmdbridge}` | 中：`executil` 已收口防黑窗；`HideWindow` 在 POSIX 是空实现 | `run_shells_other` 要重写（无 `cmd.exe`）；`taskkill` 要换进程组 kill |
| L4 内置终端 | `internal/terminal/terminal_windows.go`（481 行，go-pty） | 中高：`go-pty` / `creack/pty` 本身支持 unix | 需 `terminal_other.go`；shell 探测要认 `$SHELL` 而非 pwsh/Git Bash |
| L5 应用外壳 | `main.go`（`Frameless: true` + `windows.Options`）、`webview_args_windows.go`、`cursors_windows.go` | macOS **高**（WKWebView 系统自带）；Linux **低**（gtk+webkit 动态链接） | mac：红绿灯、双击标题栏、全屏/`Cmd+W`；Linux：Wayland 下拖动/多窗口/截图 |
| L6 内嵌浏览器 | `internal/browser/*_com_windows.go` + `browser_app_windows.go` + CDP 桥 | **极低** | WKWebView 无 CDP，`BrowserCallCDP`/`BrowserEval`/`BrowserSnapshot` 整套要重写 |
| L7 前端交互契约 | `frontend/src`（85 处 `"Ctrl+"` 文案、19 文件共 69 处 `ctrlKey` 判定） | 低（面积大但机械） | **无任何平台判定**（`darwin`/`isMac` 零命中）：文案与判定都要经 `accel` 抽象收口；字体栈 `Inter`+`JetBrains Mono` 需补系统回落 |

## 4. 分平台详评

### 4.1 macOS

有利面：

- Wails v2 官方支持 macOS，外壳用系统 **WKWebView**——**不加体积、不加运行时依赖**，「单 exe 零依赖」的语义可以平移成「单 app 零依赖」。
- `go-pty`、`modernc.org/sqlite`、`chardec` 全部纯 Go / 支持 darwin；`sessionlock` 的 flock 实现现成。
- Go 侧今天已经编过（`darwin/arm64` + `amd64`）。

阻碍面（按代价排序）：

1. **内嵌浏览器**：WKWebView 没有 CDP。AI 的 `browser` 系列工具（`BrowserCallCDP` / `BrowserEval` / `BrowserSnapshot` / `BrowserCaptureScreenshot`）目前建立在 CDP 上。两条路——①首版直接降级「用系统浏览器打开」，`browser` 工具链在 mac 上停用；②重写一套 WKWebView 版（WebKit 的 Remote Inspector 协议非公开、无稳定文档），**数周级且易烂**。**建议 ①**。
2. **快捷键**：85 处 `"Ctrl+"` 文案 + 69 处 `ctrlKey` 判定，且没有平台判定。mac 上 `Cmd` 才是习惯键。必须先把 `accel`（显示文案）与 `isAccel(e)`（判定）收成单一来源，否则就是逐文件改错。
3. **无边框标题栏**：`Frameless: true` + 自绘 `#wc-min/#wc-max/#wc-close`。mac 上要么放系统红绿灯（`Mac.TitleBar: HiddenInset` + 左侧留白），要么自绘三个圆点并补 `Cmd+W`/`Cmd+M`/双击标题栏缩放。
4. **打包与签名**：`.app` + `.dmg`、Apple Developer ID 签名 + 公证（notarization），否则用户首次打开被 Gatekeeper 拦。`internal/update` 的 `pickInstallerAsset` 只认 `.exe`，要加平台资产选择。
5. **零散**：`screenshot`（窗口截图，需 `CGWindowListCreateImage`/ScreenCaptureKit）、`cursors`（`GetSystemCursors` 已返回空 ⇒ 回落 CSS，可接受）、`notify`（`go-toast` 支持 darwin，但要重写 `notify_other.go`）、`ShowInFolder`（`open -R`）、文件关联（LaunchServices 而非注册表）、`clipboard` 图片（`NSPasteboard`）。

### 4.2 Linux

- 外壳必须 cgo 链接 `gtk3` + `webkit2gtk`（Wails v2 在 Linux 的既定形态），**与「单 exe 零依赖」直接冲突**；AppImage 能把库打进去，但体积从 ~15 MB 级跳到 100 MB 级，且 `webkit2gtk-4.0/4.1` 的构建 tag 差异会分裂产物。
- Wayland 下无边框窗口拖动、多窗口定位、全局截图都要单独做（X11/Wayland 两套路径）。
- 发行形态碎片（deb/rpm/AppImage/flatpak）+ 无 Apple 那样的统一签名体系。
- 唯一低成本的「Linux 支持」是 **CLI**：`--check-patch` / `--apply-patch` / `--revert-patch` 是纯 Go（`internal/patch` 已有 `_other.go`），可直接产出 linux 二进制；`--convert` **不行**——它的格式互转在前端跑。

## 5. 已完成（2026-11-17，本次）

1. **修好三处编译失败**（行为零变化）：
   - `internal/browser/browser_other.go`：`BrowserSetBounds` 参数 `h` → `height`（消除与接收者重名）。
   - `internal/gitinfo/gitinfo.go`：`SysProcAttr{HideWindow/CreationFlags}` → `executil.HideCommandWindow(cmd)`。
   - `internal/gitinfo/worktree.go`：`isReparsePoint` / `createJunction` / `junctionSupported` 拆进 `worktree_platform_windows.go` + `worktree_platform_other.go`；`linkDepDirs` 在非 Windows 直接跳过（junction 是 Windows 增益，不是 worktree 前提）。
   - `internal/plugins/plugins.go`、`plugins_test.go`：同改 `executil.HideCommandWindow`。
2. **两道护栏**：
   - `crossplatform_guard_test.go`（根包，毫秒级静态扫）：平台无关文件里出现 `SysProcAttr{HideWindow|CreationFlags}`、`syscall.UTF16*/GetFileAttributes/FILE_ATTRIBUTE_*`、`"golang.org/x/sys/windows` 直接红；带「扫描面 ≥40 文件」防呆（避免规则被改坏后空跑）。**已做故障注入验证**：临时插一个探针文件必红，删掉即绿。
   - `tools/check-crossbuild.cmd` + `tools/check-crossbuild.ps1`：对 `linux/amd64`、`darwin/arm64`、`darwin/amd64` 三个目标跑 `go vet ./...`（CGO 关闭，不需要目标平台工具链；用 vet 而不是 build 是因为 vet 连 `*_test.go` 一起编，能挡住「测试辅助函数里写了 Windows 专属调用」——`plugins_test.go:220` 就是这么发现的），约 8 秒/目标。
3. 现在 `go build ./...` 在 windows / linux / darwin 三平台全绿。

## 6. 若决定移植：分期

| 期 | 内容 | 级别 |
| --- | --- | --- |
| P0 | 修编译 + 两道护栏 | **已完成** |
| P1 | 前端 `accel` 抽象（文案 + 判定单一来源）、`platform` 变量、字体栈回落 | 2–3 天，**与是否移植无关，收益独立** |
| P2 | mac 外壳：红绿灯/标题栏、全屏与 `Cmd+W`、`ShowInFolder`、文件关联、`notify` | 3–5 天 |
| P3 | mac 运行态：`terminal_other.go`（POSIX PTY）、watch（fsnotify）、recycle（回收站）、envvars 明文告知、screenshot 取舍 | 1–2 周 |
| P4 | 打包：`.app`/`.dmg`、签名公证、`pickInstallerAsset` 分平台 | 1 周（含 Apple Developer 账号） |
| — | **内嵌浏览器**：mac 首版明确「无内嵌浏览器，改用系统浏览器」 | 0（若要保留：4–8 周，不建议） |

合计：**mac 全功能 ≈ 10–14 周；砍内嵌浏览器 ≈ 5–6 周**。Linux GUI 不列入。

## 7. 与 `subagent-sandbox.md` 的关系

那份方案的 Windows ACL + 受限令牌是**对的**（mac 对应 seatbelt、Linux 对应 bwrap/Landlock，都是另一套后端），本次只提一条接口约束：

- **阶段 A 不要把「模式解析 + 后端选择」写进 `sandbox_windows.go`**。平台无关的 `run` 包负责 `mode + writableRoots → runner`，`sandbox_windows.go` 只做 ACL/令牌后端。这样将来加 `sandbox_darwin.go` 是新增文件，不是改调用链。
- 优先级上，沙箱排在「外壳能跑」之后；现在**不需要**写任何 `sandbox_darwin.go` / `sandbox_linux.go`。

## 8. 风险与既有事实

- **桩腐坏**：这 22 个 `_other.go` 之前从未被编译，行为也没有任何测试覆盖。P2/P3 动手时要把它们当「草稿」重读一遍，不能当「已支持」。
- **静默降级 vs 报错**：`internal/terminal` 是「绑定整体消失」，`internal/watch` 是「返回 error」，两种都对用户不友好；移植时要统一成「功能可见但明确提示不可用」。
- **维护成本**：跨平台后每个新功能都要在三平台过一遍构建；护栏只能保证「编得过」，跑不跑得起来仍要真机验证。
- **不承诺**：沙箱与权限体系都只是减险手段（见 `subagent-sandbox.md` §5），跨平台不改变这一点。

## 9. 未决问题

1. macOS 是否**只做「查看器」子集**（去掉内嵌浏览器、内置终端、运行代码、语言环境检测）？这能把工期压到 3–4 周，且不碰最脏的三块。
2. Apple Developer 账号（$99/年）与公证流程谁来承担？没有它，mac 分发只能靠「右键打开」教用户。
3. Linux 是否只发 CLI（`--check-patch` / `--apply-patch`）作为「能读能改」的最低承诺？
4. P1 的 `accel` 抽象现在就做，还是等真的立项？**倾向现在做**——它和移植无关，且能顺手修掉菜单里写死的 `Ctrl+` 文案问题。
