# 应用作为 MCP server（v3 内置能力，构建变体）

状态：**已实施**（2026-11-20，`v3-migration` 分支）

## 背景

Wails v3 内置了一个 MCP server（`-tags mcp` 编译开关）：`App.Run()` 自动在本地起一个
Streamable HTTP 端点，把一套「外部 agent 驱动应用界面」的工具暴露给任意 MCP 客户端：

- `app_info` / `windows_list`：应用与全部窗口的元信息
- `window_control`：focus/show/hide/close/maximise/set_size/set_position/set_title/set_url/set_always_on_top …
- `js_eval` / `dom_html` / `dom_query`：在页面里执行任意 JS、读 DOM
- `mouse_move` / `mouse_click` / `mouse_drag` / `mouse_scroll` / `keyboard_type` / `keyboard_press`：界面自动化（带可视光标反馈）
- `call_bound_method` / `emit_event` / `wait_for_event` / `screenshot_dom`：直调任意 Go 绑定、事件收发与页面截图——**`call_bound_method` 可不经 js_eval 直调全部绑定（读写文件/跑命令），威胁模型按「全权驱动宿主」评估**

这与 `docs/unfinished-plans/desktop-mcp.md` 是**两回事**：那份规划是把外部桌面自动化
server（windows-mcp）接进本应用的 MCP 客户端；这里是把**本应用**暴露为 MCP server。
两者互不依赖，可以并存。

## 形态：构建变体，标准构建零端点

`js_eval` 等于在页面里执行任意 JS——对本地数据编辑器是重权能，且 v3 的 server
**没有运行期开关**（有 tag 就启动）。所以做成构建变体：

- 标准构建（`tools/rebuild-exe.ps1` 默认）：**不含**该端点，二进制里没有任何 MCP 代码路径。
- `-IncludeMCP` 变体（`tools/rebuild-exe.ps1 -IncludeMCP`）：`-tags "production,mcp"`。

## 变体的安全引导（`mcp_variant.go`）

v3 的 server 只能经环境变量配置，且绑定失败会让 `App.Run` 报错退出。启动早期（Run 之前）：

1. 令牌：首次生成 24 字节随机 hex，持久化到 `<应用数据>/mcp-server.json`（0600，原子写）；
2. 端口：默认 9099，被占用则向后探测 20 个（探测+持久化，重启沿用）；
3. `os.Setenv` 注入 `WAILS_MCP_HOST/WAILS_MCP_PORT/WAILS_MCP_TOKEN`（host 固定 127.0.0.1）；
4. 连接信息写回 `mcp-server.json`：`{endpoint, port, token, note}`，应用日志记一行端点。

外部客户端拿 endpoint + token 配置即可。删除 `mcp-server.json` 重启应用即可轮换令牌。

## 威胁模型与边界

- 只绑回环地址；token 只防「其他机器」与「误用客户端」，**防不了本机恶意进程**
  （它能读用户文件本身——本机威胁模型与用户权限等同）。
- `js_eval` 绕过应用内所有审批链（MCP 工具白名单、AI 写权限档）。因此**标准构建不含它**；
  变体只建议在受信机器、明确需要外部 agent 驱动界面时安装。
- 变体不含设置页开关：装了变体 = 启用。要停用就换回标准构建。安装包脚本（build-installer.ps1）同样支持 `-IncludeMCP`；`envvars.SanitizeChildEnv` 会向全部子进程（终端/命令桥/沙箱/插件服务）屏蔽 `WAILS_MCP_*`，防止受控进程拿凭据反向驱动宿主。

## 验证

- 双构建编译：`go build -tags production` 与 `-tags "production,mcp"` 均通过；交叉编译不受影响（`mcp_variant_default.go` 无平台代码）。
- 手工回归项：变体 exe 启动后 `mcp-server.json` 生成、端点可达、用外部客户端连上后 `windows_list` 能看到主窗口；标准构建无 9099 监听。
