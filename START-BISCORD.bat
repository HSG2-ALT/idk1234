@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13 or later, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm.cmd ci
  if errorlevel 1 (
    echo Dependency installation failed. See the error above and README.md.
    pause
    exit /b 1
  )
)
call npm.cmd run setup
if errorlevel 1 (
  pause
  exit /b 1
)
echo Open http://localhost:3000 in your browser after the server starts.
call npm.cmd start
pause
