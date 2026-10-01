$ErrorActionPreference = 'Stop'
$script:Passed = 0
function Assert-Equal($Expected, $Actual, [string]$Name) {
    if ($Expected -ne $Actual) { throw "FAIL [$Name]: expected '$Expected', got '$Actual'" }
    $script:Passed++
}

$projectRoot = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $projectRoot 'ConnectionWatchdog.psm1') -Force
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot 'Watch-CodexConnection.ps1'), [ref]$tokens, [ref]$errors)
$loop = $ast.Find({ param($node) $node -is [Management.Automation.Language.WhileStatementAst] -and $node.Extent.Text -match '^while\s*\(\$true\)' }, $true)
$loopBody = [scriptblock]::Create($loop.Extent.Text)

# 执行正式监视循环，替换时间、网络与进程查询；任何客户端启动/结束动作立即失败。
$fixture = {
    param($Case, [scriptblock]$Loop)
    $RootProcessId = 100
    $CodexExecutable = 'C:\fixture\ChatGPT.exe'
    $rootStartedAt = [datetime]'2026-10-01T10:00:00Z'
    $clock = $rootStartedAt
    $PollSeconds = 3
    $OutageSeconds = 180
    $RecoverySeconds = 15
    # 此文件专测客户端自然重连；VPN辅助由独立门控/API夹具测试覆盖。
    $NoVpnAssist = $true
    $InitialProxyUri = 'http://127.0.0.1:7890'
    $state = New-ConnectionWatchState -InitialProxyUri $InitialProxyUri -Now $clock
    $state.Status = 'RecoveryEvaluationRequested'
    $state.PendingProxyUri = $InitialProxyUri
    $state.RecoveryReason = 'LongOutage'
    $lastInternetProbeAt = $clock
    $lastProbedProxyUri = $InitialProxyUri
    $lastInternetHealthy = $true
    $lastInternetResult = [pscustomobject]@{ Reachable = $true; Kind = 'HttpResponse'; HttpStatus = 204; TargetHost = 'fixture.invalid'; ElapsedMilliseconds = 1; ErrorType = $null; SocketErrorCode = $null }
    $lastDiagnosticKey = $null
    $lastDiagnosticAt = [datetime]::MinValue
    $unknownConnectionLogged = $false
    $lastSnapshotFailureAt = [datetime]::MinValue
    $lastNaturalWaitLoggedAt = [datetime]::MinValue
    $messages = [Collections.Generic.List[string]]::new()
    $script:fixtureChecks = 0
    function Get-Date { $clock }
    function Get-Process {
        [CmdletBinding()]param([int]$Id)
        $script:fixtureChecks++
        if ($script:fixtureChecks -le 5) { [pscustomobject]@{ Id = $Id; Path = $CodexExecutable; StartTime = $rootStartedAt } }
    }
    function Test-WatchdogRootIdentity { param($Process, $ExecutablePath, $StartedAt) $null -ne $Process }
    function Get-CurrentSystemProxyUri { $InitialProxyUri }
    function Test-LocalProxy { param($ProxyUri, $TimeoutMilliseconds) $true }
    function Get-ProxyInternetStatus { param($ProxyUri, $TimeoutMilliseconds) $lastInternetResult }
    function Write-WatchdogLog { param($Message, $Level) $messages.Add("$Level $Message") }
    function Start-Sleep { param($Seconds) Set-Variable -Name clock -Value $clock.AddSeconds($Seconds) -Scope 1 }
    function Get-LiveProcessSnapshot {
        if ($Case.SnapshotFailure) { throw 'fixture temporary process query failure' }
        @([pscustomobject]@{ Name = 'ChatGPT.exe'; ProcessId = 100; ParentProcessId = 1; CommandLine = 'ChatGPT.exe' },
          [pscustomobject]@{ Name = 'codex.exe'; ProcessId = 101; ParentProcessId = 100; CommandLine = 'codex.exe app-server' })
    }
    function Get-CodexProxyConnectionStatus {
        param($ProcessIds, $ProxyUri)
        [pscustomobject]@{ Known = $Case.ConnectionKnown; Connected = ($Case.ReconnectAfterCycle -and $script:fixtureChecks -ge $Case.ReconnectAfterCycle) }
    }
    function Start-Process { throw 'Observation-only watcher must never start GPT.' }
    function Stop-Process { throw 'Observation-only watcher must never stop GPT.' }
    . $Loop
    [pscustomobject]@{ Messages = $messages; State = $state; Cycles = $script:fixtureChecks }
}

$waiting = & $fixture @{ ConnectionKnown = $true } $loopBody
Assert-Equal 'RecoveryEvaluationRequested' $waiting.State.Status 'missing TCP connection remains a passive recovery wait'
Assert-Equal 6 $waiting.Cycles 'monitor remains alive until the root exits'
Assert-Equal 1 @($waiting.Messages | Where-Object { $_ -match '继续等待其自然恢复' }).Count 'passive wait logging is rate limited'
$reconnected = & $fixture @{ ConnectionKnown = $true; ReconnectAfterCycle = 3 } $loopBody
Assert-Equal 'Healthy' $reconnected.State.Status 'natural connection returns the monitor to healthy'
Assert-Equal 1 @($reconnected.Messages | Where-Object { $_ -match '检测到 GPT 到本地代理的 TCP 连接' }).Count 'natural recovery is recorded once'
$unknown = & $fixture @{ ConnectionKnown = $false } $loopBody
Assert-Equal 'RecoveryEvaluationRequested' $unknown.State.Status 'unknown connection result keeps passive waiting'
Assert-Equal 1 @($unknown.Messages | Where-Object { $_ -match '暂时无法查询 GPT 的 TCP 连接' }).Count 'unknown connection logging is rate limited'
$snapshot = & $fixture @{ ConnectionKnown = $true; SnapshotFailure = $true } $loopBody
Assert-Equal 6 $snapshot.Cycles 'temporary process-snapshot failure does not end the monitor'
Assert-Equal 1 @($snapshot.Messages | Where-Object { $_ -match '暂时无法查询 GPT 子进程' }).Count 'snapshot-error logging is rate limited'
Write-Host "Observation-only watchdog lifecycle tests passed. Assertions: $script:Passed"
