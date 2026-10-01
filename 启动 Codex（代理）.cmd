@echo off
setlocal
where pwsh.exe >nul 2>&1
if errorlevel 1 (
    echo PowerShell 7 ^(pwsh.exe^) was not found.
    pause
    exit /b 1
)
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexWithProxy.ps1"
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
    echo.
    echo Codex proxy launcher failed with exit code %exitCode%.
    pause
)
exit /b %exitCode%
