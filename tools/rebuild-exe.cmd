@echo off
rem rebuild-exe.cmd: launcher for rebuild-exe.ps1 (test gate - wails build - replace root datalens.exe)
rem NOTE: keep this file ASCII-only with CRLF endings - cmd.exe parses batch files in the
rem OEM codepage (GBK on zh-CN); UTF-8 Chinese comments + LF endings get misparsed.
rem The ps1 handles the final press-any-key itself; pause here only on launch failure.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rebuild-exe.ps1" %*
if errorlevel 1 pause
