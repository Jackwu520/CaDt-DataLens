# 子代理命令执行与 OS 级沙箱（方案）

> 状态：**未开工**（2026-11-15 调研成文，当日未实施）
> 决策依据：2026-11-15 评估「子代理权限最大对齐 dsh（deepseek-harness）」时定档——语义对齐（提示声明 + 确定性拒绝 + 留痕）当日已落地，OS 沙箱单独立项为本方案；设计参考 dsh 的 `sandbox` / `sandbox-policy` / `sandbox-local` / `approval` 子系统与设计笔记（路径见 §1.2）
> 范围：子代理获得命令执行能力，文件效应由 Windows OS 级沙箱强制圈定；不改主会话命令链路、不做子代理审批链路（子代理永远「不问」）、不做 macOS/Linux

## 1. 背景与现状

### 1.1 现状（代码事实）

- 子代理工具白名单 `subToolsForScope(depth, mode)`（`frontend/src/ai/ai-subagents.js`）：只有 list_dir / read_file / search_text / web_search / web_fetch / memory_list / memory_read / timer_list / skill_use / env_list（后台模式 + ask_user，深度允许 + spawn_agent）。**没有命令与写工具**。
- 执行侧用 `allowed` 集合硬挡（`runSubRound` 的工具循环）：范围外调用走独立的确定性拒绝分支——模型侧文案「超出子代理只读范围……不要重试，在最终结论中说明限制」，留痕 `ai.tool` status: denied（2026-11-15 落地）。
- 子代理系统提示已声明「工具范围在派出时已固定，无法从会话内放宽；被拒不要重试、上报父会话」（同日落地，对齐 dsh 的 `SUBAGENT_DELEGATION_CONTEXT` 声明）。
- 主会话 `run_command` 链路：审批卡 + 自动审批档（只读命令族自动执行、危险命令确认一次、端侧分类器辅助判级，见 `ai-command-rules.js` / `ai-local-classifier.js`）+ `timeoutMs`（默认 30s、上限 120s）；Go 侧 `RunExec`（PrepareRun 临时副本与工作目录、流式执行、GBK 解码、PATH 前置、stdin 队列 `RunInput` / `RunEndInput`）。
- 2026-11-15 实测：子代理探针调用 run_command / background_command / start_timer 全部被拒——「让子代理 sleep / 跑只读探测」在架构上堵死；主会话 `start_timer` 串行派单可行但笨重（450 秒级错峰验证只能靠主会话计时器逐个等）。

### 1.2 dsh 参考事实

- **策略钉死派生边界**（`packages/subagent/subagent/src/child-agent.ts` L221-280）：派生时向子会话日志追加三类持久策略事件——`sandbox/mode`（仅继承父的显式 override，不复制部署默认与一次性 grant）、`approval/policy{policy:'never', source:'delegation'}`（一律钉死，与父自身策略无关）、`permission/preset`（仅父为 auto / danger-full-access 时复制身份）。
- **审批 pin never 的动机**（`.agents/notes/archived/feature/2026-08-10-subagent-approval-pinned-never.md`）：后台子代理弹审批卡「没有人可问」——子会话不进侧边栏、受阻子代理与正常子代理无法区分；因此「把审批提示从它的世界里移除」，ask 一律确定性拒绝。
- **OS 级文件效应沙箱**（`docs/subsystems/sandbox.md`）：`read-only / workspace-write / danger-full-access` 三档，只管文件效应；平台后端 Linux bwrap/Landlock、macOS Seatbelt、Windows ACL restricted-token；per-call 解析、schema 默认 fail-safe read-only；无可用 runner 报 `SANDBOX_UNAVAILABLE` 不裸跑；enforcement 分 full / partial（**Windows 标 partial**：硬链接别名绕过、读不受 ACL 限制——dsh 自己诚实标注）。
- **escalation 阶梯**（`packages/sandbox/sandbox/src/escalation.ts`）：被沙箱拒绝的 bash/fs 可带 justification 做一次严格更宽的重试并走审批；子代理因 pin never 一律拒绝。
- **免责**（dsh `SAFETY.md`）：沙箱/审批/权限只是减险手段，不构成隔离保证，不要作为唯一安全控制。

### 1.3 问题

