$ErrorActionPreference = 'Stop'
$script:Passed = 0
function Assert-Equal($Expected, $Actual, [string]$Name) {
    if ($Expected -ne $Actual) { throw "FAIL [$Name]: expected '$Expected', got '$Actual'" }
    $script:Passed++
}

$projectRoot = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $projectRoot 'ConnectionWatchdog.psm1') -Force
Import-Module (Join-Path $projectRoot 'VpnRecoveryGate.psm1') -Force
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot 'Watch-CodexConnection.ps1'), [ref]$tokens, [ref]$errors)
Assert-Equal 0 $errors.Count 'watchdog syntax'
$loop = $ast.Find({ param($node) $node -is [Management.Automation.Language.WhileStatementAst] -and $node.Extent.Text -match '^while\s*\(\$true\)' }, $true)
$loopBody = [scriptblock]::Create($loop.Extent.Text)

# 执行正式循环和真实状态机/辅助门控；只替换时钟、进程、网络和只读 relay 接口。
$fixture = {
    param($Case, [scriptblock]$Loop)
    $RootProcessId = 100
    $CodexExecutable = 'C:\fixture\ChatGPT.exe'
    $rootStartedAt = [datetime]'2026-10-05T10:00:00Z'
    $clock = $rootStartedAt
    $cycle = 0
    $relayReadCycle = -1
    $relayReadsAtCycle = 0
    $PollSeconds = if ($Case.PollSeconds) { $Case.PollSeconds } else { 60 }
    $OutageSeconds = 180
    $RecoverySeconds = 15
    $VpnAssistCooldownSeconds = 600
    $NoVpnAssist = [bool]$Case.NoVpnAssist
    $ProxyMode = 'System'
    $InitialProxyUri = if ($Case.Relay) { 'http://127.0.0.1:42123' } else { 'http://127.0.0.1:9674' }
    $RelayStatePath = if ($Case.Relay) { 'C:\fixture\relay-state.json' } else { '' }
    $state = New-ConnectionWatchState -InitialProxyUri $InitialProxyUri -Now $clock
    if ($Case.Recovery) {
        $state.Status = 'RecoveryEvaluationRequested'
        $state.PendingProxyUri = $InitialProxyUri
        $state.RecoveryReason = 'LongOutage'
    }
    if ($Case.StartInOutage) {
        $state.Status = 'Outage'
        $state.FailureSince = $clock.AddSeconds(-180)
        $state.RecoveryReason = 'LongOutage'
    }
    $lastInternetProbeAt = [datetime]::MinValue
    $lastProbedProxyUri = $null
    $lastInternetHealthy = $false
    $lastInternetResult = $null
    $lastDiagnosticKey = $null
    $lastDiagnosticAt = [datetime]::MinValue
    $unknownConnectionLogged = $false
    $lastSnapshotFailureAt = [datetime]::MinValue
    $lastNaturalWaitLoggedAt = [datetime]::MinValue
    $lastVpnAssistAt = [datetime]::MinValue
    $vpnFailureSince = $null
    $lastVpnFailureProxy = ''
    $lastSystemProxyKey = $null
    $lastRelayRouteKey = $null
    $messages = [Collections.Generic.List[string]]::new()
    $localTargets = [Collections.Generic.List[string]]::new()
    $probeTargets = [Collections.Generic.List[string]]::new()
    $tcpTargets = [Collections.Generic.List[string]]::new()
    $assists = [Collections.Generic.List[object]]::new()
    function Get-Date { $clock }
    function Get-Process {
        [CmdletBinding()]param([int]$Id)
        if ($cycle -lt $Case.Cycles) { [pscustomobject]@{ Id = $Id; Path = $CodexExecutable; StartTime = $rootStartedAt } }
    }
    function Test-WatchdogRootIdentity { param($Process, $ExecutablePath, $StartedAt) $null -ne $Process }
    function Get-CurrentSystemProxyUri { 'http://127.0.0.1:7890' }
    function Get-CodexProxyRelayStatus {
        param($StatePath, $ExpectedClientProxyUri)
        if ($StatePath -ne $RelayStatePath -or $ExpectedClientProxyUri -ne $InitialProxyUri) { throw 'Wrong relay identity inputs.' }
        if ($Case.RelayThrows) { throw 'fixture reader unavailable' }
        if ($relayReadCycle -ne $cycle) {
            Set-Variable -Name relayReadCycle -Value $cycle -Scope 1
            Set-Variable -Name relayReadsAtCycle -Value 0 -Scope 1
        }
        Set-Variable -Name relayReadsAtCycle -Value ($relayReadsAtCycle + 1) -Scope 1
        $upstream = if ($Case.ChangeUpstream -and $cycle -lt 2) { 'http://127.0.0.1:9674' } else { 'http://127.0.0.1:7890' }
        if ($Case.RelayChangesBeforeAssist -and $relayReadsAtCycle -gt 1) { $upstream = 'http://127.0.0.1:9674' }
        [pscustomobject]@{
            Known = -not $Case.RelayUnknown; Ready = -not $Case.RelayNotReady
            ClientProxyUri = $InitialProxyUri; UpstreamProxyUri = $upstream
            Mode = 'System'; InstanceId = 'fixture-instance'; ProcessId = 200; ErrorKind = 'FixtureUnavailable'
        }
    }
    function Test-LocalProxy {
        param($ProxyUri, $TimeoutMilliseconds)
        $localTargets.Add($ProxyUri)
        $true
    }
    function Get-ProxyInternetStatus {
        param($ProxyUri, $TimeoutMilliseconds)
        $probeTargets.Add($ProxyUri)
        $healthy = [bool]$Case.Healthy -or (-not $Case.Relay -and $ProxyUri -ne $InitialProxyUri)
        [pscustomobject]@{
            Reachable = $healthy; Kind = $(if ($healthy) { 'HttpResponse' } else { 'Timeout' })
            HttpStatus = $(if ($healthy) { 204 } else { $null }); TargetHost = 'fixture.invalid'
            ElapsedMilliseconds = 1; ErrorType = $null; SocketErrorCode = $null
        }
    }
    function Write-WatchdogLog { param($Message, $Level) $messages.Add("$Level $Message") }
    function Start-Sleep {
        param($Seconds)
        Set-Variable -Name clock -Value $clock.AddSeconds($Seconds) -Scope 1
        Set-Variable -Name cycle -Value ($cycle + 1) -Scope 1
    }
    function Get-LiveProcessSnapshot {
        @([pscustomobject]@{ Name = 'ChatGPT.exe'; ProcessId = 100; ParentProcessId = 1; CommandLine = 'ChatGPT.exe' },
          [pscustomobject]@{ Name = 'codex.exe'; ProcessId = 101; ParentProcessId = 100; CommandLine = 'codex.exe app-server' })
    }
    function Get-CodexProxyConnectionStatus {
        param($ProcessIds, $ProxyUri)
        $tcpTargets.Add($ProxyUri)
        [pscustomobject]@{ Known = $true; Connected = $true }
    }
    function Invoke-VpnAutoAssist {
        param($ProxyUri, $ProbeKind, $RootProcessId, $RootStartedAt)
        $assists.Add([pscustomobject]@{ ProxyUri = $ProxyUri; Cycle = $cycle })
        [pscustomobject]@{ Status = 'NativeAutomatic'; Action = 'None'; Client = 'Fixture'; Message = 'fixture result' }
    }
    function Start-Process { throw 'Watcher must never start processes.' }
    function Stop-Process { throw 'Watcher must never stop processes.' }
    . $Loop
    [pscustomobject]@{
        Messages = $messages; State = $state; Cycles = $cycle; InitialProxyUri = $InitialProxyUri
        LocalTargets = $localTargets; ProbeTargets = $probeTargets; TcpTargets = $tcpTargets; Assists = $assists
    }
}

