param([switch]$DuplicateFixture, [switch]$LaunchRaceFixture)
$ErrorActionPreference = 'Stop'
$path = Join-Path (Split-Path $PSScriptRoot -Parent) 'Start-CodexWithProxy.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Launcher has syntax errors.' }
if ($DuplicateFixture -or $LaunchRaceFixture) {
    $ProxyServerOverride='127.0.0.1:7890'
    $CodexExecutableOverride=$path
    $DryRun=$false
    $scriptRoot='C:\fixture-launcher-safety'
    $launchMutex=$null
    $ownsLaunchMutex=$false
    function ConvertTo-ProxyUri { param($ProxyServer) 'http://127.0.0.1:7890' }
    function Test-LocalProxy { param($ProxyUri) $true }
    $script:processChecks=0
    function Get-RunningCodexProcesses {
        param($ExecutablePath,[switch]$IncludeOtherVersions)
        $script:processChecks++
        if (-not $LaunchRaceFixture -or $script:processChecks -gt 1) { [pscustomobject]@{ Id=999999 } }
    }
    function Write-LauncherLog { param($Message,$Level) }
    function Restore-CodexProxyRelay { param($CodexExecutable,$ProxyMode,$InitialProxyUri) $null }
    function Sync-CodexCuaRuntime {
        if (-not $LaunchRaceFixture) { throw 'Duplicate launch must not prepare cache.' }
        [pscustomobject]@{ Status='Reused'; Validation='Full'; Fingerprint='fixture'; FileCount=0; ElapsedSeconds=0 }
    }
    function Sync-CodexRuntime {
        if (-not $LaunchRaceFixture) { throw 'Duplicate launch must not prepare cache.' }
        $path
    }
    function Stop-Process { throw 'Launcher must not stop any running process.' }
    function Start-Process { throw 'Duplicate launch must not start a process.' }
    $mainTry=$ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] } | Select-Object -Last 1
    . ([scriptblock]::Create($mainTry.Extent.Text))
    throw 'Duplicate guard did not exit.'
}
$output=& pwsh -NoProfile -File $PSCommandPath -DuplicateFixture 2>&1
if ($LASTEXITCODE -ne 0 -or ($output -join "`n") -notmatch 'Codex 已经运行') { throw "Duplicate launch guard failed: $output" }
$output=& pwsh -NoProfile -File $PSCommandPath -LaunchRaceFixture 2>&1
if ($LASTEXITCODE -ne 0 -or ($output -join "`n") -notmatch 'Codex 已由其他入口打开') { throw "Concurrent native launch must be left running: $output" }
$text=Get-Content -LiteralPath $path -Raw -Encoding utf8
if ($text -match 'RecoveryRestart|RecoveryExecutable|Stop-RunningCodex|CloseMainWindow|Stop-Process') { throw 'Launcher must not expose recovery restart or any running-app close capability.' }
if ($text -notmatch 'TryEnter|WaitOne\(0\)') { throw 'Launcher must reject simultaneous launches.' }
if ($text -notmatch 'ProxyMode') { throw 'An explicit proxy must remain explicit in the watchdog.' }
Write-Host 'Launcher safety tests passed.'
