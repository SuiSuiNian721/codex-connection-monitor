$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$watchdogPath = Join-Path $projectRoot 'Watch-CodexConnection.ps1'
$source = Get-Content -LiteralPath $watchdogPath -Raw -Encoding utf8
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($watchdogPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Watchdog has parse errors.' }
foreach ($name in @('LauncherPath', 'RestartCooldownSeconds')) {
    if ($name -in @($ast.ParamBlock.Parameters.Name.VariablePath.UserPath)) { throw "FAIL: obsolete restart parameter remains: $name" }
}
foreach ($name in @('Get-LastFullRestartAt', 'Set-LastFullRestartAt', 'Start-ControlledFullRestart')) {
    if ($ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)) {
        throw "FAIL: obsolete restart function remains: $name"
    }
}
if ($source -match 'connection-watchdog\.state\.json|RecoveryRestart|RecoveryExecutable|lastRestartAttemptAt|recoveryProcess') {
    throw 'FAIL: watcher must not retain restart state or launcher handoff.'
}
$commands = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
foreach ($name in @('Start-Process', 'Stop-Process', 'Start-ControlledFullRestart')) {
    if ($name -in $commands) { throw "FAIL: observation-only watcher must not invoke $name" }
}
$module = Import-Module (Join-Path $projectRoot 'ConnectionWatchdog.psm1') -Force -PassThru
foreach ($name in @('Test-FullRestartAllowed', 'Test-CodexCommandRunnerActive')) {
    if ($module.ExportedFunctions.ContainsKey($name)) { throw "FAIL: obsolete restart helper remains: $name" }
}
Write-Host 'Observation-only watchdog regression passed. No restart parameters, functions, persisted state, or process mutation commands remain.'
