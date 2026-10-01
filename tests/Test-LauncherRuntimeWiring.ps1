$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$launcherPath = Join-Path $projectRoot 'Start-CodexWithProxy.ps1'
$content = Get-Content -Raw -LiteralPath $launcherPath

if ($content -notmatch 'Sync-CodexRuntime\s+-CodexExecutable') {
    throw 'Launcher must synchronize the current Codex runtime before launching the app.'
}
if ($content -notmatch "Env:CODEX_CLI_PATH") {
    throw 'Launcher must point Codex at the relocated CLI through CODEX_CLI_PATH.'
}
if ($content -notmatch 'Start-Process.+-WorkingDirectory') {
    throw 'Launcher must start Codex with its app directory as the working directory.'
}
if ($content -match "Get-Process\s+-Name\s+'Codex'" -or
    $content -notmatch 'GetFileNameWithoutExtension') {
    throw 'Launcher process detection must derive the process name from the discovered executable.'
}
if ($content -match 'RecoveryRestart|RecoveryExecutable') {
    throw 'Launcher must not expose a recovery restart interface.'
}
if ($content -notmatch '\[switch\]\$NoWatchdog') {
    throw 'Launcher must expose a watchdog suppression switch for controlled tests.'
}
if ($content -notmatch 'Watch-CodexConnection\.ps1') {
    throw 'Launcher must wire the connection watchdog after startup.'
}
if ($content -notmatch 'RootProcessId') {
    throw 'Launcher must pass the launched GPT root PID to the watchdog.'
}
if ($content -notmatch 'WindowStyle\s+Hidden') {
    throw 'Launcher must start the watchdog without a visible console window.'
}
if ($content -notmatch 'Get-Command\s+pwsh\.exe') {
    throw 'Launcher must use PowerShell 7 for the UTF-8 watchdog script.'
}
if ($content -notmatch '\$launcherPath\s*=\s*\$MyInvocation\.MyCommand\.Path') {
    throw 'Launcher must capture its own path at script scope.'
}
if ($content -match '-LauncherPath') {
    throw 'A read-only watchdog must not receive a relaunch entry point.'
}

Write-Host 'Launcher runtime wiring test passed.'
