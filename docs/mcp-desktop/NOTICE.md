# 内置桌面控制组件（windows-mcp）说明

本目录随 CaDt-DataLens 分发的桌面控制组件，供「应用页面 → 外部工具 → 桌面控制」在用户机器上
释放与安装。**已对上游做本地补丁**（见下表），不是原样分发。

| 项 | 值 |
|---|---|
| 上游项目 | windows-mcp |
| 上游版本 | 0.8.9（MIT License，原许可全文在 wheel 内 `windows_mcp-0.8.9.dist-info/licenses/LICENSE.md`） |
| 本地版本 | **0.8.9+p3**（PEP 440 本地版本号，标明有本地改动） |
| 基线（未改动原版） | `vendor/windows_mcp-0.8.9-py3-none-any.whl` / sha256 `e90e5b02b3e545991f203ce93cefb436a326861657968591653fa254105dc85d` |
| 发行产物（随 exe 内嵌） | `windows_mcp-0.8.9+p3-py3-none-any.whl` / sha256 `d17dde0a6f6ac782684a642597c79d481dd63eae8a572431d5bdfafed409183c` |
| 打包方式 | `uv run python tools/pack-desktop-wheel.py`（基线 + overlay → 重算 RECORD → 新 wheel） |

## 本地改动（0.8.9 → 0.8.9+p3）

`overlay/` 下 6 个文件覆盖到基线，其中 `tools/find.py` 是**新增文件**（基线里没有同名路径时打包脚本
按新增处理，并打印出来）：

| 文件 | 改动 |
|---|---|
| `windows_mcp/desktop/service.py` | ① `get_state` 新增 `window_filter`：按窗口标题**正则**挑出目标窗口，只对它建树并把截图裁到该窗口矩形（显式 `region` 仍优先）。② `type()` 拆出 `_type_into()`，新增 `type_focused()`：不点击、直接往当前焦点输入。③ 新增 `find_elements()` / `activate_element()`：按名字/文本匹配交互元素并点击（属后台窗口时点两次，第一次只负责激活）。 |
| `windows_mcp/tools/_snapshot_helpers.py` | `capture_desktop_state` 透传 `window` → `window_filter`。 |
| `windows_mcp/tools/snapshot.py` | `Snapshot` 新增 `window` 参数（描述写清用法与「region 优先」）。 |
| `windows_mcp/tools/input.py` | `Type` 的 `loc` / `label` **都省略**时改走 `type_focused()`；描述同步。 |
| `windows_mcp/tools/__init__.py` | 注册新模块 `find`（工具数 21 → 22）。 |
| `windows_mcp/tools/find.py` | **新工具 `Find`**：`query`（子串，可 `exact` / `regex`）+ `action=list\|click\|type` + `nth` + `window` + `limit`。 |

### 三个改动各自解决了什么（都是实机跑任务踩到的）

1. **`Snapshot(window=…)`** —— 同时开着几十个窗口时，无关窗口的元素会先把元素预算（默认 500 条）
   吃满，真正想看的窗口反被截断，只能反复 `region` 盲猜坐标。
2. **`Type` 不给坐标** —— 地址栏已 `Ctrl+L` 聚焦，却必须先把文本写进剪贴板再 `Ctrl+V`：多两步往返，
   还污染用户剪贴板。
3. **`Find(query, action='click')`** —— 要点头部的按钮 / 卡片 / 某一行，只能先 `Snapshot` 拿编号再
   `Click(label=N)`，或截图目测坐标。`Find` 直接按可见文字定位并点击，省掉一次全量快照。

不传新参数时行为与 0.8.9 完全一致，无回归面。

## 为什么不做 CSS selector / CDP

Chrome 136 起**禁止对默认 user-data-dir 开 `--remote-debugging-port`**：要走 CDP 就得另起一个用户
数据目录，用户的登录态、扩展、"记住我"全部丢失。代价远大于收益，因此改用「按可见名称匹配 UIA
交互元素」——零依赖、不重启浏览器，覆盖绝大多数点击需求（按钮、链接、菜单项、输入框标签）。

## 为什么这样做（而不是 fork 整个仓库）

- **体积**：只内嵌 wheel（约 300 KB）；Python 3.14 解释器与 21 个依赖（约 197 MB）不内嵌，首次安装由
  uv 下载到用户缓存，安装界面显示进度。
- **可维护**：仓库只存**改动的文件**（`overlay/`）+ 原版基线 wheel；上游升级时把 overlay 重放到新
  基线、跑一次 `tools/pack-desktop-wheel.py` 即可，diff 可审查。
- **合规**：MIT 允许修改与再分发，但必须保留版权声明与许可文本、标注已修改——故用 `+pN` 本地版本
  号，基线原版完整留在 `vendor/`，许可随 wheel 一起分发。

## 维护约定

- 改 `overlay/` 后**必须**跑一次 `tools/pack-desktop-wheel.py`，并把新 wheel 的 sha256 写回本文件。
- `internal/desktopmcp/desktopmcp.go` 的 `Version` / `WheelName` 与根壳 `desktop_mcp.go` 的
  `go:embed` 路径三处必须同步，否则编译失败或内嵌到旧产物。
- 新增工具要同时改：`internal/desktopmcp.AllTools`（Go 侧权威清单）、
  `frontend/src/ai/ai-desktop-control.js` 的 `DESKTOP_ALL_TOOLS`、`dev/mock-backend.js` 的
  `MCPDesktopPlan` mock，以及 `desktopmcp_test.go` 的清单用例。
