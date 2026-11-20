param(
    # 构建内含 v3 MCP server 的变体（-tags mcp），见 docs/finished-plans/app-mcp-server.md
    [switch]$IncludeMCP,
    [string]$Certificate = "",
    [string]$CertificatePassword = "",
    [string]$SignTool = "",
    [string]$MakeNsis = "",
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [switch]$SkipSign,
    [switch]$SkipFrontend
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root "build\windows\installer"
$binDir = Join-Path $root "build\bin"
$appExe = Join-Path $binDir "CaDt-DataLens.exe"
$installerExe = Join-Path $binDir "CaDt-DataLens-amd64-installer.exe"

function Resolve-Tool([string]$explicit, [string]$envName, [string[]]$patterns) {
    if ($explicit) {
        if (-not (Test-Path $explicit)) { throw "找不到工具：$explicit" }
        return (Resolve-Path $explicit).Path
    }
    if ($envName -and [Environment]::GetEnvironmentVariable($envName)) {
        return [Environment]::GetEnvironmentVariable($envName)
    }
    $cmd = Get-Command $envName -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($pattern in $patterns) {
        $hit = Get-ChildItem $pattern -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return ""
}

if (-not $MakeNsis) {
    $MakeNsis = Resolve-Tool "" "makensis" @(
        "$env:LOCALAPPDATA\cadt-tools\**\makensis.exe",
        "$env:LOCALAPPDATA\Temp\nsis-portable\**\Bin\makensis.exe",
        "C:\Program Files (x86)\NSIS\makensis.exe",
        "C:\Program Files\NSIS\makensis.exe"
    )
}
if (-not $MakeNsis) { throw "找不到 makensis：请安装 NSIS 3 或通过 -MakeNsis 指定路径" }

$signToolPath = ""
$certArgs = @()
if (-not $SkipSign) {
    $signToolPath = Resolve-Tool $SignTool "signtool" @(
        "$env:LOCALAPPDATA\cadt-tools\sdk-buildtools\bin\*\x64\signtool.exe",
        "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
        "C:\Program Files (x86)\Windows Kits\10\bin\*\x86\signtool.exe"
    )
    if (-not $signToolPath) { throw "找不到 signtool：可用 -SignTool 指定，或安装 Windows SDK" }

    if ($Certificate -and (Test-Path $Certificate)) {
        $certArgs = @("/f", (Resolve-Path $Certificate).Path)
        if ($CertificatePassword) { $certArgs += @("/p", $CertificatePassword) }
    } else {
        $thumbprint = $Certificate
        if (-not $thumbprint) { $thumbprint = $env:CADT_SIGN_THUMBPRINT }
        if (-not $thumbprint) {
            $dev = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
                Where-Object { $_.FriendlyName -eq "CaDt-DataLens Self-Signed (Dev)" } | Select-Object -First 1
            if ($dev) { $thumbprint = $dev.Thumbprint }
        }
        if (-not $thumbprint) { throw "没有可用签名证书：用 -Certificate <pfx或指纹> 指定，或先生成开发证书" }
        $certArgs = @("/sha1", $thumbprint)
    }
}

# v3 构建：前端 vite（可跳过）→ syso（图标/清单/版本资源）→ go build（production+devtools）
$env:PATH = (Split-Path -Parent $MakeNsis) + ";" + $env:PATH
Push-Location $root
try {
    if (-not $SkipFrontend) {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw "找不到 npm：请先安装 Node.js 20.19+ 并加入 PATH"
        }
        if (-not (Test-Path (Join-Path $root "frontend\node_modules"))) {
            Write-Host "==> npm install（frontend）" -ForegroundColor Cyan
            Push-Location (Join-Path $root "frontend")
            try {
                & npm install
                if ($LASTEXITCODE -ne 0) { throw "npm install 失败（退出码 $LASTEXITCODE）" }
            } finally { Pop-Location }
        }
        Write-Host "==> npm run build（frontend）" -ForegroundColor Cyan
        Push-Location (Join-Path $root "frontend")
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw "前端构建失败（退出码 $LASTEXITCODE）" }
        } finally { Pop-Location }
    }

    if (-not (Get-Command wails3 -ErrorAction SilentlyContinue)) {
        throw "找不到 wails3 CLI：需要 Wails v3.1.0+（go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0）"
    }
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    $syso = Join-Path $root "rsrc_windows_amd64.syso"
    Write-Host "==> wails3 generate syso（图标/清单/版本资源）" -ForegroundColor Cyan
    & wails3 generate syso -arch amd64 `
        -icon (Join-Path $root "build\windows\icon.ico") `
        -info (Join-Path $root "build\windows\info.json") `
        -manifest (Join-Path $root "build\windows\wails.exe.manifest") `
        -out $syso
    if ($LASTEXITCODE -ne 0) { throw "wails3 generate syso 失败（退出码 $LASTEXITCODE）" }
    try {
        Write-Host "==> go build -tags production,devtools$(if ($IncludeMCP) { ',mcp' })" -ForegroundColor Cyan
        & go build -tags "production,devtools$(if ($IncludeMCP) { ',mcp' })" -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui" -o $appExe .
        if ($LASTEXITCODE -ne 0) { throw "go build 失败（退出码 $LASTEXITCODE）" }
    } finally {
        Remove-Item $syso -Force -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}

