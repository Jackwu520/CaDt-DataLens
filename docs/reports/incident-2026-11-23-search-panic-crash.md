# 事故报告：2026-11-23 00:39–00:44 全局搜索 panic 连环闪退

- 上报时间：2026-11-23 01:10（用户报障「打开软件没一会就闪退」）
- 调查时间：2026-11-23 01:12 – 02:10
- 调查方式：只读取证（Windows 事件日志、应用会话日志 `%APPDATA%\CandySweet\CaDt-DataLens\logs\`、debug-console.jsonl、panic 堆栈与源码逐行对齐、工作区全量字节级扫描）
- 结论：**`internal/search` 内置扫描器在大小写不敏感模式下拿 `strings.ToLower` 降写副本上的命中偏移去切原行；触发文件是 `.cadt/tmp` 里 WebView2 的二进制规则文件（含非法 UTF-8 字节，ToLower 膨胀），切片越界 panic 杀掉整个进程。用户每搜一次就闪退一次。**

---

## 一、结论

| 项 | 值 |
|---|---|
| 症状 | 打开软件后做一次工作区搜索，进程无报错直接退出（「闪退」）；事件查看器无记录 |
| panic | `runtime error: slice bounds out of range [:40] with length 37`（appendHit 切原行，`internal/search/search.go`） |
| 触发动作 | 工作区全局搜索，大小写不敏感、字面量模式，5 字节查询词（`set.j`，降写串 [35,40) 命中） |
| 触发文件 | `.cadt/tmp/webview-inspect/EBWebView/Subresource Filter/Unindexed Rules/10.34.0.84/Filtering Rules`（WebView2 调试 profile 的广告过滤规则，protobuf 二进制） |
| 为什么它能进扫描 | 无扩展名 → 绕过 `searchBinaryExt` 扩展名表；前 8KB 无 NUL 字节 → 绕过 NUL 二进制预检；`.cadt/` 不在扫描跳过名单（刻意设计：探针沙箱要对 glob/list_dir 可见） |
| 崩溃会话 | 00:39:08、00:39:41（旧构建）、00:42:11（重新构建后 2 分钟再崩）——三次都是同一 panic |
| 影响 | 进程死亡，未保存状态丢失；无数据损坏（panic 在读路径） |
| 修复 | `findMatches` 长度漂移时改走原行逐 rune 折叠匹配（`foldFindFrom`）+ `appendHit` 区间收口兜底，同日落地 |

---

## 二、事故链

```text
2026-11-04  webview-inspect 调试会话把 WebView2 profile 写进 .cadt/tmp（含 Subresource Filter 二进制规则文件）
      ↓ 从此工作区里躺着一颗「毒文件」：无扩展名、前 8KB 无 NUL、行内混着非法 UTF-8 字节
2026-11-18  code-bug-hunt 修复 sessionindex.makeSearchSnippet 的「ToLower 偏移切原文」越界
      ↓ 同款模式在 internal/search.findMatches 里漏网
2026-11-23 00:39:08  用户在工作区根做大小写不敏感搜索
      ↓ scanSearchJobs 并发扫描 → 38 号 worker 读到毒文件第 60 行
      ↓ findMatches：ToLower(line) 37→41 字节（两个非法字节各膨胀成 3 字节 U+FFFD）
      ↓ 查询词 set.j 在降写串 [35,40) 命中 → appendHit 切原行 line[35:40]，行长 37
      ↓ panic → 无 recover → 进程 exit(2)（GUI 无控制台，症状就是闪退）
