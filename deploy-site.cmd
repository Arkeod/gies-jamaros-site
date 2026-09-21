@echo off
REM Double-click to deploy the changed static pages (About merge, redirects) to giesweekly.com.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-site.ps1"
echo.
pause
