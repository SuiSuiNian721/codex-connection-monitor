[CmdletBinding()]
param([ValidateSet('', 'System', 'Explicit')][string]$FixtureMode = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$path = Join-Path $projectRoot 'Start-CodexWithProxy.ps1'
if ($FixtureMode) {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw '启动器语法错误。' }
    $ProxyServerOverride = if ($FixtureMode -eq 'Explicit') { '127.0.0.1:7890' } else { '' }
    $CodexExecutableOverride = $path
    $DryRun = $false
    $NoWatchdog = $false
    $NoPerformanceMonitor = $true
    $scriptRoot = 'C:\fixture-stable-proxy-routing'
    $launchMutex = $null
    $ownsLaunchMutex = $false
    $script:processChecks = 0
    $script:relayStarted = $false
    $script:clientProxy = 'http://127.0.0.1:23456'
    $script:relayState = 'C:\fixture-stable-proxy-routing\service.json'
    function ConvertTo-ProxyUri { param($ProxyServer) 'http://127.0.0.1:7890' }
    function Test-LocalProxy { param($ProxyUri) $true }
    function Get-ItemProperty { param($Path) [pscustomobject]@{ ProxyEnable = 1; ProxyServer = '127.0.0.1:7890' } }
    function Get-RunningCodexProcesses {
        param($ExecutablePath, [switch]$IncludeOtherVersions)
        $script:processChecks++
        if ($script:processChecks -gt 2) { [pscustomobject]@{ Id = 54321 } }
    }
    function Write-LauncherLog { param($Message, $Level) }
    function Sync-CodexCuaRuntime { [pscustomobject]@{ Status = 'Reused'; Validation = 'Full'; Fingerprint = 'fixture'; FileCount = 0; ElapsedSeconds = 0 } }
    function Sync-CodexRuntime { param($CodexExecutable) 'C:\fixture\codex.exe' }
    function Initialize-GenerationCollection {
        param([string]$RealCliPath, [switch]$Disabled)
        if ($RealCliPath -ne 'C:\fixture\codex.exe' -or -not $Disabled) {
            throw '路由夹具必须禁用实时采集，并保留已解析的 CLI 路径。'
        }
        $null
    }
    function Start-CodexProxyRelay {
        param($ProxyMode, $InitialProxyUri)
        if ($ProxyMode -ne $FixtureMode -or $InitialProxyUri -ne 'http://127.0.0.1:7890') { throw '转发层应接收原始 VPN 上游和模式。' }
        $script:relayStarted = $true
        [pscustomobject]@{ ClientProxyUri = $script:clientProxy; UpstreamProxyUri = $InitialProxyUri; StatePath = $script:relayState; ProcessId = 111; InstanceId = 'fixture'; StartedNew = $true }
    }
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, [switch]$PassThru)
        if (-not $script:relayStarted) { throw 'FAIL: Codex 启动前必须建立稳定的本地代理入口。' }
        if ($ArgumentList -ne ('--proxy-server=' + $script:clientProxy)) { throw 'Chromium 没有使用稳定代理入口。' }
        foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
            if ([Environment]::GetEnvironmentVariable($name) -ne $script:clientProxy) { throw "$name 与 Chromium 入口不一致。" }
        }
        [pscustomobject]@{ Id = 54321 }
    }
    function Start-ConnectionWatchdog {
        param($RootProcessId, $CodexExecutable, $ProxyUri, $ProxyMode, $RelayStatePath)
        if ($RootProcessId -ne 54321 -or $ProxyUri -ne $script:clientProxy -or $RelayStatePath -ne $script:relayState -or $ProxyMode -ne $FixtureMode) {
            throw '检测器没有绑定同一客户端入口和转发状态。'
        }
        Write-Host 'ROUTING_VERIFIED'
    }
    $main = $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] } | Select-Object -Last 1
    . ([scriptblock]::Create($main.Extent.Text))
    throw '启动器未按预期退出。'
}
foreach ($mode in @('System', 'Explicit')) {
    $output = & pwsh -NoProfile -File $PSCommandPath -FixtureMode $mode 2>&1
    if ($LASTEXITCODE -ne 0 -or ($output -join "`n") -notmatch 'ROUTING_VERIFIED') { throw "FAIL [$mode]: $output" }
}
Write-Host 'Launcher stable proxy routing tests passed: System and Explicit.'
