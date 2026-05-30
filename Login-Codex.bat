@echo off
setlocal

cd /d "%~dp0"

echo Portable Codex login
echo CODEX_HOME is inside this USB folder.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Codex.ps1" -CodexArgs @("login")

echo.
echo If login finished successfully, close this window and return to the GUI.
pause

endlocal
