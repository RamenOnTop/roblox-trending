@echo off
cd /d "%~dp0.."
call npm run history:sync
if errorlevel 1 (
  echo.
  echo Sync stopped. Previously imported days are retained. Read the error above before retrying.
)
pause
