@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"
title ELENVA Dev Mode

rem ---------------------------------------------------------------------------
rem KEEP THIS FILE ASCII-ONLY -- do not translate the messages below into Chinese.
rem
rem Why: this launcher has a non-ASCII filename. Once "chcp 65001" above has run,
rem cmd re-reads the batch file by path; re-encoding a non-ASCII path under the
rem new code page loses byte alignment, so cmd resumes reading at a wrong offset
rem and the tail of a Chinese line gets executed as a command:
rem   'xx(garble)' is not recognized as an internal or external command
rem ASCII-only content cannot desync, whatever the path encoding does.
rem (Also keep angle brackets out of comments: rem still honours redirection.)
rem
rem Chinese user-facing messages live in bin\dev-launcher.js -- Node prints them,
rem and chcp 65001 above makes them render correctly in this console.
rem ---------------------------------------------------------------------------

rem Dependency check lives in bin\dev-launcher.js now -- on first launch it
rem offers to run "npm install", so a fresh clone works from a double-click.

rem Try node on PATH, then common install locations, then the bundled runtime.
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%~dp0dist\elenva-web\runtime\node.exe" set "NODE_EXE=%~dp0dist\elenva-web\runtime\node.exe"

rem Still nothing? Run the full detector: registry + common dirs + version
rem managers (nvm / fnm / scoop / volta / chocolatey). "where node" alone
rem misses valid installs when PATH is stale or Node came from a manager.
if not defined NODE_EXE for /f "usebackq delims=" %%i in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\find-node.ps1" 2^>nul`) do set "NODE_EXE=%%i"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
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
