@echo off
rem Double-click launcher for Windows. Runs start.ps1 (see README.md).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 (
    echo.
    echo The launcher stopped with an error. See the message above.
    pause
)
