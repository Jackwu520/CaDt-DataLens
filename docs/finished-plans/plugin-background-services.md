# 插件后台服务托管 + 专属设置页

> 状态：**已实施**（2026-11-19）。需求：让插件能把长驻后台进程（典型：zcode2api 反代）交给软件统一托管——开机自启、健康检查、退出清理，并给插件一个独立的弹层入口（专属设置页）。用户已拍板三项：通用后台服务 API + 插件专属设置页 + 连带改造 zcode2api 插件。

## 背景与动机

接入 zcode2api（把 Z.ai 免费额度反代成标准 Anthropic `/v1/messages`）时，第一版插件只做了 `cadt.registerAIProvider` 虚拟账号——纯配置、零源码改动，但**服务进程要用户自己在终端跑**。第二版用插件的 `cadt.runCommand` 帮用户敲命令，但进程桥有硬伤：

- 无自启 / 生命周期钩子：插件只在加载时执行一遍脚本体（`plugins.js` 的 `loadPlugins`），应用退出不回收进程。
- 输出 8 MB 上限后桥接层停止读 stdout（`internal/cmdbridge/app_commands.go`）。
- 插件拿不到自身目录：Go 的 `PluginSource` 有 `Dir` 字段（`internal/plugins/plugins.go`），但 `pluginSourceAt()` 只拷 Id/Name/Version/Code，前端 `apiFor()` 也没透出。

结论：**在插件层修修补补做不到可靠托管**，需要改软件本体，把"后台服务"做成一等公民能力。

## 三项新能力（对插件作者）

### `cadt.getPluginDir()`

返回插件安装目录绝对路径。插件可用它拼资源 / 脚本路径，零配置约定：把配套服务源码放进插件目录的 `server/` 子目录。

### `cadt.registerService(spec)`

声明一个后台服务，进程启停 / 探活 / 日志 / 退出清理全交给软件：

```js
cadt.registerService({
    id: 'server', exe: 'python', args: ['main.py', 'serve'],
    cwd: cadt.getPluginDir() + '/server',
    healthURL: 'http://127.0.0.1:3000/v1/models',
    autoStart: true, pollIntervalMs: 5000,
});
```

- 每个插件重放完成后统一 `AppServiceSync`：新增 / 变更的 `autoStart` 服务拉起，被禁用 / 卸载插件的服务停止并移除。
- `healthURL` 非空时定期 GET 探活（超时 2s，2xx–4xx 存活），连续 5 次失败置 `failed`；留空只按进程存活判定。
- 状态机 `stopped / starting / running / failed`；进程意外退出自动转 `failed` 并记录原因。
- 日志按行收进环形缓冲（默认 256 KiB，超出丢最早），规避命令桥 8 MB 截断。
- 声明只在内存里、不落盘；exe/args/cwd 合法性由插件负责，应用**不做沙箱**——只托管可信来源插件。
- 操作 API（Promise）：`startService / stopService / getServiceStatus / getServiceLogs`（插件内短 id）。

### `cadt.registerSettingsPanel(spec)`

注册插件专属设置面板，出现在「设置 → 插件设置」下（独立导航项 + 插件卡片按钮）。`render(container, ctx)` 同步渲染，ctx 提供 `flash / startService / stopService / getServiceStatus / getServiceLogs / openExternal`。面板只在内存里，插件禁用 / 卸载后自动消失。

## 实现结构

### Go：`internal/appservices/`（纯引擎，不 import main）

- `service.go`：`Spec` / `Status` / `Registry`；`Register / Sync / Start / Stop / Status / List / Logs / StartAll / StopAll`。`Sync` 是前端唯一真源推送入口：不再声明的服务停止移除、spec 变化的服务重建、autoStart 的拉起。id 规则 `^[a-z0-9][a-z0-9-]{0,63}$`，间隔下限 500ms，日志上限下限 1 KiB。
- `process.go`：进程启停复用 `internal/procctl`（`Register / Stop / ApplyCancel`，取消即杀整棵进程树），防黑窗走 `internal/executil.HideCommandWindow`；stdout/stderr 按行泵入环形缓冲；`watchProcess` 判定意外退出、`watchHealth` 探活。进程原语经包级 indirection 包装，单测可替换、不真起进程。
- `hooks.go`：`Logf` 由根壳注入（同其它引擎）。
- 平台相关符号不出现在本包平台无关文件里（防黑窗 / 杀树都经 executil 平台对）。

### Go 根壳接线

- `appservices_app.go`：`init()` 注入 Logf；6 个 Wails 绑定 `AppServiceSync / Start / Stop / Status / List / Logs`。
- `app_core.go`：App 具名字段 `AppServices *appservices.Registry`（**不能用匿名嵌入**——嵌入字段名是 `Registry` 而非 `AppServices`），`NewApp()` 初始化；`startup()` 里 `StartAll()`。
- `app_window.go`：真退出分支 `beforeClose`（:158 附近）与 `ForceClose` 各加 `StopAll()`，与 `stopTray / mcpCloseAll / UnwatchWorkspace` 并列；藏到托盘路径不清理（进程不退出）。

