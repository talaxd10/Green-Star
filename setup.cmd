@echo off
rem Green Star on this Windows PC, for showing it. Run once, with internet.
rem Needs Node.js 22 and PostgreSQL 16 installed first. Takes 5 to 10 minutes.
setlocal
cd /d "%~dp0"
title Green Star - setting up

set "PGBIN="
for %%v in (16 17 18) do if not defined PGBIN if exist "C:\Program Files\PostgreSQL\%%v\bin\psql.exe" set "PGBIN=C:\Program Files\PostgreSQL\%%v\bin"
if not defined PGBIN (
  echo PostgreSQL is not installed. Install PostgreSQL 16, then run this again.
  pause
  exit /b 1
)
set "PATH=%PGBIN%;%APPDATA%\npm;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22, then run this again.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo Installing pnpm...
  call npm install -g pnpm@10.28.0
  if errorlevel 1 goto failed
)

echo.
set /p "PGPASSWORD=Type the postgres password you chose when installing PostgreSQL, then press Enter: "
psql -U postgres -h 127.0.0.1 -tAc "select 1" >nul
if errorlevel 1 (
  echo That password did not work. Run this again.
  pause
  exit /b 1
)
psql -U postgres -h 127.0.0.1 -tAc "select 1 from pg_roles where rolname = 'gs_owner'" | findstr "1" >nul
if errorlevel 1 (
  psql -U postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -f infra\postgres-init.sql
  if errorlevel 1 goto failed
)
set "PGPASSWORD="

if not exist .env copy .env.example .env >nul

echo.
echo Installing the packages...
call pnpm install --frozen-lockfile
if errorlevel 1 goto failed

echo.
echo Installing the browser that draws statements...
call pnpm --filter @green-star/web exec playwright install chromium

echo.
echo Filling the demo office...
call pnpm db:reset
if errorlevel 1 goto failed
set "DEMO_CEO_NAME=San"
call pnpm --filter @green-star/api seed-demo
if errorlevel 1 goto failed

echo.
echo Building the office app...
call pnpm --filter @green-star/web build
if errorlevel 1 goto failed

echo.
echo Done. Double-click start.cmd to open Green Star.
pause
exit /b 0

:failed
echo.
echo Something went wrong above. Take a photo of this window and send it to Claude.
pause
exit /b 1
