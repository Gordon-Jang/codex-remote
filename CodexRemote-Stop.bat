@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage-codex-remote.ps1" -Action stop

if errorlevel 1 (
  echo.
  echo Stop failed. Read the error above, then press any key to close.
  pause >nul
  exit /b 1
)

echo.
echo Service is stopped. Press any key to close this window.
pause >nul