if (-not $SkipSign) {
    $signBase = @("sign", "/fd", "sha256")
    if ($TimestampUrl) { $signBase += @("/tr", $TimestampUrl, "/td", "sha256") }

    Write-Host "==> 签名 $appExe" -ForegroundColor Cyan
    & $signToolPath @signBase @certArgs $appExe
    if ($LASTEXITCODE -ne 0) { throw "签名程序失败（退出码 $LASTEXITCODE）" }
}

$signArgs = ""
if (-not $SkipSign) {
    $signArgs = (@("sign", "/fd", "sha256") + ($(if ($TimestampUrl) { @("/tr", $TimestampUrl, "/td", "sha256") } else { @() })) + $certArgs) -join " "
}

Write-Host "==> wails3 generate webview2bootstrapper（安装包内嵌 WebView2 引导器）" -ForegroundColor Cyan
if (Get-Command wails3 -ErrorAction SilentlyContinue) {
    & wails3 generate webview2bootstrapper -dir (Join-Path $root "build\windows\installer	mp")
    if ($LASTEXITCODE -ne 0) { Write-Host "引导器生成失败：安装包将不含 WebView2 自动安装（目标机器需自带运行时）" -ForegroundColor Yellow }
} else {
    Write-Host "找不到 wails3：跳过 WebView2 引导器生成" -ForegroundColor Yellow
}

Write-Host "==> makensis（安装包 + 卸载程序签名）" -ForegroundColor Cyan
Push-Location $installerDir
try {
    $nsisArgs = @(
        "-DARG_WAILS_AMD64_BINARY=$appExe",
        "-DWAILS_INSTALL_SCOPE=user",
        "-DREQUEST_EXECUTION_LEVEL=user"
    )
    if (-not $SkipSign) {
        $nsisArgs += "-DSIGNTOOL=$signToolPath"
        $nsisArgs += "-DSIGN_ARGS=$signArgs"
    }
    $nsisArgs += "project.nsi"
    & $MakeNsis @nsisArgs
    if ($LASTEXITCODE -ne 0) { throw "makensis 失败（退出码 $LASTEXITCODE）" }
} finally {
    Pop-Location
}

if (-not $SkipSign) {
    Write-Host "==> 校验签名" -ForegroundColor Cyan
    & $signToolPath verify /pa /v $appExe | Select-String "Successfully verified|Issued to|Number of"
    & $signToolPath verify /pa /v $installerExe | Select-String "Successfully verified|Issued to|Number of"
}

Write-Host ""
Write-Host "完成：$installerExe" -ForegroundColor Green
if ($SkipSign) { Write-Host "（本次未签名：-SkipSign）" -ForegroundColor Yellow }
