@echo off
rem Double-click this on Windows. It runs the installer next to it and keeps the
rem window open so you can read the last lines.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" %*
echo.
pause
