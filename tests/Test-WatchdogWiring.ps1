$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$watchdogPath = Join-Path $projectRoot 'Watch-CodexConnection.ps1'

if (-not (Test-Path -LiteralPath $watchdogPath -PathType Leaf)) {
    throw "Watchdog script missing: $watchdogPath"
}

$content = Get-Content -LiteralPath $watchdogPath -Raw -Encoding utf8
$requirements = @(
    @{ Pattern = 'CodexProxyLauncher\.psm1'; Message = 'Watchdog must import the proxy launcher module.' }
    @{ Pattern = 'ConnectionWatchdog\.psm1'; Message = 'Watchdog must import the connection state module.' }
    @{ Pattern = '\$OutageSeconds\s*=\s*180'; Message = 'Watchdog long-outage threshold must default to 180 seconds.' }
    @{ Pattern = '\$RecoverySeconds\s*=\s*15'; Message = 'Watchdog proxy stability threshold must default to 15 seconds.' }
    @{ Pattern = 'connection-watchdog\.log'; Message = 'Watchdog must keep a dedicated operational log.' }
    @{ Pattern = 'Get-CodexConnectionTargets'; Message = 'Watchdog must select isolated natural-reconnection targets.' }
    @{ Pattern = 'Get-CodexProxyConnectionStatus'; Message = 'Watchdog must distinguish an unknown TCP query from a confirmed missing connection.' }
    @{ Pattern = 'Get-Process\s+-Id\s+\$RootProcessId'; Message = 'Watchdog must remain bound to the launched GPT root.' }
    @{ Pattern = '继续等待其自然恢复'; Message = 'Watchdog must wait for natural recovery without restarting the client.' }
    @{ Pattern = 'RecoveryEvaluationRequested'; Message = 'Watchdog must evaluate stable recovery without killing child processes.' }
    @{ Pattern = 'Complete-ConnectionRecovery'; Message = 'Watchdog must accept a natural reconnection without restarting.' }
)

foreach ($requirement in $requirements) {
    if ($content -notmatch $requirement.Pattern) { throw $requirement.Message }
}

if ($content -match 'Stop-Process|Start-Process|RecoveryRestart|LauncherPath|RestartCooldownSeconds') {
    throw 'Observation-only watchdog must not retain process mutation or restart wiring.'
}

if ($content -match 'Invoke-CodexSoftRecovery') {
    throw 'Watchdog must not retain the destructive soft-recovery path.'
}

Write-Host "Watchdog wiring test passed. Assertions: $($requirements.Count)"
