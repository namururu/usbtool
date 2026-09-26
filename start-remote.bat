@echo off
setlocal

cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Self.ps1" -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-CodexGui.ps1" -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Codex.ps1" -Auto -Quiet
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexRemote.ps1" -Background

if errorlevel 1 (
  echo.
  echo Remote Codex Console failed to start.
  echo Check data\remote-startup.json and data\remote-console.err.log.
  echo.
  pause
  exit /b 1
)

echo.
echo Startup finished. The remote server runs in the background.
echo Press any key to close this window.
pause >nul
endlocal
