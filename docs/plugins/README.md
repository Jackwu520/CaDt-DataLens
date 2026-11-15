# CaDt-DataLens 插件开发指南

插件是一个**文件夹**：内含一份 `plugin.json` 清单和一个 JavaScript 入口文件。插件运行在界面（WebView）里，可以通过 `cadt.*` API 注册新的文件格式、工具菜单命令、主题和 AI provider。设置 → 插件 里可以添加、导入、启用/禁用和删除插件。

> **信任模型（重要）**：插件代码与主界面在同一个页面上下文执行，拥有与应用**相同的权限**——包括读写本机文件、执行命令、访问 AI 会话配置，以及注册 AI provider 后在每轮模型请求里注入请求头与请求体字段。应用对插件不做沙箱隔离，安装/导入插件前请确认来源可信；从仓库地址或插件市场安装时会弹确认框明示该风险。

## 快速开始

```text
my-plugin/
├── plugin.json     ← 清单（必需）
└── main.js         ← 入口（默认名，可在清单里改）
```

`plugin.json`：

```json
{
    "id": "bak-json",
    "name": "JSON 备份查看",
    "version": "1.0.0",
    "author": "你的名字",
    "description": "把 .bak 文件按 JSON 解析",
    "entry": "main.js",
    "extensions": ["bak"],
    "license": "MIT",
    "homepage": "https://gitee.com/xxx/bak-json",
    "repository": "https://gitee.com/xxx/bak-json",
    "keywords": ["json", "备份"],
    "minAppVersion": "1.0.0",
    "icon": "icon.svg"
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | ✓ | 小写字母/数字/连字符，≤64 字符；同时是安装目录名，全局唯一 |
| `name` | ✓ | 显示名称 |
| `author` | ✓ | 作者，显示在插件列表 |
| `version` | | 建议语义化版本 |
| `description` | | 描述，显示在插件列表 |
| `entry` | | 入口 JS 文件（相对插件目录），默认 `main.js`，≤2 MB |
| `extensions` | | 该插件涉及的扩展名，仅作列表展示 |
| `license` | | 许可证（SPDX 标识，如 `MIT`），显示在插件列表 |
| `homepage` | | 主页链接（http/https），插件列表可点击 |
| `repository` | | 源码仓库链接（http/https），插件列表可点击 |
| `keywords` | | 关键词标签（最多显示 6 个） |
| `minAppVersion` | | 需要的最低应用版本（如 `1.0.2`）；当前应用版本过低时列表会黄字提醒 |
| `icon` | | 图标文件（相对路径，png/jpg/svg，≤128 KB），显示在插件列表 |

安装方式（设置 → 插件）：**添加插件** 选文件夹；**导入插件(.zip)** 选压缩包（zip 里 `plugin.json` 在根目录或唯一顶层子目录都可以）。插件目录默认在 exe 旁的 `plugins\`，可在设置里切换到 `%APPDATA%\CandySweet\CaDt-DataLens\plugins`。

## 插件 API

入口文件是一个普通 JS 脚本体，加载时会以 `cadt` 为参数执行（相当于 `new Function('cadt', code)`）。可用的 API：

### `cadt.registerFormat(driver)`

注册新的文件格式，复用内置的树 / 表格 / 代码 / 文本视图。

```js
cadt.registerFormat({
    id: 'bak-json',            // 必需，全局唯一，不能与内置格式同名
    name: 'JSON 备份',         // 必需，显示名
    extensions: ['bak'],       // 必需，小写扩展名（不带点）
    parse: (text) => JSON.parse(text),          // 树视图 / 编辑用
    stringify: (value) => JSON.stringify(value, null, 2),  // 保存 / 切视图用
    // 可选：
    // aceMode: 'json'                    // 代码视图高亮（Ace 模式名）
    // rawOnly: true                      // 不提供树视图（纯文本类）
    // table: true, parseTable(text), stringifyTable(headers, rows)  // 表格视图
});
```

- 内置格式优先：与内置格式扩展名相同的插件格式不会被用到（例如注册 `.json` 无效）。
- `parse` 抛异常时该文件自动退回文本视图，不会中断。
- 注册后即刻生效：之后打开的匹配文件会使用该格式；已打开的文件不受影响。
- 格式会出现在 设置 → 文件格式 树里，可获得独立的编码/缩进/换行/默认视图配置。

### `cadt.addCommand({id, label, run})`

在菜单栏 **工具(U)** 里注册命令。

```js
cadt.addCommand({
    id: 'char-count',          // 插件内唯一，会加插件前缀
    label: '统计当前文件字符数',
    run() {
        const file = cadt.getActiveFile();
        const text = cadt.getActiveText();
        cadt.flash((file ? file.name : '无文件') + ' 共 ' + (text ? text.length : 0) + ' 字符');
    },
});
```

### `cadt.addTheme({id, name, bg, accent, css})`

注册主题，出现在 主题(T) 菜单里。

```js
cadt.addTheme({
    id: 'my-theme',
    name: '我的主题',
    bg: '#241f31',             // 窗口底色（菜单色块也用它）
    accent: '#c58af9',         // 强调色
    css: `
        html[data-theme="my-theme"] {
            --bg: #241f31;
            --text: #e8e3f2;
            --muted: #9d94b8;
            --border: #3a3350;
            --hover: #2e2842;
            --accent: #c58af9;
            --on-accent: #1b1626;
        }
    `,
});
```

`css` 是追加进页面的样式表，选择器用 `html[data-theme="<id>"]` 覆盖 `--*` 设计变量即可；建议完整提供 `--bg/--text/--muted/--border/--hover/--accent/--on-accent`。

### `cadt.registerCommandClassifier(spec)`

注册端侧命令风险分类器（自动审批链使用，需含本 API 的应用版本）。端侧分类器只产出危险概率、**无 deny 权**：`score ≥ 严格度阈值` 一律转人工，多个启用的分类器全部执行、保守合并取最高分；分类器抛异常跳过继续，连续 5 次失败本会话内自动停用。

```js
cadt.registerCommandClassifier({
    id: 'onnx-semantics',        // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: '语义分类器（ONNX）',  // 审批卡 / 权限记录里显示
    classify(command, ctx) {     // 可返回 Promise
        // ctx: {cwd, toolName, strictness, threshold, sessionId}
        return {score: 0.02, reason: '只读查询'};   // score = 危险概率 [0,1]
    },
});
```

完整示例见 [`examples/command-classifier-onnx/`](examples/command-classifier-onnx/)（接线演示 + 上架指引）。

### `cadt.registerAIProvider(spec)`

注册一个 **AI provider**：它以「虚拟账号」出现在 设置 → AI 助手 → 模型账号 和模型选择器里，并可在本轮组装请求配置时注入动态请求头 / 请求体补丁。请求与 SSE 解码仍由应用（Go 侧）完成，代理、超时、重试、错误分类等既有能力全部保留。

```js
cadt.registerAIProvider({
    id: 'local-demo',                 // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    name: '示例 · 本地服务',          // 账号显示名
    account: {                        // 连接信息，注册时固定
        provider: 'openai',           // openai（默认）| anthropic | responses
        baseURL: 'http://127.0.0.1:8000/v1',
        apiKey: '',
        temperature: 0.7,
        proxy: '',
        extraHeaders: {},            // 静态请求头
    },
    models: [                         // 至少 1 条，最多 50 条
        {model: 'demo-chat', contextWindow: 128000, outputWindow: 4096},
    ],
    prepare(ctx) {                    // 可选：每轮组装请求配置时调用一次
        // ctx: {sessionId, accountId, providerId, model, baseURL}（不含密钥）
        return {
            extraHeaders: {'x-demo-session': ctx.sessionId.slice(0, 16)},
            extraBody: {tool_choice: 'none'},
        };
    },
});
```

规则与边界：

- **虚拟账号只在内存里**：带 `pluginAI` 标记，保存配置时会被剔除，绝不写进 `ai-config.json` 或 localStorage 镜像；插件禁用 / 卸载 / 加载失败后账号随之消失。账号在设置页只读，改连接信息要改插件代码并重新加载。
- `prepare(ctx)` 必须同步返回；抛异常只忽略本轮补丁，不中断对话。**拿不到 `apiKey`**，动态凭据请走 `extraHeaders` 补丁。
- 补丁只放行 `extraHeaders` / `extraBody` 两个白名单字段，`baseURL` / `apiKey` / `model` 由 `account` 与所选模型决定。请求头合计 ≤ 8 条（动态头优先），请求体补丁 ≤ 32 字段 / 64 KiB。
- `stream` 恒为 `true`（SSE 解码依赖），插件无法通过补丁关掉。协议支持三种：`openai`（`/chat/completions`）、`anthropic`（`/v1/messages`）、`responses`（`/responses`，也可在 设置 → AI 助手 → 模型账号 里手动选）。
- `responses` 走 OpenAI Responses API：消息映射成 `input`（system → `instructions`、工具结果 → `function_call_output`、assistant 工具调用 → `function_call`），工具是扁平的 `{type,name,description,parameters}`；流事件解析 `output_text.delta` / `reasoning_text.delta` / `output_item.done` / `completed`。**依赖 data JSON 里的 `type` 字段**；工具参数取 `output_item.done` 的完整 `arguments`，不拼接 `function_call_arguments.delta` 增量。
- 典型用途：按会话派生关联 ID、给特定网关补 `tool_choice` / 工具声明、注入租户标记等。不适合做协议级改写或出口 IP 轮换（代理应走 `account.proxy` 或系统代理）。
- 完整可运行示例见 [`examples/ai-provider-demo/`](examples/ai-provider-demo/)。

### 命令执行（进程桥）

```js
// 同步执行（超时默认 20s，上限 120s；输出上限 8MB）
const res = cadt.runCommandSync({exe: 'git', args: ['status', '--porcelain'], cwd: 'D:epo', timeoutMs: 15000});
// res = {code: 0, stdout: '...', stderr: '...'}；非零退出码不是异常

