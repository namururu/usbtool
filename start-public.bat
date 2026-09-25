@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Self.ps1" -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Codex.ps1" -Auto -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Public.ps1"

if errorlevel 1 (
  echo.
  echo Public link failed. Check data\public-tunnel.err.log.
  echo.
  pause
)

endlocal
