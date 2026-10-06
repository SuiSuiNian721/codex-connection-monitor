@echo off
chcp 65001 >nul
pwsh.exe -NoProfile -File "%~dp0Start-CodexPerformanceMonitor.ps1" -OpenPanel
if errorlevel 1 pause