// 流式执行
const job = cadt.runCommand({
    exe: 'git', args: ['log', '-n', '10'], cwd: 'D:epo',
    onOut(line) { cadt.openVirtualDoc('输出.txt', line); },
    onErr(line) {},
    onExit(code) { cadt.flash('命令结束：' + code); },
});
job.stop(); // 提前终止
```

### 虚拟文档

```js
cadt.openVirtualDoc('Git 差异 — main.diff', patchText);  // 扩展名决定高亮（.diff → diff 高亮）
```

以未命名标签页打开文本内容，保存时走"另存为"。

### 运行时辅助

| API | 说明 |
| --- | --- |
| `cadt.getActiveFile()` | 当前文件信息 `{path, name, size, formatId}`，无文件时为 `null` |
| `cadt.getActiveText()` | 当前文件文本（按当前视图取值），二进制文件为 `null` |
| `cadt.openPath(path)` | 用本程序打开一个文件或目录 |
| `cadt.flash(message)` | 在右下角弹出提示 |
| `cadt.runCommandSync(opts)` | 同步执行命令（见上） |
| `cadt.runCommand(opts)` | 流式执行命令，返回 `{stop()}`（见上） |
| `cadt.openVirtualDoc(name, content)` | 以未命名标签页打开文本 |

## 目录与切换

- 默认（便携）：`<exe 目录>\plugins\<插件 id>\`，跟程序走，复制目录即可带走。
- 可选（应用数据）：`%APPDATA%\CandySweet\CaDt-DataLens\plugins\<插件 id>\`。
- 在 设置 → 插件 里切换目录模式；切换后列表按新目录展示，已安装插件不会自动迁移。

## 发布到插件市场

插件市场 = Gitee 组织 [`cadt-datalens-plugins`](https://gitee.com/cadt-datalens-plugins) 的公开仓库（Gitee API v5 org repos 列出，仓库根 `plugin.json` 提供元数据）：

1. 在组织下建公开仓库（仓库名建议与插件 `id` 一致），推送插件内容到**仓库根**（清单 + 入口 + 资产，不要包子目录）；
2. `plugin.json` 里 `homepage` / `repository` 指向仓库地址，`minAppVersion` 锁定依赖的应用 API 版本；
3. 推送后市场列表自动出现，无需登记；更新插件 = 推新版本 tag / 提交并更新清单 `version`。

参考：[`examples/command-classifier-onnx/README.md`](examples/command-classifier-onnx/README.md) 的上架指引一节。

## 安全说明

插件代码运行在界面上下文中，能力等同于用户自己运行的脚本（可以调用应用的全部后端接口）。注册了 AI provider 的插件还能在每轮模型请求里注入任意请求头与请求体字段，等同于接管该账号的请求内容——只安装可信来源的插件。应用会在导入时校验清单格式、入口路径与压缩包结构（防路径穿越、限大小），并对补丁做白名单与体积限制，但不做代码沙箱。

## 完整示例

见 [`examples/bak-json/`](examples/bak-json/)：把 `.bak` 文件按 JSON 解析，解析失败自动退回文本视图，并注册一个演示命令与主题。
AI provider 的完整示例见 [`examples/ai-provider-demo/`](examples/ai-provider-demo/)：注册虚拟账号 + 每轮动态请求头 / 请求体补丁。
