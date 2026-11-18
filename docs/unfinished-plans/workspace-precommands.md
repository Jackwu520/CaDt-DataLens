# 工作区预指令（生命周期钩子一期：workspace-open）

> 状态：**方案稿，未开工**（2026-11-19）。源自作者提出的功能评估「预指令 / 生命周期钩子」；现状核实按当日工作区实测，行号仅作定位参考。
>
> 一句话：打开工作区后自动执行一组用户配置的命令；配置在设置页，AI 可经 app_control 代配；**AI 的任何写操作无条件走动作审批（含完全权限档）**。

## 1. 需求

- 工作区打开（含启动恢复、切回）后按顺序自动执行该工作区的启用条目；失败不阻断打开流程。
- 配置入口两处：设置页（用户亲手配）+ AI 经 app_control 代配。
- AI 写入强制走危险审批，**full 档也不例外**；且不只「创建」——AI 的改 / 删 / 启停同权（改命令文本 = 换一条命令），按「AI 对预指令的一切写操作都必审批」设计。
- 生命周期钩子视角：v1 只实现 `workspace-open` 一个事件，schema 预留 `event` 字段，未来扩 `workspace-close` / `ai-session-start` 等不再动存储形状。

## 2. 总体判断

**纯前端即可闭环，零 Go 改动、零新绑定、零新依赖。** 三个关键设施全部现成：

| 设施 | 现状 |
|---|---|
| 触发漏斗 | `openFolderWorkspace(dir)`（`main.js:2965`）是本窗口打开工作区的唯一漏斗：对话框（`openFolderSmart` → `main.js:3014`）、AI 的 `open_folder`（`main.js:1005`）、启动恢复（`session-restore.js:248`）全部汇到这里 |
| 执行通道 | `AIRunShellCommand(command, cwd, timeoutMs, runId, shell)`（`internal/cmdbridge/ai_command_windows.go:309`）：shell 缺省解析、超时钳制（`TimedOut` 如实上报）、输出捕获（8 MB cap，`app_commands.go:27`）、GBK 解码、防黑窗、`runId` 进取消注册表（可停）；**自动合并用户环境变量**（`app_commands.go:96` `envvars.MergeEnv`）。mock-backend 已有同名 mock（`mock-backend.js:1648`） |
| 强制审批 | `set_setting_row` 对 `risk !== 'low'` 的行**无条件**弹动作审批卡、不看权限档（`main.js:1394` 附近）——「full 也必弹」的落地先例；审批卡字段归一用 `normalizeActionApprovalSpec`（`ai-app-approval.js:70`） |

与相邻机制的分工：

- **运行配置**（`settings.runProfiles`）：F5 手动触发、可绑文件；预指令：生命周期自动触发、绑工作区。不合并，pane 相邻摆放。
- **环境变量**（`internal/envvars`）：管「注入变量」，预指令管「初始化动作」；cmdbridge 执行时同一份进程环境，天然协同。
- **wipeguard**：预指令在 AI 体系之外、不经审批链；若它大量删除文件，L2 watcher 照常报警（此时 AI 通常未活跃，不触发熔断 AI 的分支）。文档写明即可，无代码改动。

## 3. 架构

```
main.js
  openFolderWorkspace ──► shell/precommands.js（控制器 createPrecommands(deps)）
        │ runForWorkspace(dir)                │ handleAppAction(action, params, requestActionApproval)
        ▼                                     ▼（AI 四动作：写动作无条件审批，full 不例外）
  core/precommands.js（纯函数：归一化 / 上限 / 工作区过滤 / 审批规格 / 汇总）
        │
        ▼ Wails 绑定（现成，mock 已有）
  AIRunShellCommand ──► internal/cmdbridge（envvars.MergeEnv · GBK · 超时 · procctl 可停）
        │
        ▼ 结果
  messageCenter.add 汇总 · activityLog 留痕

settings.preCommands（localStorage，唯一存储，经 applySettings 落盘 settings-ui.js:652）
  ↑ 用户：settings/settings-pane-precommands.js（设置页）
  ↑ AI：app_control 四动作（main.js runAppAction 转发控制器）
```

