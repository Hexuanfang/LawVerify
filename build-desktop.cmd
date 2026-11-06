@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-desktop-release.ps1" %*
set "BUILD_EXIT=%ERRORLEVEL%"
endlocal & exit /b %BUILD_EXIT%
