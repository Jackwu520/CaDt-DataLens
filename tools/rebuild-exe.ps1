param(
    # 透传 wails build -devtools（带调试面板的构建）
    [switch]$Devtools,
    # 跳过测试门直接构建（测试门失败后选「2 强行构建」走同一条路）
    [switch]$SkipTest,
    # 不停运行中的实例：改用「改名让路」替换（运行中的旧 exe 改名为 datalens.running-old-*.exe）
    [switch]$KeepRunning
)

# rebuild-exe.ps1：一键构建 exe 并替换到仓库根目录的便携副本 datalens.exe（tools\rebuild-exe.cmd 双击入口）。
# 流程：先跑测试门（Go + 前端）→ 通过直接构建；未通过则显示失败摘要，可选
# 「1 复制失败信息到剪贴板（粘贴给 AI 修复）」「2 跳过测试强行构建」「其他退出」。
# 运行中的 exe 无法覆盖——默认先尝试优雅关闭（等 6 秒，应用有「AI 正在生成」二次确认弹窗
# 时会超时转强制结束）；带 -KeepRunning 时改走改名让路（Windows 允许改名运行中的 exe），
# 遗留的 datalens.running-old-*.exe 下次运行清理（名字匹配 .gitignore 的 *.running-old*.exe）。

$ErrorActionPreference = "Stop"
# 子进程输出按 UTF-8 解码：node（npm test）输出是 UTF-8，GBK 控制台会把中文/✔ 测试名
# 解成乱码并污染剪贴板（复制给 AI 的失败信息必须可读）。仅影响解码，不改控制台代码页。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $PSScriptRoot
$binExe = Join-Path $root "build\bin\CaDt-DataLens.exe"
$target = Join-Path $root "datalens.exe"
$testLog = Join-Path $env:TEMP "cadt-rebuild-tests.log"

# 结束前的「按任意键退出」：双击场景由控制台 ReadKey 接住；无控制台 stdin（管道/CI）时
# ReadKey 抛错，回退 ReadLine（EOF 立即返回，不卡）。
function Wait-AnyKey {
    Write-Host ""
    Write-Host "按任意键退出…" -ForegroundColor DarkGray
    try {
        [void][System.Console]::ReadKey($true)
    } catch {
        $null = [System.Console]::In.ReadLine()
    }
}

# ---------- 运行中的实例处理（构建替换前） ----------
function Stop-RunningInstances {
    # 只停这两个已知路径的实例（按进程路径过滤，不动用户可能装在别处的副本）
    $known = @($binExe, $target)
    $running = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path }
    if (-not $running) { return }
    Write-Host "发现运行中的实例，尝试优雅关闭…" -ForegroundColor Cyan
    foreach ($proc in $running) { $null = $proc.CloseMainWindow() }
    # 应用有「AI 正在生成」关窗二次确认：等 6 秒，没退的转强制结束
    $deadline = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $deadline) {
        $alive = $running | Where-Object { -not $_.HasExited }
        if (-not $alive) { break }
        Start-Sleep -Milliseconds 300
        $running = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path }
        if (-not $running) { break }
    }
    $alive = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -in @("CaDt-DataLens", "datalens") -and $known -contains $_.Path }
    foreach ($proc in $alive) {
        Write-Host "强制结束：$($proc.Path)（可能有未关闭的确认弹窗或仍在流式）" -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    Write-Host "已关闭运行中的实例。" -ForegroundColor DarkGray
}

# ---------- 构建并替换根目录副本 ----------
function Build-AndReplace {
    Get-ChildItem -Path $root -Filter "*.running-old*.exe" -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch { }
        }
    if (-not $KeepRunning) { Stop-RunningInstances }

    Push-Location $root
    try {
        $wailsArgs = @("build")
        if ($Devtools) { $wailsArgs += "-devtools" }
        Write-Host ""
        Write-Host ("wails " + ($wailsArgs -join " ")) -ForegroundColor Cyan
        & wails @wailsArgs
        if ($LASTEXITCODE -ne 0) {
            throw "wails build 失败（退出码 $LASTEXITCODE），未替换根目录 exe。"
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path $binExe)) { throw "构建产物不存在：$binExe" }

    try {
        Copy-Item $binExe $target -Force
    } catch {
        # 目标仍被占用：改名让路——运行中的 exe 允许改名。备份名以 .exe 结尾，
        # 匹配 .gitignore 的 *.running-old*.exe 与本脚本的清理 filter
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $aside = Join-Path $root ("datalens.running-old-" + $stamp + ".exe")
        Rename-Item $target $aside -Force
        Write-Host "原 exe 仍在运行，已改名为 $(Split-Path -Leaf $aside)（下次运行本工具时清理）" -ForegroundColor Yellow
        Copy-Item $binExe $target -Force
    }

    # exe 未必内嵌版本资源：空则回退读 wails.json 的 productVersion（版本号三处一致之一）
    $version = (Get-Item $target).VersionInfo.ProductVersion
    if (-not $version) {
        try {
            $wailsJson = Get-Content (Join-Path $root "wails.json") -Raw | ConvertFrom-Json
            $version = [string]$wailsJson.info.productVersion
        } catch { }
    }
    $sizeMB = [math]::Round((Get-Item $target).Length / 1MB, 1)
    Write-Host ""
    Write-Host "完成：$target" -ForegroundColor Green
    Write-Host ("版本 " + $version + " · " + $sizeMB + " MB · 构建于 " + (Get-Date -Format "HH:mm:ss"))
}

