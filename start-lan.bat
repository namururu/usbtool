@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Self.ps1" -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-CodexGui.ps1" -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Codex.ps1" -Auto -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexGui.ps1" -Lan

if errorlevel 1 (
  echo.
  echo Portable Codex GUI LAN sharing failed to start.
  echo Check data\gui.err.log if it exists.
  echo.
  pause
)

endlocal
