@echo off
REM Starts FlowFrame on Windows. Double-click it, or run start.cmd from a prompt.
REM Everything it does lives in scripts\start.mjs.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo FlowFrame needs Node 20 or newer. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node scripts\start.mjs %*
if errorlevel 1 pause
