@echo off
rem build-installer.cmd: launcher for build-installer.ps1 (build - sign - NSIS package)
rem Output: build\bin\CaDt-DataLens-amd64-installer.exe
rem
rem NOTE: keep this file ASCII-only - cmd.exe parses batch files in the OEM codepage
rem (GBK on zh-CN), so UTF-8 Chinese comments get misparsed. Line endings follow
rem .gitattributes (LF for all text files), same as rebuild-exe.cmd.
rem
rem Usage: double-click, or from a shell:
rem   tools\build-installer.cmd                  build + self-signed + package
rem   tools\build-installer.cmd -SkipSign        skip code signing
rem   tools\build-installer.cmd -SkipFrontend    reuse existing frontend\dist
rem   tools\build-installer.cmd -IncludeMCP      also build the MCP server variant
rem Any argument is passed through to build-installer.ps1 unchanged.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-installer.ps1" %*
if errorlevel 1 pause
