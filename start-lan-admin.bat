@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexGuiAdmin.ps1" -Lan

if errorlevel 1 (
  echo.
  echo Portable Codex GUI LAN sharing failed to start as administrator.
  echo Check data\gui.err.log if it exists.
  echo.
  pause
)

endlocal
