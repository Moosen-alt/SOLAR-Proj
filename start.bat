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

REM Install dependencies if node_modules is missing OR incomplete. A partial
REM install (e.g. an interrupted npm install, or a folder copied without all
REM packages) would otherwise fail at runtime with "Cannot find package ...".
REM We check the two critical runtime deps as a sentinel.
set "NEED_INSTALL="
if not exist "node_modules" set "NEED_INSTALL=1"
if not exist "node_modules\better-sqlite3" set "NEED_INSTALL=1"
if not exist "node_modules\tsx" set "NEED_INSTALL=1"
if defined NEED_INSTALL (
  echo Installing dependencies, please wait ^(first run can take a minute^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo  npm install failed. See the messages above.
    echo  If it mentions better-sqlite3, try a clean reinstall:
    echo      rmdir /s /q node_modules
    echo      npm install
    echo.
    pause
    exit /b 1
  )
)

REM First run: create a .env from .env.example with a freshly generated
REM SESSION_ENCRYPTION_KEY (so portal sessions encrypt and there's no warning).
REM Add your ANTHROPIC_API_KEY to .env later if you want the AI features.
if not exist ".env" (
  if exist ".env.example" (
    echo Creating .env with a generated encryption key...
    powershell -NoProfile -Command "$b=New-Object byte[] 32;[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);$k=($b|ForEach-Object{$_.ToString('x2')}) -join '';(Get-Content '.env.example') -replace '^SESSION_ENCRYPTION_KEY=.*',('SESSION_ENCRYPTION_KEY='+$k) | Set-Content '.env'"
    echo .env created. Paste your ANTHROPIC_API_KEY into it to enable AI parsing/drafting.
  )
)

REM Read the port from .env if set, otherwise default to 4173.
set "PORT=4173"
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="PORT" set "PORT=%%B"
  )
)

REM THIS MACHINE'S PRODUCTION (2026-09-27): when the pinned deploy checkout exists, start the
REM latest CHECKED release (.probe\release.txt) from it - never the working tree, which holds
REM work in progress (a start from it ran half-finished files live on 2026-09-27). Other clones
REM have no .probe\prod-pinned and keep the plain "npm start" below.
if exist ".probe\prod-pinned\.git" if exist ".probe\start-latest.mjs" (
  echo.
  echo  Starting Solar Submission Autopilot - latest checked release, pinned
  echo.
  node ".probe\start-latest.mjs"
  if errorlevel 1 (
    echo.
    echo  Start failed - see the messages above. Nothing else was changed.
    pause
    exit /b 1
  )
  start "" "http://localhost:%PORT%/dashboard.html"
  exit /b 0
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