### 前端

- `src/shell/plugin-services.js`（新）：纯注册表——规范化 spec（cwd 空回退插件目录、相对路径以插件目录为基准）、插件内短 id → Go 全局 id（`pluginId-shortId`，全 `[a-z0-9-]`）、`buildServiceSpecs()`、操作转发 backend；`bindServiceBackend()` 由 `loadPlugins` 设置。
- `src/shell/plugin-settings-panels.js`（新）：面板注册表 + `panelPaneKey()`（纯连字符，避免 CSS 选择器转义）。
- `src/shell/plugins.js`：`apiFor()` 增加 `getPluginDir / registerService / registerSettingsPanel / startService / stopService / getServiceStatus / getServiceLogs`；`loadPlugins` 清空两个新注册表、绑定 backend、把 `source.dir` 透进 plugin 对象，所有插件重放完成后 `await backend.AppServiceSync(buildServiceSpecs())`（失败只记诊断不阻断）。
- `src/settings/settings-pane-plugins.js`：`setupPluginSettingsNav()` 动态建「插件设置」导航分组与面板容器（仿 `settings-pane-lang.js` 范式，先清失效节点再重建）；插件卡片加面板入口按钮；`renderPluginSettingsPane(key)` 组装 ctx 调 `spec.render()`。
- `src/settings/settings-ui.js`：`selectSettingsPane` 加 `plugin-` 前缀分支。
- `src/main.js` / `src/writing/writing-ui.js`：deps 接线（`renderPluginSettingsPane` / `openSettings` / `rt`）。
- `src/dev/mock-backend.js`：6 个服务绑定 mock（状态存 `window.__mockAppServices`）。
- Wails 绑定三件由 `wails build` 重新生成（App.js / App.d.ts / models.ts 的 `appservices.Spec` / `Status`）。

### zcode2api 插件（v1.0.0 → v1.1.0）

`plugins/zcode2api/`：反代源码放 `server/` 子目录即零配置；`registerService` 托管（autoStart + `/v1/models` 探活 5s）、`registerSettingsPanel` 做状态/启停/日志/装依赖/打开管理页的面板；保留 `registerAIProvider` 虚拟账号。

## 设计取舍

- **为什么独立引擎而非复用命令桥**：命令桥面向"一次性/交互式命令"（8 MB 输出上限、无自启/回收），后台服务需要长驻 + 环形日志 + 退出统一清理，语义不同；复用 `procctl` 进程树取消能力即可，不重复造进程管理。
- **Sync 而非逐个注册**：插件每次加载都是"全量重放"，Sync 一次覆盖最能表达"禁用/卸载插件的服务要消失"，也避免逐个 diff 的竞态。
- **具名 AppServices 字段**：Go 匿名嵌入的字段名是类型名，写 `a.AppServices` 必须具名声明（实施时踩过一次编译错误）。
- **pane key 纯连字符**：`plugin-<id>-<panel>`，不用冒号，避免 `querySelector` 属性选择器转义。
- **面板 render 同步 + 宿主复用容器**：异步数据由插件自己 `.then()` 填；重渲染时插件自己清定时器（容器被复用），宿主不替插件管理生命周期。
- **不做沙箱**：与插件系统既有信任模型一致（插件代码与应用同权限），服务声明也一样——来源可信是前提，文档里明示。

## 验证

- Go：`go test ./internal/appservices -timeout 120s` 通过（注册去重 / 状态机 / 日志环形上限 / 启动失败 / 探活 / 幂等停止 / specEqual）；改动三包 `go test . ./internal/appservices ./internal/plugins` 全绿。
- 前端：新增 `test/shell/plugin-services.test.mjs`（7 例）/ `plugin-settings-panels.test.mjs`（4 例）并登记 `npm test`；全量 **1438 项**通过，清单守卫 `test-manifest.test.mjs` 双向核对通过。
- 构建：`wails build -devtools` 成功，重新生成的绑定字段 / 方法签名与手写一致。
- 已知无关问题：`go test ./...` 中 `internal/sessionstore` 有编译失败（工作区其他未提交改动给 `AISessionSaveImage` 加了 `workspace` 参数、测试未同步），与本次无关，未触碰。

## 相关文档

- 插件 API 用户文档：`docs/plugins/README.md`（`getPluginDir` / `registerService` / `registerSettingsPanel` 三节）。
- 变更记录：`CHANGELOG.md` 未发布区。
- 参考实现：`plugins/zcode2api/`（虚拟账号 + 后台服务 + 设置面板三合一）。
