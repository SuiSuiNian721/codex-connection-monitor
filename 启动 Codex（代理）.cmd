@echo off
setlocal
chcp 65001 >nul
where pwsh.exe >nul 2>&1
if errorlevel 1 (
    echo PowerShell 7 ^(pwsh.exe^) was not found.
    pause
    exit /b 1
)
echo.
echo   Codex 启动与监测
echo.
echo   [1] 启动 Codex（后台监测自动跟随）
echo   [2] 查看监测面板（网络诊断、输出速度与 token 统计）
echo   [0] 退出
echo.
choice /C 120 /N /M "请选择 [1/2/0]："
if errorlevel 4 exit /b 1
if errorlevel 3 exit /b 0
if errorlevel 2 goto monitor
if errorlevel 1 goto launch
exit /b 0

:launch
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexWithProxy.ps1"
set "exitCode=%ERRORLEVEL%"
goto finish

:monitor
pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-CodexPerformanceMonitor.ps1" -OpenPanel
set "exitCode=%ERRORLEVEL%"

:finish
if not "%exitCode%"=="0" (
    echo.
    echo 操作失败，退出码：%exitCode%。
    pause
)
exit /b %exitCode%
