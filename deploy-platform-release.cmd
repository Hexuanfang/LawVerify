@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-platform-release.ps1" %*
endlocal