子代理无法执行命令，探测类任务（跑测试、`git log`、查版本、错峰验证）只能由主会话串行做或靠「读文件耗时间」伪装。dsh 的经验是：**命令执行能力不必切除，可保留 + 策略约束**——前提是文件效应有 OS 级兜底。本项目在 Windows 上的对应物是受限令牌 + ACL，纯 Win32 可做。

## 2. 目标与非目标

### 目标

1. 子代理可按策略执行 `run_command` / `background_command`，文件效应由 OS 沙箱圈定。
2. 派生边界策略快照：sandbox 模式从父会话权限档解析、随 spawn 固定，子会话内不可放宽（含孙代理——快照向下传递不放宽）。
3. fail-closed：沙箱不可用即拒绝执行并在工具结果中说明，绝不静默裸跑。
4. 执行与拒绝落操作留痕（命令输出不落盘，既有原则）；子代理提示如实声明边界。
5. Windows-only（本项目目标平台）；复用 `golang.org/x/sys/windows`（go.mod 已有，0 新依赖）。
6. 每阶段独立提交、独立验证、独立回滚。

### 非目标（明确排除）

- **不做子代理审批链路**：永不弹卡（dsh pin never 同款）；escalation 仅主会话可用。
- **不改主会话命令链路**：审批 / 分类器 / timeout 语义不动；主会话是否也接沙箱列为可选延伸（§6）。
- **不承诺隔离保证**：对齐 dsh SAFETY.md 的定位——沙箱是「误操作兜底」而非「对抗性防御」；本项目无浏览器级多进程边界，威胁模型是模型失误与提示注入的**后果收敛**，不是拦截决心坚定的攻击者。
- 不做 macOS/Linux；不做 additionalWritableRoots 用户配置（v1 不暴露）。

## 3. 设计

### 3.1 策略词表与派生映射

- `SandboxMode = read-only | workspace-write | danger-full-access`（词表对齐 dsh，便于文档与心智互认）。
- 父权限档 → 子代理 sandbox 快照（spawn 时解析并冻结到 `sub.policy`）：

| 父档 | 子代理 sandbox | 理由 |
| --- | --- | --- |
| read | read-only | 只读契约原样下传 |
| edit | read-only | edit 档的写审批依赖「人在场」，子代理没有审批通道，所以不给写盘 |
| auto | workspace-write | auto 契约即非风险自主执行；写效应圈定在运行 cwd + 系统临时目录 |
| full | danger-full-access | 继承父的完全权限（父已自担风险，§6 未决项之一） |

- 写效应根 v1 固定为：运行 cwd（PrepareRun 临时副本目录）+ 系统临时目录。读范围不受沙箱限制（对齐 dsh：沙箱只管写效应；读边界由既有权限档与 read-roots 体系管——但子代理读工具的既有边界不变，本方案只新增命令通道）。
- `background_command` 在 sandbox 模式下同样放行；后台 job 生命周期挂在子代理上，子代理终止即 kill job（对齐 Job Object kill-on-close）。

### 3.2 Windows enforcement（Go 侧）

