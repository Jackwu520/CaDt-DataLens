# 标题栏运行配置 · 对齐 JetBrains 运行区

> 状态：已实施（2026-11-18）。需求：标题栏运行区从单枚 ▶ 按钮升级为 JetBrains 新 UI 的 `[配置名/文件名]【展开箭头】【运行 ▶】` widget + 下拉面板；AI 图标保持在最小化按钮左侧。

## 结构

标题栏右侧顺序不变：`运行 widget → 编辑区收起条 → AI 入口 → 窗口控制`；`#tb-run`（▶）原 id 保留、搬进 widget 容器，main.js 既有接线零改动。

- **widget**（`index.html` `#tb-run-widget`）：`#tb-run-config`（`#tb-run-badge` + `#tb-run-name` + chevron，结构仿 `#ws-project`）+ `#tb-run`。无激活配置 → 当前文件名 + 文件图标（`fileIconSpec`）；激活配置 → 配置名 + 彩色字母徽标（hash 色板，与项目弹层同款）。
- **下拉**（`#run-config-pop`，`.tb-pop` 壳）：最近的配置（`lastUsedAt` 降序 cap 5，无记录隐藏）→ 所有配置 N（`.gb-group` 折叠头）→ 当前文件（`applyRunProfile('')`）→ 编辑配置…（`openSettings('run')`）。列表项复用全局 `.pp-item/.pp-label/.pp-sep/.pp-badge/.pp-main`，激活项 `.rc-active`。
- **模块**：`src/shell/titlebar-run-config.js`（第三个标题栏弹层兄弟模块，`titlebar-popovers.js` 里 `Object.create(deps)` 挂载 + 三方互斥交叉关闭；git-branch 末尾的全局 pointerdown / Escape / blur / resize 处理器补 run pop 分支）。

## 配置语义（用户选定：绑定文件）

`settings.runProfiles` 条目升级：带 `file`（绝对路径）= **绑定文件的配置**——选中后 ▶ / F5 直接运行那个文件；不带 `file` = **旧版参数预设**（完全兼容，作用于当前文件、经语言桶生效）。设置 → 运行 →「运行配置」卡片改为管理列表 + 行内编辑器（名称 / 目标文件（`ShowOpenFileDialog` 浏览）/ 参数 / 模板），`lang` 由目标文件扩展名经 `RECIPES` 推导；新建/应用/删除都同步标题栏 widget（`syncRunConfigWidget` 经 deps getter 注入 settings-pane-run）。

## 运行链（run.js）

- 纯函数模型（导出，`run.test.mjs` 护栏）：`activeRunConfig(settings)` / `resolveRunTarget(cfg, activeDocPath, samePathFn) → 'doc'|'disk'|null` / `resolveRunWidgetLabel` / `recentConfigs` / `configRowSubtitle`。
- `run()` 目标解析：`'doc'`（绑定文件 = 活动文档，`samePathValue` 判定）走原内存流（脏文件三选一不变）；`'disk'` 经 `deps.readRunFile`（`backend.OpenFile(path,'')`）读盘，`binary/large` 拒绝，目标在其它标签有未保存修改时 flash 提示「运行的是磁盘内容」（不阻塞——`doc.content` 不随编辑同步，取内存文本不可靠）。
- 参数/模板覆盖：绑定配置时 `ctx.args` 取 `cfg.args`、`templateFor(lang, cfg.template)` 非空覆盖（run-ui 签名加 override 参数）；**不读写语言参数桶与面板输入框**。无绑定配置时行为与旧版完全一致。
- 「最近的配置」口径：`run()` 校验全过后调 `deps.onRunStart(lang, cfg)` → `touchRunProfileRecency`（titlebar-run-config.js）写 `lastUsedAt` + 400ms 防抖 `applySettings`。工具链失败也算「用过」。
- `syncRunButtonState()`（main.js）：绑定配置激活时 ▶ 可用性按绑定文件扩展名判定（不依赖当前标签），tip 显示「运行配置「名」(F5)」。

## 接线点

- `main.js`：els 五个新 id；`titlebarPopovers` deps 补 `applyRunProfile / openSettings / fileIconSpec / file`；解构 `closeRunConfigPopover / showRunConfigMenu / syncRunConfigWidget / touchRunProfileRecency`；`applyRunProfile` 补进 writingUI 解构（原 `...runMod` spread 已带出）；新增 `pickRunFile` / `openDocDirtyByPath`（复用 `findDocByPath`）。
- 跨域数据流（全走 getter 注入，无域间 import）：`syncRunConfigWidget` → writing-ui deps → settings-pane-run；`touchRunProfileRecency / openDocDirtyByPath / samePathValue` → terminal-ui deps → runDeps（`Object.create` 委托自动流入 run-ui / run.js）。
- 面板顶部下拉「默认配置」→「当前文件」（口径统一）。

## 测试与文档

- `test/terminal/run.test.mjs`：模型纯函数 5 组用例；`test/shell/titlebar-run-config.test.mjs`（新登记 `npm test`）：`runConfigMenuModel` 组装口径 3 用例；`test/core/test-manifest.test.mjs` 守卫清单完整。
- 无 Go 改动、无新依赖、mock-backend 无需新增（`OpenFile` / `ShowOpenFileDialog` 已有 mock）。