依赖方向符合约定：main.js → 域模块（shell / settings 两个控制器）→ 纯函数（core）；`analyzeDangerousCommand` 等 src/ai 纯函数一律经 main.js deps getter 注入，不跨域 import。

## 4. 数据模型

存 `settings.preCommands`（数组，随设置落 localStorage）：

```js
{
    id: 'pc-xxxx',            // 'pc-' 前缀 + 随机
    ws: '<sessionPathKey>',   // 绑定工作区（归一化 key，与 aiWorkspaceKey / WorkspaceBucketKey 同一约定）
    event: 'workspace-open',  // v1 唯一枚举；normalize 拒绝未知值
    command: 'npm run dev',   // ≤2000 字符，trim 后非空
    timeoutMs: 30000,         // ∈ [1000, 600000]，缺省 30000（上限对齐 AIRunShellCommand 内部钳制）
    enabled: true,
    origin: 'user' | 'ai',    // 最后写入方：AI 写 → 'ai'，用户设置 UI 写 → 'user'（可信，见 §5）
    createdAt: 0,
    lastRunAt: 0, lastCode: null,   // 执行器回填，仅展示
}
```

结构级上限（纯函数统一执行，对齐 memo-model 做法）：全局条目 ≤20、单工作区生效 ≤10、command ≤2000 字符、id 前缀校验、未知字段丢弃。

**工作目录固定为该工作区根**，v1 不提供每条目 cwd（要子目录在命令里 cd）；shell 不做成条目字段（要特定 shell 在命令文本里写 `powershell -Command ...`），统一走 `aiShellInvocation` 缺省。

## 5. 安全模型（本功能的核心）

AI 侧共三个入口，处置如下：

| 入口 | 处置 |
|---|---|
| 用户在设置页手动配置 | 用户责任，与运行配置 / 终端等价，不拦；列表行用 `analyzeDangerousCommand`（经 deps 注入）画**只读**危险标记，不阻断 |
| AI 经 app_control 写配置 | 四个写动作**无条件**动作审批（risk='high'，与权限档无关，full 也弹）+ 计划模式拦截 |
| AI 绕过 app_control 直接改存储 | **由存储位置决定成败**——这是选型的决定性因素，见下 |

存储候选对比：

- **A. `settings.preCommands`（localStorage）——采用。** AI 对 localStorage 没有任何写通道：`set_setting` 白名单不含它（`APP_SETTING_RULES`，`main.js:481` 起）、`set_setting_row` 走审批且条目不注册为可写行（见 §7 决策 10）、其余桥不写 localStorage。绕过路径天然关闭，`origin` 字段因此**可信**（执行汇总可如实标注「AI 配置」）。代价：与全部设置同命运（`ui-state` 勾选清数据才重置，`internal/storage/specs.go:277`，显式且罕见）、多窗口内存态 last-write-wins 时滞（运行配置同款）。
- **B. 应用数据 `pre-commands/<ws8hex>.json`（Go 引擎 + 绑定）——备选，暂不采用。** full 档下「写操作与终端命令不再审批，且可访问工作区外路径」（`main.js:12569`），AI 可 `write_file` 直接改文件——审批被绕过且获得**持久化后门**（本轮批过的东西，下次打开工作区自动执行）。要堵须做签名 / HMAC 防篡改，成本与收益不成比例。若作者倾向 Go 存储，需先把这一条摊开评估。
- **C. 工作区 `.cadt/pre-commands.json`——否决。** 配置随仓库走 = 打开陌生仓库即自动执行命令；在 2026-11-18 wipe 事故背景下是红线。

残余风险（如实承认）：full 档的 AI 本来就能直接跑任意命令，预指令的增量风险只在「**持久化**」——跨重启、无监督地反复执行；方案 A 关掉的就是这条持久化通道。另一个残余是社会工程（AI 引导用户手动配置）：审批卡与设置 UI 都要写明「将在每次打开该工作区时自动执行，无需再次审批」。

## 6. 触发与执行流程

