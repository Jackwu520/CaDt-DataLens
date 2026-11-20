# check-crossbuild.ps1：交叉编译护栏——确认 Go 侧在 macOS / Linux 上仍然编得过。
#
# 为什么要有这一条：非 Windows 的失败形态不是「功能缺失」而是「整包编译不过」。
# 2026-11-17 第一次跑交叉编译，gitinfo / plugins / browser 三个包各自红（Windows 上永远是绿的）。
# 不产出任何可执行文件，只做目标平台的类型检查（CGO 关闭，不需要目标平台工具链）。
# 用 go vet 而不是 go build：vet 顺带把 *_test.go 也编一遍，能挡住「测试里写了 Windows 专属调用」。
#
# 用法：tools\check-crossbuild.cmd（双击）或 powershell -NoProfile -File tools\check-crossbuild.ps1
# 退出码：0 = 全部通过；1 = 有目标失败（逐条打印包与行号）。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = [System.IO.Path]::GetTempFileName()
$savedGoos = $env:GOOS
$savedGoarch = $env:GOARCH
$savedCgo = $env:CGO_ENABLED
$failed = @()

Push-Location $root
try {
    $targets = @(
        @{ Os = 'linux';  Arch = 'amd64'; Label = 'linux/amd64' },
        @{ Os = 'darwin'; Arch = 'arm64'; Label = 'darwin/arm64' },
        @{ Os = 'darwin'; Arch = 'amd64'; Label = 'darwin/amd64' }
    )
    foreach ($t in $targets) {
        Write-Host ("==> " + $t.Label) -ForegroundColor Cyan
        $env:GOOS = $t.Os
        $env:GOARCH = $t.Arch
        $env:CGO_ENABLED = '0'
        # Wails v3 的非 Windows 纯 Go 构建要求 purego 标签（CGO-free 桌面实验路径）；
        # 不带标签时 v3 的 buildguard 会显式报错。
        & go vet -tags purego ./... 2> $log
        if ($LASTEXITCODE -ne 0) {
            $failed += $t.Label
            Get-Content $log | Where-Object { $_.Trim() -ne '' } | ForEach-Object {
                Write-Host ("    " + $_) -ForegroundColor Red
            }
        } else {
            Write-Host "    ok" -ForegroundColor Green
        }
    }
}
finally {
    $env:GOOS = $savedGoos
    $env:GOARCH = $savedGoarch
    $env:CGO_ENABLED = $savedCgo
    Remove-Item $log -ErrorAction SilentlyContinue
    Pop-Location
}

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host ("交叉编译失败：" + ($failed -join '、')) -ForegroundColor Red
    Write-Host "修法：平台专属代码搬进 *_windows.go，另写 *_other.go 桩；防黑窗统一用 executil.HideCommandWindow。" -ForegroundColor Yellow
    exit 1
}
Write-Host ""
Write-Host "全部通过：linux/amd64、darwin/arm64、darwin/amd64" -ForegroundColor Green
exit 0
