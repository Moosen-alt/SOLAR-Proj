@echo off
REM ============================================================================
REM  Solar Submission Autopilot - one-click launcher (Windows)
REM  Double-click this file to start the app and open the dashboard.
REM  It works no matter where the repo is cloned (it cd's to its own folder).
REM  Close the server window (or press Ctrl+C in it) to stop.
REM ============================================================================

REM Jump to the folder this script lives in (the repo root).
cd /d "%~dp0"

REM Make sure Node.js is installed and on PATH.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  ERROR: Node.js was not found.
  echo  Install Node 20+ from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

REM First run: install dependencies if node_modules is missing.
if not exist "node_modules" (
  echo Installing dependencies for the first time, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo  npm install failed. See the messages above.
    pause
    exit /b 1
  )
)

REM Read the port from .env if set, otherwise default to 4173.
set "PORT=4173"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" set "PORT=%%B"
  )
)

echo.
echo  Starting Solar Submission Autopilot on http://localhost:%PORT%
echo  (a server window will open - keep it open while testing)
echo.

REM Launch the server in its own window so logs stay visible and Ctrl+C stops it.
start "Solar Autopilot Server" cmd /k "npm start"

REM Give the server a few seconds to boot, then open the dashboard.
timeout /t 6 /nobreak >nul
start "" "http://localhost:%PORT%/dashboard.html"

exit /b 0
