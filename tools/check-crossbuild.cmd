@echo off
rem check-crossbuild.cmd: launcher for check-crossbuild.ps1 (Go cross-compile guard for linux/darwin)
rem NOTE: keep this file ASCII-only with CRLF endings - cmd.exe parses batch files in the
rem OEM codepage (GBK on zh-CN); UTF-8 Chinese comments + LF endings get misparsed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-crossbuild.ps1" %*
if errorlevel 1 pause
