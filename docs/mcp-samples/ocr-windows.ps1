# ocr-windows.ps1 - minimal MCP stdio server (line-delimited JSON-RPC 2.0).
# Tool: ocr_windows { path, purpose? } -> recognizes text in images with Windows.Media.Ocr.
# IMPORTANT: WinRT projection works with Windows PowerShell 5.1, so configure the server as:
#   command: powershell   args: -NoProfile -ExecutionPolicy Bypass -File <path to this file>
# (PowerShell 7 / pwsh lacks System.Runtime.WindowsRuntime by default.)
# Images only: convert PDF pages to PNG first. Chinese OCR needs the language pack installed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $asTask.Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null

function Send-Json($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 12
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Send-Result($id, $result) {
    Send-Json ([ordered]@{jsonrpc = '2.0'; id = $id; result = $result})
}

function Send-Error($id, $code, $message) {
    Send-Json ([ordered]@{jsonrpc = '2.0'; id = $id; error = [ordered]@{code = $code; message = $message}})
}

$tool = [ordered]@{
    name        = 'ocr_windows'
    description = 'Recognize text in an image with Windows.Media.Ocr (offline). Returns plain text; check the Windows language packs for Chinese. PDF must be converted to images first.'
    inputSchema = [ordered]@{
        type       = 'object'
        properties = [ordered]@{
            path    = [ordered]@{type = 'string'; description = 'Absolute path to an image file'}
            purpose = [ordered]@{type = 'string'; enum = @('text_recognition', 'rich_layout_recognition'); description = 'Ignored by this local engine (kept for contract compatibility)'}
        }
        required   = @('path')
    }
    annotations = [ordered]@{readOnlyHint = $true; destructiveHint = $false; openWorldHint = $false}
}

function Invoke-Ocr($toolArgs) {
    $path = [string]$toolArgs.path
    if ([string]::IsNullOrWhiteSpace($path)) { throw 'path is required' }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('file not found: ' + $path) }
    $full = (Resolve-Path -LiteralPath $path).Path
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($null -eq $engine) { throw 'Windows.Media.Ocr has no language pack; add one in Settings -> Time & language' }
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        return [string]$result.Text
    } finally {
        $stream.Dispose()
    }
}

$stdin = [Console]::In
while ($null -ne ($line = $stdin.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $msg = $null
    try { $msg = $line | ConvertFrom-Json } catch { continue }
    $id = $null
    if ($null -ne $msg.id) { $id = $msg.id }
    $method = [string]$msg.method
    try {
        switch ($method) {
            'initialize' {
                $version = '2025-06-18'
                if ($msg.params -and $msg.params.protocolVersion) { $version = [string]$msg.params.protocolVersion }
                Send-Result $id ([ordered]@{
                    protocolVersion = $version
                    capabilities    = [ordered]@{tools = [ordered]@{}}
                    serverInfo      = [ordered]@{name = 'cadt-ocr-windows'; version = '1.0.0'}
                })
            }
            'notifications/initialized' { }
            'ping' { Send-Result $id ([ordered]@{}) }
            'tools/list' { Send-Result $id ([ordered]@{tools = @($tool)}) }
            'tools/call' {
                $name = [string]$msg.params.name
                if ($name -ne 'ocr_windows') {
                    Send-Result $id ([ordered]@{
                        content = @([ordered]@{type = 'text'; text = ('Unknown tool: ' + $name)})
                        isError = $true
                    })
                    break
                }
                try {
                    $textResult = Invoke-Ocr $msg.params.arguments
                    if ([string]::IsNullOrWhiteSpace($textResult)) { $textResult = '(no text recognized)' }
                    Send-Result $id ([ordered]@{
                        content = @([ordered]@{type = 'text'; text = $textResult})
                        isError = $false
                    })
                } catch {
                    Send-Result $id ([ordered]@{
                        content = @([ordered]@{type = 'text'; text = ('Error: ' + $_.Exception.Message)})
                        isError = $true
                    })
                }
            }
            default {
                if ($null -ne $id) { Send-Error $id -32601 ('Method not found: ' + $method) }
            }
        }
    } catch {
        if ($null -ne $id) { Send-Error $id -32603 ('Internal error: ' + $_.Exception.Message) }
    }
}
