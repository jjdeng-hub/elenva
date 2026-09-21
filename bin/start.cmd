@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

if not exist "runtime\node.exe" (
  echo.
  echo   [ERROR] runtime\node.exe not found.
  echo   Please re-extract the whole package; do not move files out of the folder.
  echo.
  pause
  exit /b 1
)

if not exist "launcher.js" (
  echo.
  echo   [ERROR] launcher.js not found.
  echo   Please re-extract the whole package.
  echo.
  pause
  exit /b 1
)

"runtime\node.exe" "launcher.js"
if errorlevel 1 pause
