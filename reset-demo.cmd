@echo off
rem Puts the demo office back as it was, with today's dates. Stop start.cmd first.
setlocal
cd /d "%~dp0"
set "PGBIN="
for %%v in (16 17 18) do if not defined PGBIN if exist "C:\Program Files\PostgreSQL\%%v\bin\psql.exe" set "PGBIN=C:\Program Files\PostgreSQL\%%v\bin"
set "PATH=%PGBIN%;%APPDATA%\npm;%PATH%"
call pnpm db:reset
if errorlevel 1 goto failed
set "DEMO_CEO_NAME=San"
call pnpm --filter @green-star/api seed-demo
if errorlevel 1 goto failed
echo Done. Double-click start.cmd.
pause
exit /b 0
:failed
echo Something went wrong above. Take a photo of this window and send it to Claude.
pause
exit /b 1
