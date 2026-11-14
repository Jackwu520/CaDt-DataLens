# 端侧命令分类器（内置线性模型 + 市场语义插件）

状态：**M1（核心）、M2（插件骨架）、M3（ONNX 推理）均已实施（2026-11-14）**。实施落定项见 §6/§8/§11 的「实施落定」注记；M3 的市场仓库：[cadt-datalens-plugins/command-classifier-onnx](https://gitee.com/cadt-datalens-plugins/command-classifier-onnx)。

## 1. 背景与目标

自动审批档下，规则与命令族都没接住的命令目前只有两条路：逐次询问，或（用户显式开启时）**远程 AI 分类器**判定。远程分类器有网络延迟、依赖配置的模型账号。

目标：增加一层**端侧（本机、离线）命令分类器**——

- **方案 A（内置）**：KB 级线性分类器直接内置于核心前端，零依赖、毫秒级推理，装完即用；
- **方案 B（市场插件）**：ONNX 语义级小模型以插件包形式发布在插件市场，用户自愿下载（体积由下载者承担，核心 exe 零增量）；
- **严格度可调**：用户可设「宽松 / 标准 / 严格」三档，控制端侧分类器放行的置信阈值。

## 2. 已定决策（作者拍板）

| 决策点 | 结论 |
|---|---|
| 方案 A（线性模型） | **内置核心**，不作为插件 |
| 方案 B（ONNX 语义模型） | **以插件包形式发布在插件市场** |
| 严格度 | 可调，三档（宽松 / 标准 / 严格），两类分类器共用同一阈值语义 |
| deny 权 | **不下放**——端侧模型只输出 allow / ask（转人工），deny 永远留给项目规则与用户 |
| 默认开关 | 默认**关闭**，权限页显式开启（与远程 AI 分类器同一保守基调） |
| 个性化后训练 | **支持**（方案 A 扩展，见 §7）：可选开关（默认关）、重置分类器、清空学习数据、导出分类器数据 |
| 发布 | 插件发布物 + 上架指引由本项目准备；推 Gitee org 仓库由作者操作 |

## 3. 现状事实（已核实）

- 决策链：`decidePermission()`（`src/ai/ai-permissions.js`，纯函数）——项目 deny → 危险命令（转人工）→ 项目 ask → 会话 allow → 项目 allow → 完全权限 → 写入分支 → 只读命令 → 已知命令族 → **classify**（自动审批 + 分类器开）→ 逐次询问。
- 分类器执行点：`approveCommandForRun()`（`src/ai/ai-panel.js`）中 `decision === 'classify'` 分支 → `classifyCommandForAuto()`（远程模型，串行队列 + 10 分钟缓存）。端侧分类器在此分支**前置**，是最小侵入的接入点。
- 插件系统（`frontend/src/plugins.js` + `plugins.go`）：插件 = 文件夹（`plugin.json` + JS 入口），WebView 内以 `new Function('cadt', code)` 执行；现有挂点 `registerFormat` / `addCommand` / `registerIconTheme` / `addTheme`；**`readAsset(path)` 可读插件目录内资产**（返回 data URL）——B 插件自带模型文件有路可走；插件市场 = Gitee org（`cadt-datalens-plugins`）下每插件一个仓库，清单含 `minAppVersion`，发布即建仓库。
- 体积约束（AGENTS.md）：不打包新运行时；核心 exe 对本功能的增量预算 **≤ 30 KB 代码**，模型/运行时重量全部由市场插件包承担。

## 4. 统一分类器契约（核心设计）

端侧分类器**只输出危险概率**，allow/ask 判定统一由核心按严格度阈值做出——内置模型与市场插件共用同一语义，严格度才能一处生效：

```js
// 插件 API 扩展（M1）
cadt.registerCommandClassifier({
    id: 'onnx-semantics',            // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: '语义分类器（ONNX）',      // 审批卡/权限记录里显示
    classify(command, ctx) {          // 可返回 Promise
        // ctx: {cwd, toolName, strictness, threshold, sessionId}
        return {score: 0.02, reason: '只读查询'};   // score = 危险概率 [0,1]
    },
});
```

- 校验规则沿用现有插件 API 风格：id 格式、`classify` 必须为函数、重复注册抛错；`loadPlugins` 重载时清空重注册（与 commands / themeStyles 同生命周期）。
- **保守合并**：启用的多个分类器全部执行，取 `max(score)` 判定；任一分类器抛异常则跳过该分类器继续（连续 N 次[建议 5]失败自动停用本会话，避免每条命令都空等）。
- 判定：`score < T` → allow（来源标注「端侧分类器」，附 reason + score）；`score ≥ T` → **直接 ask**（附分类器提示），不再消耗远程调用。

**与远端分类器输入的对比（上下文注入考量）**：远端分类器的输入是极简自足三字段 `{command, cwd, workspace}`——不含会话任务上下文、跨轮 shell 状态、项目类型、历史裁定与 toolName（privacy-friendly、每请求 token 极小），代价是只能从命令文本本身判断。端侧 `ctx` 在此基础上多带 `toolName / strictness / threshold / sessionId`；进一步的上下文注入按方案分治：

- **方案 A（线性模型）**：吃不了自然语言长上下文，有效的注入是**结构化特征桶**——本轮已执行命令数、与前序命令的首词/目录共享度、cwd 是否在工作区内、项目类型标记（package.json / go.mod / Cargo.toml 存在 → 构建测试类命令降险）、用户历史裁定密度（个性化 delta 本身就是隐式注入）。首期先做 delta 隐式注入，结构化桶列为增强项。
- **方案 B（语义模型）**：可显式注入最近 K 条命令与任务摘要作为文本前缀——这是语义模型相对线性模型的核心增益之一，随 M3 一并设计（注意会话内容进模型上下文的隐私边界：仅命令文本与 cwd，不含对话正文）。

## 5. 严格度设计

| 档位 | allow 阈值 T（危险概率） | 行为倾向 |
|---|---|---|
| 宽松 | 0.30 | 更多命令自动放行，误放风险最高 |
| 标准（默认） | 0.15 | 平衡 |
| 严格 | 0.07 | 稍有嫌疑即转人工 |

- 配置字段（`ai-config.json`，前端 blob + normalize + 表驱动测试，沿 `normalizeDefaultScope` 先例）：
  - `localClassifierEnabled: boolean`（默认 `false`）
  - `localClassifierStrictness: 'loose' | 'standard' | 'strict'`（默认 `'standard'`，非法值回退 standard）
  - `localClassifierPersonalize: boolean`（默认 `false`，个性化后训练开关，见 §7）
- 阈值常量集中在一处（`ai-permissions.js` 导出），测试覆盖三档对同一 score 的判定差异。
- UI：权限页「高级配置」新增「端侧分类器」区——开关、严格度三档、分类器状态（内置模型 / 已安装插件列表 + 最近判定）、一条**测试输入框**（贴命令即看 score 与判定，不产生审批记录）；个性化开启后追加学习状态行（样本数 / 最近训练时间 / 权重版本）与重置、导出入口（见 §7）。

## 6. 方案 A：内置线性分类器

- **特征**：命令小写化 → 字符 3-gram / 5-gram 哈希到 8192 维 + 结构桶（首词、子命令、管道 `| sh`、重定向、路径指示符）。
- **模型**：逻辑回归单层，权重 **int8 量化**（scale + offset 存储），单条推理 ≈ 1ms，权重文件预算 **≤ 200 KB**（8192 维 int8 ≈ 8 KB + 偏置 + 词表外参数，实际以训练产出为准）。
- **语料与训练**（可复现入库）：
  - `scripts/classifier-corpus.mjs`：合成语料生成器——安全 ~250 条（git status/log/diff、ls、cat、head/tail、node -v、pip list、grep、find -name…）、危险 ~250 条（rm -rf/-fr 变体、del /f /s、rmdir /s、dd、mkfs、format、reg add、`curl | sh`、`wget | bash`、powershell -enc、taskkill /f、shutdown、磁盘设备写入…）、灰色 ~80 条（install / push / kill 等改环境类，标高险 → ask）；
  - **模板参数化生成**（非死样本）：路径/参数/flag 顺序/大小写/引号风格随机化、`cd x &&` 前缀与 `| tee` 后缀扰动；训练/验证按固定种子 80/20 切分，**验证集用不同随机源的未见变体**（测泛化不测背诵）；
  - `scripts/train-local-classifier.mjs`：纯 Node SGD（零依赖，~80 行）——30 epoch、lr 0.1 起步 ×0.85/epoch 衰减、单样本梯度 `g = p − y`、L2 正则拉向 0；
  - **调参硬指标是误放率 ≈ 0**（fail-closed：宁可误拦不可误放），其次危险召回 ≥ 0.97、准确率仅作参考——三档严格度阈值 T 实质是验证集 ROC 上的三个工作点；
  - **int8 量化导出**：`scale = max|w|/127`。实施落定：采用**密集 int8 → base64** 存储（8192 维 ≈ 11.8 KB，比稀疏文本更小且解析更快）+ 特征配置（n-gram 长度、哈希种子、维度数）随权重文件存储，保证训练/推理对齐（训练脚本直接 import 前端同一特征实现）→ `frontend/src/ai/local-classifier-weights.mjs`（生成产物，勿手改，懒加载独立 chunk）；
  - 验证子集固化进单测（`ai-local-classifier.test.mjs`）：危险金丝雀 ≥0.5 且宽松档必拦、安全金丝雀标准档放行、灰色标准档转人工、三档阈值判定表驱动；
  - **已知弱点与自愈**：`echo "rm -rf …"` 类引用文本会误报险（线性 n-gram 无法理解引用语义）→ 转人工后用户批准，个性化 SGD 将首词 echo 相关维度拉向安全（§7），基线保下限、个性化补真实分布；
  - **公开语料盘点（调研结论）**：无语义对齐的现成训练集，可作参考不可直接训练——
    - 正常侧：Schonlau/SEA 数据集（50+ 用户 UNIX 命令序列，masquerade 检测经典基准）只有裸命令名、标签是会话级冒充；GitHub dotfiles / shell history 集合同样只有正常侧 → 用于**扩充生成器模板词表**；
    - 危险侧：malbash（恶意 bash 脚本语料）、ShellCore 论文的 IoT 命令类目学、Cowrie 蜜罐攻击者命令序列 → 用于**查漏危险模式清单**；
    - Agent 安全基准（R-Judge / Agent Security Bench / AgentHarm）：标签语义最近但标注单位是交互记录而非单条命令，且为评测基准（训练用途许可存疑）、分布偏注入攻击；
    - **根因**：我们的标签是「策略性 auto-approve 判定」（只读/幂等/不写盘，`git push --force` 良性但必须 ask），与「恶意/良性」语义不同构——训练集必须自建；公开语料的正确用法是当词表与模式清单参考。真正的策略对齐语料来自 §7 个性化回路（用户裁定 = 最正确的标签源）。
    - **实测 eval（2026-11-14，`scripts/eval-public-corpus.mjs`，只评不训）**：SEA 50 用户 856 条唯一裸命令——宽松档放行 82.5%、标准档 13.3%；标准档被打扰的高分词与策略灰色动词（mkdir/chmod/killall/install）高度重合（无参数裸动词按策略本就该转人工），剩余为未知词保守（fail-closed 方向正确）。Cowrie 蜜罐真实攻击流量中位 score 1.0，破坏性子集三档 100% 拦截；malbash 恶意脚本的三档 100% 拦截，且数据外泄类 `curl -F f=@file`（不在参照规则集内）模型独立判险 0.99+。eval 还反哺了两处语料修正：`ls 2>/dev/null`（0.94→0.014，良性惯用法被裸设备词面拉高）与 `cat README.md`（文件名词面被危险侧共享稀释，词表按只读/中性/受害者三表分离）；金丝雀清单随之固化进训练门槛（`CANARIES` 导出，训练器与单测同一份）。
    - **Windows 侧配平（同日，eval 驱动）**：初始语料 Linux 特征 37% vs Windows 27%——对 Windows 优先的应用失衡；eval 数据集补入 LOLBAS（Windows 白利用命令库）与恶意 PowerShell（MalwareBazaar 抽样）两个 Windows 源，驱动语料 Windows 占比提至 41%：新增 `reg query`/`Get-Service`/`Test-Path`/`Select-String`/`Get-WinEvent`/`netstat` 等只读模板与 `IEX`/`rundll32`/`regsvr32`/`mshta`/`certutil -urlcache`/`bitsadmin`/`wevtutil cl`/`fsutil`/`netsh advfirewall`/`New-Service`/`Start-Process -Verb RunAs`/`Set-ExecutionPolicy`/`robocopy /MIR` 等危险/灰色模板。配平后（权重 v4）：LOLBAS 破坏性 76 条三档拦截 100/100/100%，恶意 PowerShell 26 条拦截 96.2/100/100%（配平前 84.6/100/100）。语义头同步训练（灰/安交替强化阶段压住「语义良性但策略转人工」的灰色族，如 `export PATH=`/`apt install`），三档误放 0、安全标准档放行 94.1%。
- **文件清单（实施落定）**：`src/ai/ai-local-classifier.js`（特征化/推理/阈值判定/SGD/运行时工厂）、`local-classifier-weights.mjs`（量化权重，生成产物）、`ai-local-classifier.test.mjs`、`scripts/classifier-corpus.mjs`（模板参数化语料，训练 930 / 验证 576 条）、`scripts/train-local-classifier.mjs`（SGD 60 epoch + int8 量化 + 硬指标门槛，不达标拒绝产出）。

## 7. 个性化后训练（方案 A 扩展，M1）

线性模型天然适合端侧在线学习：逻辑回归的单样本 SGD 更新就是一行算式（`w += lr·(y−σ(w·x))·x`），无反向传播框架、单样本 ≈1ms、全量权重仅 32KB——**个性化不引入任何新依赖**。

### 7.1 训练信号（显式、知情、干净）

- 来源：**分类器转人工的审批卡**。端侧分类器判 ask（score ≥ T）后，用户点「批准」→ 样本 `(command, y=0)`（用户认为安全）；点「拒绝」→ `(command, y=1)`（危险）。
- AI / 自动裁定、规则放行、会话授权等**不回流**——只学习用户的显式裁定，避免噪声标签。
- 样本命令文本沿用 activity-log 同款**脱敏 sanitizer** 后落盘，不存密钥与敏感参数。

### 7.2 学习与存储

- **SGD + L2 锚定出厂权重**：更新式带正则项 `λ·(w − w_factory)`，个性化被约束为出厂附近的**有界稀疏 delta**（只存被触碰过的维度，几十 KB），从机制上防止漂移失控。
- 存储（appdata AI 目录 `local-classifier/`，走后端通用 `SaveFile` / `ReadFile`，**零 Go 改动**）：
  - `weights.json`：`{factoryVersion, delta: {维度: 修正量}, trainedAt, sampleCount}`；
  - `samples.jsonl`：追加式脱敏样本（环形上限 500，超出淘汰最旧），与 sessionstore 同款追加式先例。
- **出厂版本升级**：`factoryVersion` 不匹配 → delta 自动重置、样本保留（个性化开关开着时自动重训一轮）；训练脚本入库保证工厂权重与语料可复现。

### 7.3 用户操作面

| 操作 | 行为 |
|---|---|
| 个性化开关 | 默认关；开启后开始从审批卡裁定学习 |
| 重置分类器 | delta 丢弃 → 秒回出厂权重（样本保留，可重训） |
| 清空学习数据 | 删 `samples.jsonl` + delta（彻底回到出厂态） |
| 导出分类器数据 | JSON（factoryVersion + delta + 脱敏样本 + 统计）下载到用户选的路径；**导入**列为开放问题（引入他人权重 = 信任其安全判断，暂不支持） |

- 学习状态行（开关开启时显示）：样本数 / 最近训练时间 / delta 规模 / 出厂版本。
- 批量重训在空闲时执行（`requestIdleCallback`）或样本每新增 20 条触发，单样本更新则实时。

### 7.4 防漂移护栏

1. 危险命令门在决策链**上游**（`decidePermission` 的 dangerous 分支），个性化绕不过；
2. 严格度阈值 T 与个性化**独立**——个性化改变模型输出 p，T 不变（两个独立旋钮）；
3. 学习率小 + 正则锚定出厂 + 单命令至多 1 次更新；
4. 样本环形上限 500，防止历史包袱无限增长；
5. 重置/清空一键可回滚，导出保证用户对自己的数据完全可控。

### 7.5 与方案 B 的关系

个性化仅方案 A（线性模型可在线学习）。B（ONNX transformer）端侧微调在浏览器内不现实，后续可另议检索增强（把用户历史裁定作为 few-shot 上下文），不在本文档范围。

### 7.6 期望管理

用户反馈天然稀疏——个性化收益集中在**用户高频复用的命令族**（n-gram 特征在族内泛化良好，例如用户总批准某类构建命令，相似变体逐步免打扰）；对一次性陌生命令帮助有限，兜底仍是转人工。

## 8. 方案 B：市场语义插件包（二期）

- **形态**：仓库 `plugins/command-classifier-onnx/`（或独立 Gitee 仓库）——`plugin.json`（`minAppVersion` 锁定引入 `registerCommandClassifier` 的版本）+ 入口 JS + `readAsset` 加载的 ONNX 模型资产；市场发布 = 推到 Gitee org 仓库。
- **候选模型**：多语言 MiniLM int8 / gte-small int8 / bge-micro 量级（20–90 MB，下载者承担）。
- **开放点（实施前需验证）**：
  1. onnxruntime-web 进入插件的路径：a) 插件资产 data URL → blob URL 动态加载；b) 市场包内嵌精简运行时。需在 WebView2 验证 CSP 与 wasm 加载限制；
  2. 推理必须 Worker 化（插件当前跑主线程，0.1–1s 推理会卡 UI）——插件系统是否提供 Worker 帮助 API 待定，否则插件自建 Worker（blob URL）；
  3. 模型下载策略：市场包直带（仓库体积大）vs 首启按需下载到插件目录（需校验哈希）。
