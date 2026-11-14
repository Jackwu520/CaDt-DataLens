# 端侧命令分类器（内置线性模型 + 市场语义插件）

状态：**方案评估完成，未开工**。作者拍板的方向已固化为本文档的「已定决策」。

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

## 5. 严格度设计

| 档位 | allow 阈值 T（危险概率） | 行为倾向 |
|---|---|---|
| 宽松 | 0.30 | 更多命令自动放行，误放风险最高 |
| 标准（默认） | 0.15 | 平衡 |
| 严格 | 0.07 | 稍有嫌疑即转人工 |

- 配置字段（`ai-config.json`，前端 blob + normalize + 表驱动测试，沿 `normalizeDefaultScope` 先例）：
  - `localClassifierEnabled: boolean`（默认 `false`）
  - `localClassifierStrictness: 'loose' | 'standard' | 'strict'`（默认 `'standard'`，非法值回退 standard）
- 阈值常量集中在一处（`ai-permissions.js` 导出），测试覆盖三档对同一 score 的判定差异。
- UI：权限页「高级配置」新增「端侧分类器」区——开关、严格度三档、分类器状态（内置模型 / 已安装插件列表 + 最近判定）、一条**测试输入框**（贴命令即看 score 与判定，不产生审批记录）。

## 6. 方案 A：内置线性分类器

- **特征**：命令小写化 → 字符 3-gram / 5-gram 哈希到 8192 维 + 结构桶（首词、子命令、管道 `| sh`、重定向、路径指示符）。
- **模型**：逻辑回归单层，权重 **int8 量化**（scale + offset 存储），单条推理 ≈ 1ms，权重文件预算 **≤ 200 KB**（8192 维 int8 ≈ 8 KB + 偏置 + 词表外参数，实际以训练产出为准）。
- **语料与训练**（可复现入库）：
  - `scripts/classifier-corpus.mjs`：合成语料生成器——安全 ~250 条（git status/log/diff、ls、cat、head/tail、node -v、pip list、grep、find -name…）、危险 ~250 条（rm -rf/-fr 变体、del /f /s、rmdir /s、dd、mkfs、format、reg add、`curl | sh`、`wget | bash`、powershell -enc、taskkill /f、shutdown、磁盘设备写入…）、灰色 ~80 条（install / push / kill 等改环境类，标高险 → ask）；
  - `scripts/train-local-classifier.mjs`：Node 内 SGD 训练 + 留出验证集（输出准确率 / 危险召回 / 误放率指标）+ int8 量化导出 → `frontend/src/ai/local-classifier-weights.mjs`；
  - 验证子集固化进单测（`ai-local-classifier.test.mjs`）：高危样本 score ≥ 0.5、安全样本 ≤ 0.1、三档阈值判定表驱动。
- **文件清单**：`src/ai/ai-local-classifier.js`（推理 + 阈值判定）、`local-classifier-weights.mjs`（量化权重）、`ai-local-classifier.test.mjs`、`scripts/classifier-corpus.mjs`、`scripts/train-local-classifier.mjs`。

## 7. 方案 B：市场语义插件包（二期）

- **形态**：仓库 `plugins/command-classifier-onnx/`（或独立 Gitee 仓库）——`plugin.json`（`minAppVersion` 锁定引入 `registerCommandClassifier` 的版本）+ 入口 JS + `readAsset` 加载的 ONNX 模型资产；市场发布 = 推到 Gitee org 仓库。
- **候选模型**：多语言 MiniLM int8 / gte-small int8 / bge-micro 量级（20–90 MB，下载者承担）。
- **开放点（实施前需验证）**：
  1. onnxruntime-web 进入插件的路径：a) 插件资产 data URL → blob URL 动态加载；b) 市场包内嵌精简运行时。需在 WebView2 验证 CSP 与 wasm 加载限制；
  2. 推理必须 Worker 化（插件当前跑主线程，0.1–1s 推理会卡 UI）——插件系统是否提供 Worker 帮助 API 待定，否则插件自建 Worker（blob URL）；
  3. 模型下载策略：市场包直带（仓库体积大）vs 首启按需下载到插件目录（需校验哈希）。
- 首期交付：插件骨架 + `registerCommandClassifier` 接线演示（用线性打分模拟）+ README 与上架指引，推理部分标注「二期」。

## 8. 决策链接线（M1）

`approveCommandForRun()` 的 `decision === 'classify'` 分支内、远程调用之前：

1. 收集启用的分类器：内置模型（`localClassifierEnabled`）+ `getPluginClassifiers()` 注册项；
2. 逐个 `classify`（独立 try/catch + 失败计数）；无可用分类器 → 维持现状（远程分类器若开则走远程，否则 ask）；
3. 合并 `max(score)`：`< T` → allow，`logPermission('command', command, 'allow', 'local-classifier', reason)`，审批卡来源显示「端侧分类器」；`≥ T` → ask，确认卡附分类器提示；
4. 端侧判险（ask）不再消耗远程分类器调用；远程分类器仅在端侧未启用时生效（两者独立开关，链路顺序固定：端侧先行）。
5. `decidePermission()` 保持纯函数不动——严格度阈值判定在执行层完成，避免污染纯函数签名。

## 9. 安全边界

- 端侧模型**无 deny 权**；项目 deny、危险命令、用户裁定完全不受影响；
- 默认关闭；开启后所有判定进权限记录（来源、score、reason），可审计；
- 分类器异常 / 低置信一律转人工（fail-open 到 ask，fail-closed 到规则）；
- 权重文件随版本更新需重跑回归集（训练脚本入库保证可复现）。

## 10. 实施步骤

- **M1（核心，约 1 天）**：`registerCommandClassifier` 插件 API + 内置线性分类器（语料 / 训练 / 量化 / 单测）+ 决策链接线 + 严格度配置与设置 UI + mock 场景浏览器冒烟（模拟审批链看来源标注与三档分布）。
- **M2（插件包，约半天）**：B 插件骨架（manifest / 入口 / readAsset 加载演示 / README）+ 上架指引；作者推 Gitee org。
- **M3（二期）**：B 的 ONNX 推理落地（运行时加载验证、Worker 化、模型选型实测）。

## 11. 验收清单

1. 默认关闭时，审批行为与现状逐字节一致（决策链无新增调用）；
2. 三档严格度对同一批命令的 allow / ask 分布符合阈值表（单测固化）；
3. `rm -rf` 类必 ask；`git status` 类在自动审批档直接 allow 且来源标注「端侧分类器（score）」；
4. 插件分类器抛异常不影响审批链（跳过继续；连续失败自动停用）；
5. 危险命令 / 项目 deny 完全不受分类器影响；
6. 核心前端 bundle 增量 ≤ 30 KB（代码），权重文件 ≤ 200 KB；
7. 权限页测试框可即时看 score 与判定，不产生审批记录；
8. mock 场景浏览器实测审批卡来源显示与三档切换。

## 12. 开放问题

1. 严格度是否追加「自定义阈值」高级滑杆（首期只做三档）；
2. 端侧放行后是否允许再跑远程分类器做双保险（首期：不跑，顺序互斥）；
3. B 插件模型分发：市场包直带 vs 首启按需下载 + 哈希校验；
4. 训练语料的持续扩充机制（用户反馈误判样本回流？涉及隐私，需单独评估）。