00:39:41  再搜再崩（同一行）
00:40:49  正常启动后手动关闭（有「应用退出」记录，排除配置问题）
00:42:11  重新构建（exe 00:42）再启动，恢复会话，AI 会话后台跑着
00:44:13  又一次搜索 → 同一 panic → 闪退 → 用户报障
```

---

## 三、取证过程（为什么事件查看器是空的）

1. **Windows 事件日志无记录**：Go panic 由 runtime 捕获后 `exit(2)`，是正常进程退出语义，不产生 WER 事件（Event ID 1000）——「闪退且无事件」本身就是 Go panic 的指纹。
2. **会话日志有完整堆栈**：`applog.Start()` 里 `debug.SetCrashOutput(f, debug.CrashOptions{})` 把崩溃报告复制进本次运行日志（2026-11-17 加的护栏，这次立功）。三次崩溃日志尾部都是同一 panic，行号 578/588/641（旧构建=HEAD）与 728/738/791（新构建=工作区）指向同一逻辑。
3. **机制反推**：唯一能让「降写串偏移套原行」越界的，是 `ToLower` 改变字节长度。全码点扫描证实：变长字符只有 `Ⱥ`(U+023A)/`Ⱦ`(U+023E)（+1）与非法 UTF-8 字节（+2/个）；37 字节行膨胀到 ≥40 需要 ≥3 字节增长 → 锁定「行内含非法 UTF-8 字节的文件」。
4. **模拟扫描定位毒行**：带 NUL 预检复刻 `scanSearchFile` 的预检语义全仓扫描，唯一吻合行 = 毒文件第 60 行（`len=37 lowerLen=41`），内容是 protobuf 头 + `.com/script/asset.js`，查询词 `set.j` 在降写串的命中位置与 panic 参数（35, 40）严丝合缝。

## 四、根因与修复

**根因**：`strings.ToLower` 不保长。非法 UTF-8 字节逐个替换成 3 字节 U+FFFD（+2/个）；`Ⱥ`/`Ⱦ` 小写 2→3 字节。降写副本上的字节区间套回原行，靠后的命中就越界。这是 `sessionindex` 2026-11-18 修过的同款模式（`sessionindex.go:462` 注释「不能拿 strings.ToLower(text) 的偏移去切 text」），search.go 的 `findMatches` 当时漏网。

**修复**（同日落地）：

1. `findMatches` 检测降写后长度漂移（`len(haystack) != len(line)`），漂移时放弃降写快路径，改在原行上逐 rune 折叠匹配（新增 `foldFindFrom`/`foldMatchAt`，口径与「两侧各自 ToLower 再比对」一致），区间永远对原行有效；顺带修正变短字符（U+212A KELVIN 3→1）导致的错位高亮。
2. `scanSearchFile.appendHit` 对 start/end 按原行收口再切片——将来任何上游给出越界偏移只损一条预览，不再 panic 掉进程。
3. 回归测试 4 组 + wholeWord 边界 + 大小写敏感不受影响 + 端到端扫毒行不 panic（`search_test.go`，旧实现下分别越界红 / 进程 panic 红）。

**刻意的取舍**：`.cadt/` 不加进扫描跳过名单——`SkipPath` 注释明确 `.cadt/tmp` 要对 glob/list_dir 保持可见（探针沙箱约定，2026-11-18 事故后定的）；根修后毒文件本身无害。

## 五、后续加固：崩溃自愈（本次落地）

连环闪退暴露出另一个问题：崩溃残留的脏状态（毒文件在 `.cadt/tmp`）会在下次启动后继续坑用户——同一条路再走一遍。新增：

1. **崩溃检测标记**（`internal/crashrecovery`）：GUI 会话启动时在 `appdata/session-alive/` 写「活着」标记（按会话一文件，多实例互不干扰），优雅退出摘除；异常退出遗留。下次启动发现属主已死的标记 = 上次崩溃。
2. **崩溃自愈清理**（根壳 `crashrecovery_app.go`）：取到遗留标记后自动执行一轮「清除缓存」（复用 `storage.CacheIDs()`，同一张条目表）——app 段在启动空档直清（webview-cache 转 pending 由 ApplyPending 本轮收口），工作区段（`ws-worklog`/`ws-tmp`，即 `.cadt/logs` 与 `.cadt/tmp`）等 `WindowRegister` 登记根目录后清。脏 tmp 在用户下一次搜索前就被收掉。
3. **接线时序**：检测与标记只发生在 `application.New` 之后——转发进程在 New 里就 os.Exit，不能抢走标记去清理运行中主实例正占用的缓存。

## 六、教训

1. **「副本上的偏移」是一类事故，不是一处 bug**：凡是对字符串做过长度可变变换（ToLower/编码清洗/规范化）再拿偏移回切原文的代码，都要在变换处断言长度不变或改走原行。本次与 2026-11-18 的 sessionindex 是同一堂课的两次补考；grep `strings.ToLower(` 全仓审一遍偏移用法（本次已查：search/sessionindex 两处，rg 路径的偏移来自 rg 自己的输出编码，自洽）。
2. **二进制预检是「启发式」不是「保证」**：NUL 预检 + 扩展名表拦不住无扩展名、头部无 NUL 的二进制（protobuf/自定义格式）。读路径的解析代码必须自带防越界兜底，不能指望上游过滤。
3. **panic 在 worker goroutine = 全进程死亡**：批量扫描类 worker 若无法保证绝对不 panic，应在 goroutine 入口 recover 降级（本次用区间收口从根上消掉了 panic 源，未加 recover；后续新扫描路径要评估）。
4. **崩溃要留证据也要留后路**：`debug.SetCrashOutput` 把堆栈留进会话日志（取证靠它）；session-alive 标记把「上次崩了」传给下次启动（自愈靠它）——两者配对才闭环。