- 首期交付：插件骨架 + `registerCommandClassifier` 接线演示（用线性打分模拟）+ README 与上架指引，推理部分标注「二期」。
- **实施落定（2026-11-14）**：骨架在 `docs/plugins/examples/command-classifier-onnx/`（`/plugins/` 目录被 .gitignore 排除，样例走 docs/examples）；词表打分演示 + `readAsset('model/manifest.json')` 元数据加载演示 + 状态命令；上架指引（Gitee org 仓库根 `plugin.json`）写入其 README 与 `docs/plugins/README.md`（含 `registerCommandClassifier` API 文档与市场发布章节）。

## 9. 决策链接线（M1）

`approveCommandForRun()` 的 `decision === 'classify'` 分支内、远程调用之前：

1. 收集启用的分类器：内置模型（`localClassifierEnabled`）+ `getPluginClassifiers()` 注册项；
2. 逐个 `classify`（独立 try/catch + 失败计数）；无可用分类器 → 维持现状（远程分类器若开则走远程，否则 ask）；
3. 合并 `max(score)`：`< T` → allow，`logPermission('command', command, 'allow', 'local-classifier', reason)`，审批卡来源显示「端侧分类器」；`≥ T` → ask，确认卡附分类器提示；
4. 端侧判险（ask）不再消耗远程分类器调用；远程分类器仅在端侧未启用时生效（两者独立开关，链路顺序固定：端侧先行）。
5. **个性化回流钩子**：分类器转人工的命令经用户批准 / 拒绝后，若 `localClassifierPersonalize` 开启，投喂一条样本（脱敏后写入 samples.jsonl + 单样本 SGD 更新）；钩子在 `persistApprovalMutation` 附近，与权限记录同源。
6. `decidePermission()` 保持纯函数不动——严格度阈值判定在执行层完成，避免污染纯函数签名。

