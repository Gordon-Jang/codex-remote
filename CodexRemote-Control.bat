@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-codex-remote.ps1" %*

if errorlevel 1 (
  echo.
  echo Operation failed. Read the error above, then press any key to close.
  pause >nul
)
