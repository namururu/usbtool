@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Clean-UsbCodex.ps1" %*

if errorlevel 1 (
  echo.
  echo Clean failed.
  echo.
  pause
)

endlocal
