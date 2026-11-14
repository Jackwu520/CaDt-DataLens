# 命令语义分类器（ONNX）插件

**二期（真实 ONNX 推理）已发布**：完整实现与模型载荷在插件市场仓库 [cadt-datalens-plugins/command-classifier-onnx](https://gitee.com/cadt-datalens-plugins/command-classifier-onnx)（MiniLM int8 22MB + 逻辑回归头 + Worker 离线推理）。本目录保留**一期接线演示**（词表打分 + readAsset 演示），用于理解 `registerCommandClassifier` 契约的最小可用形态。

端侧命令风险分类器（方案 B，[docs/unfinished-plans/local-command-classifier.md](../../../../docs/unfinished-plans/local-command-classifier.md) §8）：向自动审批链注册一个语义级分类器，与内置线性分类器（方案 A）**保守合并取最高分**——任一分类器判险即转人工，`deny` 权永远不下放给模型。

## 当前状态：一期（接线演示）

- ✅ `cadt.registerCommandClassifier` 接线：词表打分模拟语义模型的接口形态（`{score, reason}`）
- ✅ `cadt.readAsset('model/manifest.json')` 模型元数据加载演示（工具(U) → 端侧分类器（ONNX）状态 可查看）
- ⏳ 二期：`model/` 目录放真实 ONNX 权重（多语言 MiniLM / gte-small int8 量级，20–90 MB，下载者承担体积），readAsset → Blob URL → onnxruntime-web → **Worker 化推理**（避免 0.1–1s 推理卡 UI）

## 本地测试

1. 应用版本需含 `registerCommandClassifier` API（插件清单 minAppVersion 已按 1.0.0 标注）。
2. 设置 → 插件 → 添加/导入 本目录（或把目录复制到 `<exe 目录>\plugins\command-classifier-onnx\`）。
3. 设置 → AI 助手 → 权限 → 高级配置：启用「端侧分类器」，状态行应显示「插件：语义分类器（ONNX）」。
4. 「测试命令」输入 `rm -rf /tmp/x`：来源应显示「语义分类器（ONNX）」、score≈0.9 → 转人工；输入 `git status`：score=0 → 放行（由内置模型判定）。
5. 工具(U) → 端侧分类器（ONNX）状态：查看 readAsset 模型元数据加载结果。

## 分类器契约

```js
cadt.registerCommandClassifier({
    id: 'onnx-semantics',                    // 插件内唯一，^[a-z0-9][a-z0-9-]{0,63}$
    label: '语义分类器（ONNX）',              // 审批卡 / 权限记录显示
    classify(command, ctx) {                  // 可返回 Promise；ctx = {cwd, toolName, strictness, threshold, sessionId}
        return {score: 0.02, reason: '只读查询'};   // score = 危险概率 [0,1]，无 deny 权
    },
});
```

- 判定统一由核心按严格度阈值（宽松 0.30 / 标准 0.15 / 严格 0.07）完成，`score ≥ T` 一律转人工；
- 多个启用的分类器全部执行、取 `max(score)`；任一分类器抛异常跳过继续，连续 5 次失败本会话熔断。

## 上架指引（插件市场）

市场 = Gitee 组织 [`cadt-datalens-plugins`](https://gitee.com/cadt-datalens-plugins) 的公开仓库，应用「设置 → 插件 → 插件市场」直接列出组织下每个仓库（仓库根 `plugin.json` 提供元数据）。

1. 在组织下建仓库 `command-classifier-onnx`（公开；仓库名建议与 `id` 一致）。
2. 推送本目录内容到仓库根：`plugin.json` + `main.js` + `model/` + README（市场直接读根清单，不要包一层子目录）。
3. `plugin.json` 里 `minAppVersion` 标注 `1.0.0`（作者拍板的最低应用版本；API 实际随哪一版发布以发版为准）。
4. 二期发布 ONNX 权重时：权重直接进仓库（`model/*.onnx`，Git LFS 可选）或 README 指引首启按需下载 + 哈希校验（开放问题，见方案 §13）。
5. 推送后应用市场列表自动出现（Gitee API v5 org repos），无需登记。

## 安全说明

分类器只产出危险概率，没有 deny 权；项目规则、危险命令门与用户裁定完全不受影响。分类器抛异常会被跳过并计数熔断，不会阻塞审批链。
