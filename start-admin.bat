@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexGuiAdmin.ps1"

if errorlevel 1 (
  echo.
  echo Portable Codex GUI failed to start as administrator.
  echo Check data\gui.err.log if it exists.
  echo.
  pause
)

endlocal
