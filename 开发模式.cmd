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

if not exist "node_modules\next\dist\bin\next" (
  echo.
  echo   [ERROR] Dependencies are not installed.
  echo   Run:  npm install
  echo.
  pause
  exit /b 1
)

rem Try node on PATH, then common install locations, then the bundled runtime.
set "NODE_EXE="
where node >nul 2>&1 && set "NODE_EXE=node"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%~dp0dist\elenva-web\runtime\node.exe" set "NODE_EXE=%~dp0dist\elenva-web\runtime\node.exe"

if not defined NODE_EXE (
  echo.
  echo   [ERROR] Node.js not found.
  echo   Install Node.js, or make sure it is on PATH, then retry.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" "bin\dev-launcher.js"
if errorlevel 1 pause
