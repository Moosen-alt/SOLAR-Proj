@echo off
setlocal

rem ===========================================================================
rem  SOLAR SUBMISSION AUTOPILOT - PORTABLE DEMO
rem
rem  Double-click this file. It starts the demo and opens your browser.
rem  Close this window when you are finished.
rem
rem  This kit is self-contained and powerless: four invented projects for a
rem  fake company, no credentials, no network, localhost only. It cannot reach
rem  a utility portal and it contains no real customer.
rem ===========================================================================

cd /d "%~dp0"

echo.
echo   Solar Submission Autopilot - portable demo
echo   ==========================================
echo.

rem Node is not bundled. better-sqlite3 ships a compiled binary that is pinned
rem to a Node major version, so a mismatch fails at require() with a confusing
rem message - check for Node first and say something useful instead.
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed on this machine.
  echo   Install Node 22 from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if not "%NODEMAJOR%"=="22" (
  echo   WARNING: this kit was built against Node 22, and Node %NODEMAJOR% is installed.
  echo   The database driver is compiled per Node version and may refuse to load.
  echo   If the next step fails, install Node 22.
  echo.
)

rem Document paths are stored absolute, so they must be re-pointed at wherever
rem this folder now lives. Skipping this makes every document silently vanish
rem from the gates while still appearing in the documents list.
echo   Preparing documents...
node kit-repair-paths.mjs
if errorlevel 1 (
  echo.
  echo   The kit is incomplete - some document files are missing. See above.
  echo.
  pause
  exit /b 1
)

echo   Starting the demo server...
echo.
start "" http://localhost:4270/
node_modules\.bin\tsx backend\src\server.ts

endlocal