# ---------- 主流程 ----------
try {
    if (-not $SkipTest) {
        Remove-Item $testLog -ErrorAction SilentlyContinue
        Write-Host "[1/2] 测试门（输出同时写入 $testLog）" -ForegroundColor Cyan

        # 开头选择：是否进行 Go 测试（go test 全仓约 20 秒；2 = 跳过，只跑前端测试门）
        # Console.In 而非 Read-Host：重定向 stdin（管道/CI）下行为一致
        Write-Host "是否进行 Go 测试？输入 1 进行（约 20 秒）/ 输入 2 跳过（只跑前端测试）" -ForegroundColor Yellow
        $goChoice = [System.Console]::In.ReadLine()
        if ([string]::IsNullOrEmpty($goChoice)) { $goChoice = "" }
        $goChoice = $goChoice.Trim()

        # native 命令的 stderr 经 2>&1 进管道时不允许被 ErrorActionPreference=Stop 打断
        #（pwsh 7.3+ 的 $PSNativeCommandUseErrorActionPreference；5.1 下该赋值无副作用）
        $PSNativeCommandUseErrorActionPreference = $false
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"

        $goFail = $false
        if ($goChoice -eq "2") {
            Write-Host "已跳过 Go 测试。" -ForegroundColor DarkGray
        } else {
            Push-Location $root
            try {
                Write-Host ""
                Write-Host "—— Go 测试（编译阶段无输出属正常；挂死测试 4 分钟自动终止）——" -ForegroundColor DarkGray
                # -timeout 4m：卡死的测试由 go 强杀并输出 goroutine 堆栈，而不是无限等待
                & go test ./... -timeout 4m 2>&1 | Tee-Object -FilePath $testLog -Append
                $goFail = $LASTEXITCODE -ne 0
            } finally {
                Pop-Location
            }
        }
        Push-Location (Join-Path $root "frontend")
        try {
            Write-Host ""
            Write-Host "—— 前端测试（npm test）——" -ForegroundColor DarkGray
            & npm test 2>&1 | Tee-Object -FilePath $testLog -Append
            $feFail = $LASTEXITCODE -ne 0
        } finally {
            Pop-Location
        }
        $ErrorActionPreference = $prevEAP

        if ($goFail -or $feFail) {
            Write-Host ""
            $bad = @()
            if ($goFail) { $bad += "Go" }
            if ($feFail) { $bad += "前端" }
            Write-Host ("[X] 测试未通过（" + ($bad -join " / ") + "）。失败摘要（最后 60 行）：") -ForegroundColor Red
            Get-Content $testLog -Tail 60 | ForEach-Object { Write-Host $_ }
            Write-Host ""
            Write-Host "完整测试输出：$testLog" -ForegroundColor DarkGray
            # Console.In 而非 Read-Host：重定向 stdin（管道/CI）下行为一致
            Write-Host "输入 1 复制完整失败信息到剪贴板 / 输入 2 跳过测试强行构建 / 其他直接退出" -ForegroundColor Yellow
            $choice = [System.Console]::In.ReadLine()
            if ([string]::IsNullOrEmpty($choice)) { $choice = "" }
            $choice = $choice.Trim()
            if ($choice -eq "1") {
                Set-Clipboard -Value (Get-Content $testLog -Raw)
                Write-Host "已复制完整测试输出到剪贴板，可直接粘贴给 AI 修复。" -ForegroundColor Green
                return
            }
            if ($choice -eq "2") {
                Write-Host "跳过测试门，强行构建…" -ForegroundColor Yellow
            } else {
                return
            }
        } else {
            Write-Host ""
            Write-Host "[✓] 测试门通过，开始构建…" -ForegroundColor Green
        }
    }

    Build-AndReplace
} catch {
    Write-Host ""
    Write-Host "[X] 出错：$($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Message -notmatch "wails build 失败") {
        Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    }
} finally {
    Wait-AnyKey
}