- 新文件 `sandbox_windows.go`（+ `sandbox_test.go`；按仓库惯例平台差异成对出现，本方案 Windows-only 暂无 `sandbox_other.go`，若后续要编译护栏再补空实现）：
  - `CreateRestrictedToken`：deny-only SID（禁 Everyone / Users 写权）+ 低完整性级别（Low IL），禁 `SE_ASSIGNPRIMARYTOKEN` 等敏感特权；
  - Job Object：`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，子代理终止时连带杀全进程树（补 `RunStop` 的树杀缺口）；
  - 每次调用的临时可写目录：ACL 仅授受限令牌与当前用户写权，进程结束后清理（复用 PrepareRun 的清理路径）；
  - 桌面 / 窗口站隔离 v1 不做（写明 partial）。
- `RunExec` 增加 sandbox 参数（mode + writableRoots），命令在受限令牌 + Job 内启动；stdin / GBK 解码 / PATH 前置等既有行为不变。
- 失败分类：令牌创建或 ACL 设置失败 → `SANDBOX_UNAVAILABLE`，工具结果明确报「沙箱不可用，命令未执行」——fail-closed，不降级裸跑（对齐 dsh）。
- **enforcement 诚实标注 partial**（对齐 dsh `sandbox-local` README 的自述）：硬链接别名可绕过 deny-only SID、读不受 ACL 限制。文档与提示都不夸大。

### 3.3 派生边界与前端

- `spawn_agent` 时解析并冻结 `sub.policy = {sandboxMode}`；`subToolsForScope` 按 policy 挂载 `run_command`（read-only / workspace-write / danger-full-access 都挂，沙箱在 Go 侧管效应）与 `background_command`；孙代理继承父快的快照不放宽（`sub.policy` 原样传给下一层 spawn）。
- 子代理系统提示同步更新：「你可执行命令，文件效应被沙箱圈定在 <mode>；沙箱拒绝的命令不要重试，在结论中说明」。
- 拒绝文案复用现有确定性拒绝分支的形状（2026-11-15 已落），新增两类：`sandbox-denied`（OS 层拒绝）与 `sandbox-unavailable`；留痕 `ai.tool` status 对应。
- 子代理详情视图（HUD）显示当前 policy（`sandbox: workspace-write`）。

### 3.4 审计

- 执行：`logActivity('ai.tool', name, {status, ms, depth})`——沿用主会话「不记命令输出正文」的口径，命令行参数照主会话审批展示口径截 120 字。
- 沙箱拒绝与不可用单独 status，设置页操作记录可筛。

## 4. 阶段划分（每阶段独立提交）

1. **阶段 A（Go 沙箱执行器）**：`sandbox_windows.go` + 表驱动测试（令牌创建、ACL、Job、fail-closed）；不含前端，可先合入待用。集成测试覆盖：受限进程写可写根成功 / 写工作区外失败 / Job 连带杀树。
2. **阶段 B（RunExec 接线）**：`RunExec` 增加 sandbox 参数，`run_command` 工具透传（主会话 v1 不启用沙箱，仅打通管道，零行为变化）。
3. **阶段 C（子代理挂载）**：策略快照解析 + `subToolsForScope` 挂载 + 提示 / 拒绝文案 / 留痕 / HUD 展示；本方案的行为主体。
4. **阶段 D（收尾）**：设置页权限档说明补「子代理命令与沙箱」小节、README/CHANGELOG、（可选）主会话 auto 档接入评估（§6）。

## 5. 风险与代价

- **工程量**：Go 侧 1000–1500 行 + Windows 集成测试，数周级（dsh 光 Windows 后端就单独立项：`.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md`）。
- **维护坑**：UNC / 网络盘路径、符号链接、硬链接别名（dsh 标 partial 的直接原因）、受限令牌下部分工具链跑不起来（需要 UAC 提权的安装器、写用户配置目录的工具）——预期「能跑的命令子集」要靠实测收敛并写进文档。
- **性能**：每次调用多一次令牌创建 + temp 目录准备，毫秒级，可感知但可接受。
- **安全边界（必须如实宣传）**：子代理日常 web_fetch / 读外部内容，命令通道对提示注入**可达**——沙箱收敛的是文件效应后果（写不出工作区与 temp、杀得出进程树），网络效应与读效应不在其内。read-only 快照下命令依然能联网、能读用户目录（对齐 dsh 的 partial 现实）。
- **体积**：0 新依赖（`golang.org/x/sys/windows` 已是直接依赖）；代码体量按红线另计。

## 6. 未决问题（拍板后开工）

1. **full → danger-full-access 是否放行**：父已是完全权限时子代理继承裸命令，还是保守映射为 workspace-write + 提示差异？（dsh 选择继承宽身份；本项目倾向继承，但先问）
2. **沙箱不可用的兜底**：仅报错（推荐，fail-closed），还是允许「显式降级 + 每次审批」？（后者与「子代理永不弹卡」矛盾，除非降级提示走主会话确认——复杂度不值）
3. **主会话命令是否同样接入沙箱**：对齐 dsh 的完整形态是「所有 agent 的命令都走沙箱」（auto 档收益最大——自动执行的命令多一层兜底）；代价是主会话命令行为的兼容性回归面。建议阶段 D 单独评估。
4. **命令族白名单是否还要**：沙箱管效应后，端侧分类器对子代理命令是否仍有价值（如拦网络类命令）？v1 倾向不加——效应兜底已够，分类器是启发式不是边界，叠两层反而模糊责任。
