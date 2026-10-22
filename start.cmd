@echo off
rem Starts Green Star on this PC and opens it. setup.cmd must have run once.
rem Close the three black windows to stop it.
cd /d "%~dp0"
set "PATH=%APPDATA%\npm;%PATH%"

start "Green Star - API" cmd /k pnpm --filter @green-star/api start
start "Green Star - checks" cmd /k pnpm --filter @green-star/worker start
start "Green Star - office" cmd /k pnpm --filter @green-star/web start

echo Starting Green Star...
timeout /t 10 /nobreak >nul
start "" http://localhost:3000
echo.
echo Sign in with 0770 000 0001 and the password greenstar-demo.
echo Leave the three black windows open while you use it.
pause