$legacy = & $fixture @{ Cycles = 5; NoVpnAssist = $true } $loopBody
Assert-Equal 0 @($legacy.LocalTargets | Where-Object { $_ -ne $legacy.InitialProxyUri }).Count 'registry change must not retarget client TCP probes'
Assert-Equal 0 @($legacy.ProbeTargets | Where-Object { $_ -ne $legacy.InitialProxyUri }).Count 'healthy unrelated proxy must not hide a failed client route'
Assert-Equal 'Outage' $legacy.State.Status 'legacy client route remains in outage after system proxy changes'
Assert-Equal 1 @($legacy.Messages | Where-Object { $_ -match '正常退出.*重新打开' }).Count 'legacy mismatch explains how new proxy settings take effect once'
Assert-Equal 0 @($legacy.Messages | Where-Object { $_ -match '自然连接新端口|新系统代理' }).Count 'legacy mismatch never promises automatic port migration'

$relay = & $fixture @{ Cycles = 5; Relay = $true } $loopBody
Assert-Equal 0 @($relay.LocalTargets | Where-Object { $_ -ne $relay.InitialProxyUri }).Count 'relay remains the local client probe target'
Assert-Equal 0 @($relay.ProbeTargets | Where-Object { $_ -ne $relay.InitialProxyUri }).Count 'relay remains the HTTP probe target'
Assert-Equal 1 $relay.Assists.Count 'verified upstream can reach the existing long-failure helper gate'
Assert-Equal 'http://127.0.0.1:7890' $relay.Assists[0].ProxyUri 'VPN helper receives verified upstream instead of relay'

