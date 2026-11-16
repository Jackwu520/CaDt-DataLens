# asr-whisper：用 whisper.cpp 提供本地语音识别

CaDt-DataLens 的外部工具支持把「语音识别」来源设为 **本地 MCP**。本示例给一个单文件
Python MCP stdio server，把 `whisper.cpp` 的命令行程序包成 MCP 工具 `asr_whisper`。

**模型与引擎自备，应用不下载、不打包任何模型。** 体积红线：核心 exe 不内置 ASR 引擎。

## 1. 准备

1. 安装 Python 3.9+（`python` 在 PATH）。
2. 编译或下载 `whisper.cpp`，得到 `whisper-cli.exe`（旧版叫 `main.exe`）。
3. 下载一个 ggml 模型（如 `ggml-base.bin` / `ggml-small.bin`），记下路径。
4. 建议用 16 kHz 单声道 WAV 测试；带 ffmpeg 支持的 whisper.cpp 构建可直接读 mp3/m4a。

## 2. MCP server 脚本

把下面内容保存为 `asr-whisper.py`（UTF-8）：

```python
#!/usr/bin/env python3
# asr-whisper.py - minimal MCP stdio server wrapping whisper.cpp.
# Tool: asr_whisper { path } -> plain text transcription.
# Env: WHISPER_CLI (whisper-cli.exe), WHISPER_MODEL (ggml-*.bin), optional WHISPER_LANG.
import json
import os
import subprocess
import sys
import tempfile

WHISPER = os.environ.get("WHISPER_CLI", r"C:\tools\whisper.cpp\whisper-cli.exe")
MODEL = os.environ.get("WHISPER_MODEL", r"C:\tools\whisper.cpp\models\ggml-base.bin")
LANG = os.environ.get("WHISPER_LANG", "auto")

TOOL = {
    "name": "asr_whisper",
    "description": "Transcribe an audio file to text with whisper.cpp (offline, model configured by the user).",
    "inputSchema": {
        "type": "object",
        "properties": {"path": {"type": "string", "description": "Absolute path to the audio file"}},
        "required": ["path"],
    },
    "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
}

def send(obj):
    sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()

def text_result(text, is_error=False):
    return {"content": [{"type": "text", "text": text}], "isError": is_error}

def transcribe(path):
    if not path or not os.path.isfile(path):
        raise RuntimeError("file not found: %s" % path)
    if not os.path.isfile(WHISPER):
        raise RuntimeError("whisper-cli not found; set WHISPER_CLI")
    if not os.path.isfile(MODEL):
        raise RuntimeError("model not found; set WHISPER_MODEL")
    prefix = tempfile.mktemp(prefix="cadt-asr-")
    cmd = [WHISPER, "-m", MODEL, "-f", path, "-otxt", "-of", prefix, "-l", LANG]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "whisper-cli failed").strip()
        raise RuntimeError(detail[-2000:])
    out_file = prefix + ".txt"
    try:
        with open(out_file, encoding="utf-8", errors="replace") as handle:
            text = handle.read().strip()
    finally:
        for leftover in (out_file, prefix):
            try:
                os.remove(leftover)
            except OSError:
                pass
    return text or "(no speech recognized)"

def main():
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid = msg.get("id")
        method = msg.get("method") or ""
        if method == "initialize":
            params = msg.get("params") or {}
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "cadt-asr-whisper", "version": "1.0.0"},
            }})
        elif method == "notifications/initialized":
            continue
        elif method == "ping":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [TOOL]}})
        elif method == "tools/call":
            params = msg.get("params") or {}
            if params.get("name") != "asr_whisper":
                send({"jsonrpc": "2.0", "id": mid, "result": text_result(
                    "Unknown tool: %s" % params.get("name"), True)})
                continue
            try:
                text = transcribe(str((params.get("arguments") or {}).get("path", "")))
            except Exception as exc:  # noqa: BLE001 - report to MCP client
                send({"jsonrpc": "2.0", "id": mid, "result": text_result("Error: %s" % exc, True)})
            else:
                send({"jsonrpc": "2.0", "id": mid, "result": text_result(text)})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "error": {
                "code": -32601, "message": "Method not found: %s" % method}})

if __name__ == "__main__":
    main()
```

## 3. 在 CaDt-DataLens 里配置

1. 设置 → AI → 外部工具 → MCP 服务器：添加服务器
   - 名称：`asr_whisper`（公开工具名会变成 `mcp__asr_whisper__asr_whisper`）
   - 启动命令：`python`
   - 参数（每行一个）：`-u`、`D:\path\to\asr-whisper.py`
   - 环境变量：`WHISPER_CLI` = whisper-cli.exe 路径；`WHISPER_MODEL` = 模型路径（可选 `WHISPER_LANG`）
2. 保存后在「工具」面板勾选 `asr_whisper`。
3. 在「能力来源」里把「语音识别」设为「本地 MCP」，二级下拉选 `mcp__asr_whisper__asr_whisper`。

## 4. 参数契约与限制

| 项 | 值 |
| --- | --- |
| 核心调用参数 | `{path}`（原始音频绝对路径，核心不转码） |
| server 返回 | 纯文本转写 |
| 支持格式 | 取决于 whisper.cpp 构建；最稳妥是 16 kHz 单声道 WAV，带 ffmpeg 的构建可读 mp3/m4a |
| 时长 / 大小 | 核心对 MCP 来源不做 20 MB / 15 分钟限制（那是 provider 转码链的上限）；请自行控制 |
| 权限 | MCP 来源只在写权限档（非计划模式）向 AI 开放，调用按写工具审批 |
| 模型 | 用户自备，不随应用分发 |
