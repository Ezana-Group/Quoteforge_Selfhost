@echo off
title QuoteForge Pro
cd /d "%~dp0"

echo =======================================================
echo    Starting QuoteForge Pro...
echo =======================================================
echo.

REM The optional "mqtt" package (live Bambu Lab status) is installed once on
REM first run. QuoteForge still starts if this fails (e.g. no internet) - only
REM Bambu live status needs it. Test-only packages are skipped (--omit=dev).
if not exist "node_modules" (
  echo Installing dependencies for the first time - this needs internet...
  call npm install --omit=dev
  echo.
)

echo Booting local server...
echo Opening in your default browser...
echo Close this window at any time to stop QuoteForge Pro.
echo.
echo =======================================================

node server.js
pause