$changed = & $fixture @{ Cycles = 6; Relay = $true; ChangeUpstream = $true } $loopBody
Assert-Equal 1 $changed.Assists.Count 'upstream change resets continuous VPN failure duration'
Assert-Equal 5 $changed.Assists[0].Cycle 'replacement upstream must fail for its own full threshold'
Assert-Equal 'http://127.0.0.1:7890' $changed.Assists[0].ProxyUri 'only the current verified upstream reaches helper'

$freshProbe = & $fixture @{ Cycles = 3; Relay = $true; ChangeUpstream = $true; PollSeconds = 3; NoVpnAssist = $true } $loopBody
Assert-Equal 2 $freshProbe.ProbeTargets.Count 'upstream change invalidates cached HTTP result before the normal interval'
$stability = & $fixture @{ Cycles = 6; Relay = $true; ChangeUpstream = $true; PollSeconds = 3; NoVpnAssist = $true; Healthy = $true; StartInOutage = $true } $loopBody
Assert-Equal 'RecoveryPending' $stability.State.Status 'new upstream must complete its own recovery stability window'
Assert-Equal 0 $stability.TcpTargets.Count 'old upstream stability cannot complete recovery on the replacement route'
$race = & $fixture @{ Cycles = 5; Relay = $true; RelayChangesBeforeAssist = $true } $loopBody
Assert-Equal 0 $race.Assists.Count 'upstream changes during helper decision must suppress the stale assist'
Assert-Equal 1 @($race.Messages | Where-Object { $_ -match '上游在辅助检查期间发生变化或失联' }).Count 'racing upstream change is recorded without process mutation'

foreach ($case in @('RelayUnknown', 'RelayNotReady', 'RelayThrows')) {
    $options = @{ Cycles = 5; Relay = $true; Healthy = $true }
    $options[$case] = $true
    $unavailable = & $fixture $options $loopBody
    Assert-Equal 5 $unavailable.Cycles "$case keeps observation alive"
    Assert-Equal 0 $unavailable.Assists.Count "$case suppresses VPN helper"
    Assert-Equal 'Outage' $unavailable.State.Status "$case must not claim verified recovery from an unrelated HTTP response"
    Assert-Equal 0 @($unavailable.ProbeTargets | Where-Object { $_ -ne $unavailable.InitialProxyUri }).Count "$case keeps client route fixed"
}

$recovered = & $fixture @{ Cycles = 2; Relay = $true; Healthy = $true; Recovery = $true; NoVpnAssist = $true } $loopBody
Assert-Equal 'Healthy' $recovered.State.Status 'verified relay transport and client TCP connection complete observation recovery'
Assert-Equal 1 $recovered.TcpTargets.Count 'recovery queries actual client TCP once'
Assert-Equal $recovered.InitialProxyUri $recovered.TcpTargets[0] 'client TCP recovery checks the relay listener'
Assert-Equal 1 @($recovered.Messages | Where-Object { $_ -match '任务是否恢复需以任务响应为准' }).Count 'transport recovery never claims task recovery'
Write-Host "Watchdog proxy routing tests passed. Assertions: $script:Passed"
