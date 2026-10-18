@echo off
setlocal
cd /d "%~dp0"
if not exist package.json (
  echo Extract all update files into your Biscord project folder first.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or later is required. Your existing Node.js 24 is supported.
  pause
  exit /b 1
)
echo Reinstalling project dependencies. Your database, uploads and .env are kept.
if exist node_modules rmdir /s /q node_modules
if exist node_modules (
  echo.
  echo Some dependency files are locked. Close other Biscord terminals and try again.
  echo If they remain locked, restart Windows, then run this file again.
  pause
  exit /b 1
)
call npm.cmd ci
if errorlevel 1 (
  echo Installation failed. Copy the error above before closing this window.
  pause
  exit /b 1
)
call npm.cmd run setup
if errorlevel 1 (
  pause
  exit /b 1
)
echo Open http://localhost:3000 after the server starts.
call npm.cmd start
pause
