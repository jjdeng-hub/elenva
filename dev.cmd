@echo off
rem ---------------------------------------------------------------------------
rem ELENVA dev launcher -- the double-click entry for Windows.
rem KEEP THIS FILE ASCII-ONLY.
rem
rem Deliberately NO "chcp": switching the console code page mid-batch makes
rem cmd re-read this file by path, which is known to desync around non-ASCII
rem names/paths (that class of bug is why this launcher was rebuilt). Node.js
rem prints Unicode to the console via WriteConsoleW, so the Chinese messages
rem from bin\dev-launcher.js render correctly without any chcp.
rem
rem The real work lives in bin\dev-launcher.js: starts next dev, then opens the
rem browser. This file only finds a usable node.exe and hands over.
rem (No dependency check here on purpose -- "if it runs, it runs".)
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title ELENVA Dev Mode

rem Find node: PATH -> common locations -> full detector -> bundled runtime.
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%~dp0dist\elenva-web\runtime\node.exe" set "NODE_EXE=%~dp0dist\elenva-web\runtime\node.exe"
if not defined NODE_EXE for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\find-node.ps1" 2^>nul`) do set "NODE_EXE=%%i"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo.
  echo   --- diagnostics: please copy the lines below ---
  echo   Launcher: %~f0
  where node
  set PATH
  echo   -------------------------------------------------
  echo.
  echo   If Node.js is installed, close this window and retry -- a stale PATH
  echo   after an install or update is the usual cause; restarting the PC also
  echo   refreshes it.
  echo   Otherwise install Node.js 22.19 or newer from https://nodejs.org/
  echo.
  echo   Workaround: in a terminal where "node -v" works, run:
  echo     npm run setup
  echo     npm run dev
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "bin\dev-launcher.js"
if errorlevel 1 pause