1. `openFolderWorkspace(dir)` 尾部（`flash` 之后）异步触发 `precommands.runForWorkspace(dir)`，fire-and-forget，不阻塞打开流程。
2. 过滤：`enabled && event === 'workspace-open' && ws === sessionPathKey(dir)`；空集直接返回。
3. **重入跳过**：同工作区正在执行时（`runningByWs` Set，key = 归一化 ws）跳过本次触发并记 activity——快速 A→B→A 切换时不叠加。
4. **顺序执行**（列表序即依赖序）：逐条 `await backend.AIRunShellCommand(command, dir, timeoutMs, 'precmd-<id>', '')`；单条抛错（含被停）计失败继续下一条；回填 `lastRunAt / lastCode`（内存态，随下次 applySettings 落盘）。
5. 汇总：`messageCenter.add({kind: failed ? 'warn' : 'info', title: '预指令执行完成', body: 'N 条 · 失败 M 条 · …'}, {toast: failed})`（`main.js:3402` API）；失败 toast + 附 stderr 尾部几行（截断）。`origin='ai'` 的条目在汇总中标注「AI 配置」。
6. 留痕：`activityLog.log('precmd.run', dir, {total, failed, aiCount}, {noRel: true})`；配置变更 `activityLog.log('precmd.config', '<entry id>', {op, origin})`。**命令文本是内容，activity 只记摘要不记正文**（对齐操作留痕红线）。

每次打开（含同窗口切回 A→B→A）都执行一次，语义是「打开即执行」，不做去抖。

## 7. 关键决策

1. **存储进 settings（localStorage）**：AI 摸不到 → 审批不可绕过、origin 可信；与运行配置同构。见 §5。
2. **工作区携带配置（`.cadt/`）否决**：仓库borne 自动执行是红线，见 §5。
3. **AI 动作四个**：`get_pre_commands`（只读）/ `add_pre_command` / `update_pre_command`（部分更新，enabled 切换也走它）/ `remove_pre_command`。写动作**无条件审批**（不做成 `pluginInstallRoute` 那种档位路由——full 必须也弹，对齐 `set_setting_row` 高风险行先例）。
4. **AI 只能操作「自己所在窗口的当前工作区」的条目**：`add` 的 ws 自动绑当前工作区（不给 params.ws）；`update / remove` 校验 id 归属当前工作区，跨工作区直接报错——防误伤与跨窗口投毒。
5. **刻意不提供 `run_pre_command`**：AI 想立刻执行走 `run_command` 正常审批链，不给「借道预指令免审批」的旁路。设置页给用户「预跑一次」按钮（纯用户入口，无审批语义）。
6. **计划模式拦截**：三个写动作加入 `ai-panel.js:9728` 的 per-action 清单（`set_setting_row` 同款）。
7. **执行走 `AIRunShellCommand`**：envvars 自动合并、GBK、超时钳制、TimedOut 如实上报、runId 进取消注册表（未来可做停止 UI）。失败不阻断后续、不阻断打开。
8. **只读模式照常执行**：预指令是用户配置的自动化而非编辑行为，不并入 `core/readonly.js` 判定；设置页说明里写明。
9. **多实例不去重**（v1）：两个进程同开一个工作区会各触发一次，用户命令应幂等；将来要堵用 `resourcelease` per-key 租约，不预做。
10. **设置树只暴露一个总开关行**（`precommands.enabled`，switch，risk=medium——AI 经 `set_setting_row` 开关也要审批）；**条目不注册为设置树行**（不用 `.srow` / `data-row-id` 标记，`settings-tree.js:206` 的 settable 派生扫不到它）——条目读写只走专用四动作或设置 UI，避免 `set_setting_row` 第二条写入路径稀释校验与 origin 语义。
11. **审批卡规格固定**：`normalizeActionApprovalSpec({action, title: '新增/修改/删除 预指令（<工作区名>）', target: 命令全文, oldValue, newValue, risk: 'high', warnings: ['批准后该命令将在每次打开工作区 <X> 时自动执行，无需再次审批']})`。
12. **执行顺序 = 列表顺序**，设置页给上移 / 下移（不做拖拽，对齐新建菜单评估的取舍）。

## 8. 改动清单

