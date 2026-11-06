@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-workbench.ps1" %*
endlocal
