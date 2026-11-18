# AI search 增强（已完成 2026-11-18）

> 事实底座：`docs/unfinished-plans/feature-evaluations-2026-11-18.md` §4。
> 范围按评估稿 4.4 执行：一期（regex / wholeWord / excludePattern / maxResults）+ 二期（outputMode / context）全部实施；
> 明确不做的三项（多行正则、rg flags 透传、run_command 跑 rg 当常规路径）保持未做。

## 结果

AI 的 `search_text` 从「字面量子串 + 纯行命中」升级为可表达正则、全词、文件排除、结果聚合与上下文的工具。
所有新参数在**用户装没装 rg 两条扫描路径下行为一致**——这是对本次改动的硬约束，已由双路径对拍测试钉死。

新参数（旧参数 `query / path / caseSensitive / filePattern` 语义不变）：

```js
{
  query: 'foo',                   // 字面串或正则（regex:true 时）
  excludePattern: '*.test.go',    // 排除通配，globMatchPath 语义，留空不排除
  regex: false,                   // true = 按 Go RE2 正则解释（线性时间无回溯）
  wholeWord: false,               // 词边界按字母数字与下划线判定
  context: 0,                     // 命中行前后各 N 行，0–3
  outputMode: 'content',          // content / files / count
  maxResults: 200,                // 1–1000，默认 200
}
```

实现约定（与评估稿略有收敛的两处）：

- **outputMode 两路径统一在 Go 侧聚合**（`applyOutputMode`），不是「rg 原生 `--count` / 内置聚合」分开做——
  `rg --json` 与 `--count` 输出形态冲突，分开会导致两路径结果结构漂移。rg 侧仍用 `--json` 收命中，聚合口径与内置完全一致。
- **exclude glob 放在 `rgGlobalArgs` 最后**：rg 的 glob 后者覆盖前者，放最后才能压过产物档的「包含」glob；
  内置路径在 walk 时 `globMatchPath(spec.exclude, …)` 取反整文件跳过，口径与 `--glob !x` 对齐。
- 非法正则 / 非法 outputMode 直接报错给模型，不静默降级；其余非法值（context 越界、maxResults 越界）钳到边界。
- `context` 硬限 3、`maxResults` 硬限 1000，输出末端仍保留既有「结果已截断」闸门。

输出形态：`content`（默认）仍是 `相对路径:行号: 预览`，设了 context 则每命中附 `行号- / 行号+` 前后文；
`files` 给「匹配文件（N 个）：」+ 纯路径清单；`count` 给「每文件命中数（N 个文件）：」+ `路径: 次数`。
产物档 dist/build 垫底排序、相对起点路径、artifactSkipped 提示均保留。

## Go 侧设计

新绑定 `SearchWorkspaceAdvanced(root, query, search.SearchOptions)`：8 个参数聚成一个结构（Wails 自动绑定），
避免第 8 个位置参数。App 以 `*search.Searcher` 嵌入，方法提升即绑定；根壳无需写包装函数。

旧三入口 `SearchWorkspace` / `SearchWorkspaceFiltered` / `SearchWorkspaceFuzzy` 签名不变，走 `legacySearchSpec` 零值适配——
UI 的全局搜索（fuzzy）完全不受影响。

内部统一 `searchSpec`：两路径共用同一份归一化参数，改参数口径只改一处。
- 内置路径：`scanSearchFile` / `scanSearchJobs` / `scanWorkspaceBuiltin` 改吃 spec；字面量沿用 ASCII 折叠快路径，正则走 Go `regexp`（RE2）。
- rg 路径：`rgGlobalArgs` 正则时去掉 `-F`、全词加 `-w`、上下文 `-C N`、排除放最后；`runRgPass` 收 `context` 消息按「路径 → 行号 → 原文」暂存。
- 上下文回填两处各自的坑：内置必须**先读完整个文件再匹配**（边扫边取会让后半边 context 永远空）；rg 的 `context` 消息可能排在 `match` 之后，须扫描结束后统一回填，且按 `hit.Path` 取本文件、不串文件。

## 改动文件

| 文件 | 作用 |
|------|------|
| `internal/search/search.go` | `SearchOptions` / `ContextLine` / `FileCount` 类型；`searchSpec` 归一化与匹配（字面 + RE2 正则 + 全词）；上下文回填；`applyOutputMode` 聚合；新绑定 `SearchWorkspaceAdvanced`；旧三入口零值适配 |
| `internal/search/search_rg.go` | `rgGlobalArgs` / `runRgPass` / `searchWithRipgrep` 改吃 spec；rg 的 `-w` / `-C` / 去 `-F` / 排除 glob；context 消息收集与回填 |
| `internal/search/advanced_test.go`（新） | 一期 + 二期双路径对拍：regex / wholeWord / excludePattern / regex+wholeWord / maxResults / context / files+count / 非法参数钳制；`DATALENS_NO_RG` 强制内置路径 |
| `frontend/wailsjs/`（生成，gitignored） | `wails generate module` 官方重生成：`SearchWorkspaceAdvanced` 声明 + `SearchOptions` / `ContextLine` / `FileCount` / `before` / `after` / `fileList` / `counts` |
| `frontend/src/ai/ai-tool-defs.js` | `search_text` 六个新参数的 properties + 描述（何时用正则、outputMode 的 token 语义）；目录 blurb；调度原则补「正则用 regex:true，别拼 grep」 |
| `frontend/src/ai/ai-search-advanced.js`（新） | 纯函数：参数归一化（缺省/钳制）、filePattern 前端兜底过滤（files/count/hits 三形态）、content+files+count 格式化 |
| `frontend/src/ai/ai-panel.js` | `executeTool` 的 search_text 分支走新绑定；旧后端仅接受老参数、遇高级参数明确报错；结果交给纯模块格式化 |
| `frontend/src/dev/mock-backend.js` | 补同名 `SearchWorkspaceAdvanced` mock（六参数全实现，dev 模式不崩） |
| `frontend/test/ai/ai-search-advanced.test.mjs`（新） | 5 例：归一化 / 三形态过滤 / 带上下文输出 / files+count+空结果 / 工具定义+wailsjs+mock 接线断言 |
| `frontend/package.json` | test 脚本登记新测试文件（定点编辑，保留并行会话新增的条目） |

## 验证

- `go test ./internal/search/ -v`：双路径对拍 `builtin` 与 `rg` 子测试**全部实跑通过、零 SKIP**。
  本机用 npm 镜像的 `@vscode/ripgrep-win32-x64`（内部为 ripgrep 15.0.0）临时提供 PATH，避免去撞 GitHub 下载。
- `go test ./...`：51 包全绿。中途 `internal/sessionindex` 出现过一次 build failed，系并行会话写文件撞上编译，单独重跑即过。
- `npm test`：1360/1360 通过（含 `ai-tool-wiring.test.mjs` 的「描述 token ↔ properties ↔ 分支读取」三处对齐）。
- `npx vite build --outDir <临时目录>`：通过（仅既有 chunk > 500 kB 警告）；未写入共享 `frontend/dist`。

## 后续扩展位

- 多行正则（rg `-U` + 内置跨行扫描）：评估稿明确不做，复杂度/收益比差；若要加，需在 `searchSpec` 增标志并让两路径都支持跨行窗口。
- `context` 若放开到 >3：注意前端格式化会把结果放大 N 倍，输出端截断闸要同步收紧。
- 产物档两趟扫描与新 glob 参数已有交互测试（artifactSkipped），新增类似参数时照抄 `advanced_test.go` 的双路径对拍结构。