**前端新增**：
- `src/core/precommands.js`：纯函数——`normalizeEntry` / `validateEntries`（上限）/ `entriesForWorkspace` / `buildApprovalSpec` / `summarizeRuns`。
- `src/shell/precommands.js`：控制器 `createPrecommands(deps)`——`runForWorkspace(dir)`（重入跳过 + 串行执行 + 汇总 + 留痕）与 `handleAppAction(action, params, requestActionApproval)`（四动作 + 无条件审批 + id 归属校验 + settings 写回 + `applySettings()`）。
- `src/settings/settings-pane-precommands.js`：设置 pane（`createSettingsPanePrecommands(deps)`）——总开关行 + 条目列表（启用开关 / 命令预览 / 危险 chip / 上移下移 / 删除）+ 新增编辑行内弹窗 + 预跑一次；表单控件全走 `core/form-controls.js`。

**前端接线**：
- `main.js`：`openFolderWorkspace` 挂点；`APP_ACTIONS` 加 4 个动作；`runAppAction` 加 4 个 case（转发控制器，第 5 参审批通道原样传入）；deps getter。
- `index.html`：设置导航加 `data-pane="precmd"`（放「运行」旁，`index.html:324` 同组）+ pane 容器。
- `frontend/src/ai/ai-constants.js`：cadt-ui 动作表 4 行（写明「写动作必审批 / 无 run 动作 / 只能配当前工作区」）；`open_settings` 行的 pane 枚举补 `precmd`。
- `frontend/src/ai/ai-panel.js`：计划模式拦截清单加 3 个写动作。

**无 Go 改动**：不新增绑定、不动 `wailsjs/`、`mock-backend.js` 无需补 mock（`AIRunShellCommand` 已有）。

**文档收尾**（实施时）：`AGENTS.md`（shell / settings 域模块清单 + 动作三处对齐不动）、`CHANGELOG.md`、`README.md`。

## 9. 测试计划

- `test/core/precommands.test.mjs`：归一化 / 上限拒绝 / 未知 event 拒绝 / 工作区过滤 / 审批规格字段 / 汇总文案。**登记进 `npm test` 清单**。
- `test/shell/precommands.test.mjs`（假 backend + 假审批通道）：
  - 串行顺序、逐条 timeoutMs 传参、单条失败继续、全部失败不打断；
  - 重入跳过（同 ws 第二次触发不执行）；
  - 四动作：**scope 传 'full' 断言仍发起审批**；审批拒绝不写 settings；id 不属于当前工作区报错；add 强绑当前 ws、origin='ai'；update 部分字段、enabled 切换；remove 后列表落盘；
  - 总开关关闭时 runForWorkspace 直接返回。
- `test/ai/ai-app-actions.test.mjs` 三方对账自动覆盖（APP_ACTIONS / 动作表 / switch）。
- 守卫回归：`form-controls-factory`（新文件基线 0 裸控件）、`no-src-tests`。
- Go 侧无改动。

## 10. 手动冒烟清单（实施后）

- [ ] 设置 → 预指令：新建 3 条（1 条危险命令看标记、1 条超时 1s、1 条 `exit 3`），重开工作区 → 按序执行、消息中心汇总、失败 toast、activity 有 `precmd.run`
- [ ] 启动恢复路径（关窗重开同工作区）同样触发
- [ ] 同窗口 A→B→A：每次都触发；快速 A→B→A 连切：重入被跳过
- [ ] 环境变量协同：envvars 配一个变量，预指令 `echo %VAR%`（cmd 缺省）输出含该值
- [ ] AI 全流程：`get_pre_commands` 直读；`add_pre_command` 在 read / edit / auto / **full** 四档下都弹审批卡；批准后条目 origin='ai'、执行汇总标注「AI 配置」；拒绝后无写入
- [ ] AI 计划模式：`add_pre_command` 被拦截并提示
- [ ] `set_setting_row` 无法写条目（树里扫不到）；总开关行 risk=medium 弹审批
- [ ] full 档 AI `write_file` 直改 localStorage 不可行（无通道）；`run_command` 无法借道预指令（无 run 动作）
- [ ] 清空「存储与清理 → 界面状态」后预指令随设置重置（符合 §5 语义）

## 11. 分期

- **一期（本方案）**：`workspace-open` 事件 + 四动作 + 设置 pane + 审批模型。
- **二期候选**（各另行立项）：`workspace-close` 事件（挂点 `closeFolder`，`main.js:3017`）；执行输出进后台终端视图（复用 bridge-terminal-view 作业模型）；AI 会话开始前的 `ai-session-start` 钩子；多实例去重（resourcelease）。