## 10. 安全边界

- 端侧模型**无 deny 权**；项目 deny、危险命令、用户裁定完全不受影响；
- 默认关闭；开启后所有判定进权限记录（来源、score、reason），可审计；
- 分类器异常 / 低置信一律转人工（fail-open 到 ask，fail-closed 到规则）；
- 权重文件随版本更新需重跑回归集（训练脚本入库保证可复现）；
- 个性化数据全部本地（appdata），导出须经用户显式操作；样本脱敏后才落盘。

## 11. 实施步骤

- **M1（核心，约 1.5 天）**：`registerCommandClassifier` 插件 API + 内置线性分类器（语料 / 训练 / 量化 / 单测）+ 决策链接线 + 严格度配置与设置 UI + **个性化后训练（SGD 更新 / 重置 / 清空 / 导出 / 状态行）** + mock 场景浏览器冒烟（模拟审批链看来源标注与三档分布、批准回流学习）。✅ 已完成（2026-11-14）：训练硬指标三档误放 0 / 安全标准档放行率 0.96；mock 冒烟覆盖三档判定、测试框、个性化回流 / 重置 / 清空 / 导出、`classifyAll` 聚合。
- **M2（插件包，约半天）**：B 插件骨架（manifest / 入口 / readAsset 加载演示 / README）+ 上架指引；作者推 Gitee org。✅ 已完成（2026-11-14，`docs/plugins/examples/command-classifier-onnx/`）。
- **M3（二期）**：B 的 ONNX 推理落地（运行时加载验证、Worker 化、模型选型实测）。✅ 已实施（2026-11-14，仓库 [cadt-datalens-plugins/command-classifier-onnx](https://gitee.com/cadt-datalens-plugins/command-classifier-onnx)）：MiniLM int8 ONNX（22MB，仓库直带）+ WordPiece（Node/浏览器同源实现）+ 逻辑回归头（语料 1620 训练 / 979 验证，标准档漏放 0、硬危险宽松档漏放 0）+ blob Worker 内 onnxruntime-web wasm 推理（fetch 垫片直传 wasm 字节，版本无关、完全离线）；浏览器探针实测 47–92ms/条，判定与 Node 侧一致；加载失败回退一期词表打分。模型选型结论：Xenova/all-MiniLM-L6-v2 int8； ort-web 1.17.3（1.20 起改用 ESM/binding 结构，1.17 + 垫片是 WebView2 离线加载的最稳组合）。

## 12. 验收清单

1. 默认关闭时，审批行为与现状逐字节一致（决策链无新增调用）；
2. 三档严格度对同一批命令的 allow / ask 分布符合阈值表（单测固化）；
3. `rm -rf` 类必 ask；`git status` 类在自动审批档直接 allow 且来源标注「端侧分类器（score）」；
4. 插件分类器抛异常不影响审批链（跳过继续；连续失败自动停用）；
5. 危险命令 / 项目 deny 完全不受分类器影响；
6. 核心前端 bundle 增量 ≤ 30 KB（代码），权重文件 ≤ 200 KB；
7. 权限页测试框可即时看 score 与判定，不产生审批记录；
8. mock 场景浏览器实测审批卡来源显示与三档切换；
9. **个性化回路**：开启后对分类器转人工命令点「批准」→ samples.jsonl 新增脱敏样本、score 变化可由测试框复现；「重置分类器」秒回出厂；「清空学习数据」后样本为零；「导出」产物含版本 + delta + 样本；
10. 关闭个性化开关后审批卡裁定不再产生样本；出厂版本号变更时 delta 自动重置、样本保留。

## 13. 开放问题

1. 严格度是否追加「自定义阈值」高级滑杆（首期只做三档）；
2. 端侧放行后是否允许再跑远程分类器做双保险（首期：不跑，顺序互斥）；
3. B 插件模型分发：市场包直带 vs 首启按需下载 + 哈希校验；
4. 训练语料的持续扩充（用户反馈回流已由 §7 个性化覆盖；**导入他人导出的分类器数据**涉及信任链，暂不支持，待评估签名机制）。
