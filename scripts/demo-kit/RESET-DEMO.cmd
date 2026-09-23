@echo off
setlocal

rem ===========================================================================
rem  SOLAR SUBMISSION AUTOPILOT - RESET THE DEMO, THEN START IT
rem
rem  Puts every project back exactly where it was when the kit was built:
rem  undoes captured confirmations, pasted statuses, uploaded forms - all of it.
rem  Close the demo's server window first if it is open.
rem ===========================================================================

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js is not installed on this machine.
  echo   Install Node 22 from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node kit-snapshot.mjs restore
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

call START-DEMO.cmd
endlocal
