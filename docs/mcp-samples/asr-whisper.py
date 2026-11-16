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
