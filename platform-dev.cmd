@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\platform-dev.ps1" %*
