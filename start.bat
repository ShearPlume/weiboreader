@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Install Node.js 18+ first: https://nodejs.org
  echo.
  pause
  exit /b 1
)

node server\server.js

echo.
echo Server stopped.
pause
