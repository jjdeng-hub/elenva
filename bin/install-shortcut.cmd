@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

rem KEEP THIS FILE ASCII-ONLY: cmd.exe cannot reliably parse non-ASCII, and the
rem Chinese user-facing text lives in install-shortcut.ps1 (which is UTF-8 + BOM
rem so PowerShell 5.1 reads it correctly).
echo.
echo   Adding "ELENVA Workstation" to the Start Menu...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcut.ps1"
echo.
pause
