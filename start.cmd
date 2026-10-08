@echo off
rem ---------------------------------------------------------------------------
rem ELENVA production launcher -- the only Windows start entry.
rem KEEP THIS FILE ASCII-ONLY.
rem
rem This file only finds a usable node.exe and hands over to the production
rem launcher. The launcher installs dependencies, builds stale output, starts
rem next, and opens the browser.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
title ELENVA

rem Find node: PATH -> common locations -> full detector.
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\find-node.ps1" 2^>nul`) do set "NODE_EXE=%%i"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo.
  echo   Install Node.js 22.19 or newer from https://nodejs.org/ and retry.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "bin\start-launcher.js"
if errorlevel 1 pause
