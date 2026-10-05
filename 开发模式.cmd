@echo off
rem ---------------------------------------------------------------------------
rem Thin shim: keeps the familiar double-click name working.
rem The real launcher is dev.cmd (ASCII name; see its header for why).
rem KEEP THIS FILE ASCII-ONLY.
rem ---------------------------------------------------------------------------
call "%~dp0dev.cmd" %*
