$ErrorActionPreference = 'Stop'
$script:Passed = 0

function Assert-Equal {
    param($Expected, $Actual, [string]$Name)
    if ($Expected -ne $Actual) {
        throw "FAIL [$Name]: expected '$Expected', got '$Actual'"
    }
    $script:Passed++
}

$projectRoot = Split-Path $PSScriptRoot -Parent
$modulePath = Join-Path $projectRoot 'ConnectionWatchdog.psm1'
Import-Module $modulePath -Force

$start = [datetime]'2026-08-18T10:00:00'
$activeProxy = 'http://127.0.0.1:9674'
$changedProxy = 'http://127.0.0.1:7890'

$shortState = New-ConnectionWatchState -InitialProxyUri $activeProxy -Now $start
$shortResult = Update-ConnectionWatchState -State $shortState -IsHealthy $false -ProxyUri $activeProxy -Now $start -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $shortResult.Action 'first failure does not recover'
Assert-Equal 'Suspect' $shortResult.State.Status 'first failure enters suspect state'

$shortResult = Update-ConnectionWatchState -State $shortResult.State -IsHealthy $false -ProxyUri $activeProxy -Now $start.AddSeconds(30) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $shortResult.Action 'thirty seconds does not declare a long outage'
Assert-Equal 'Suspect' $shortResult.State.Status 'thirty seconds remains suspect'

$shortResult = Update-ConnectionWatchState -State $shortResult.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddSeconds(31) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $shortResult.Action 'short outage recovers without process recovery'
Assert-Equal 'Healthy' $shortResult.State.Status 'short outage returns directly to healthy'

$longState = New-ConnectionWatchState -InitialProxyUri $activeProxy -Now $start
$longResult = Update-ConnectionWatchState -State $longState -IsHealthy $false -ProxyUri $activeProxy -Now $start -OutageSeconds 180 -RecoverySeconds 15
$longResult = Update-ConnectionWatchState -State $longResult.State -IsHealthy $false -ProxyUri $activeProxy -Now $start.AddSeconds(179) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $longResult.Action '179 seconds does not declare a long outage'
Assert-Equal 'Suspect' $longResult.State.Status '179 seconds remains suspect'

$longResult = Update-ConnectionWatchState -State $longResult.State -IsHealthy $false -ProxyUri $activeProxy -Now $start.AddSeconds(180) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'LongOutageDetected' $longResult.Action '180 seconds declares a long outage'
Assert-Equal 'Outage' $longResult.State.Status 'long outage state is recorded'

$longResult = Update-ConnectionWatchState -State $longResult.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddSeconds(200) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $longResult.Action 'first healthy sample starts stability timer'
Assert-Equal 'RecoveryPending' $longResult.State.Status 'long outage waits for stable recovery'
Assert-Equal 'LongOutage' $longResult.State.RecoveryReason 'long outage recovery reason is preserved'

$longResult = Update-ConnectionWatchState -State $longResult.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddSeconds(214) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $longResult.Action 'fourteen stable seconds is insufficient'

$longResult = Update-ConnectionWatchState -State $longResult.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddSeconds(215) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'EvaluateRecovery' $longResult.Action 'fifteen stable seconds requests passive recovery evaluation'
Assert-Equal 'RecoveryEvaluationRequested' $longResult.State.Status 'recovery evaluation is emitted once'

$repeat = Update-ConnectionWatchState -State $longResult.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddSeconds(218) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $repeat.Action 'recovery evaluation is not emitted twice'

$completed = Complete-ConnectionRecovery -State $repeat.State -ProxyUri $activeProxy -Now $start.AddSeconds(220)
Assert-Equal 'Healthy' $completed.Status 'completed recovery returns healthy'
Assert-Equal $activeProxy $completed.ActiveProxyUri 'completed recovery stores proxy'
Assert-Equal '' ([string]$completed.RecoveryReason) 'completed recovery clears recovery reason'

$changed = Update-ConnectionWatchState -State $completed -IsHealthy $true -ProxyUri $changedProxy -Now $start.AddMinutes(4) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'RecoveryPending' $changed.State.Status 'healthy proxy endpoint change waits for stability'
Assert-Equal 'ProxyChanged' $changed.State.RecoveryReason 'proxy endpoint change records its reason'
Assert-Equal 'None' $changed.Action 'proxy endpoint change does not restart immediately'

$changed = Update-ConnectionWatchState -State $changed.State -IsHealthy $true -ProxyUri $changedProxy -Now $start.AddMinutes(4).AddSeconds(14) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'None' $changed.Action 'fourteen stable seconds does not accept a new proxy'

$changed = Update-ConnectionWatchState -State $changed.State -IsHealthy $true -ProxyUri $changedProxy -Now $start.AddMinutes(4).AddSeconds(15) -OutageSeconds 180 -RecoverySeconds 15
Assert-Equal 'EvaluateRecovery' $changed.Action 'stable proxy endpoint change requests recovery evaluation'
Assert-Equal 'RecoveryEvaluationRequested' $changed.State.Status 'stable proxy change enters evaluation state'

# 切换代理时的短暂端口波动不能绕过 180 秒长断线阈值。
$flapping = Update-ConnectionWatchState -State $completed -IsHealthy $true -ProxyUri $changedProxy -Now $start.AddMinutes(5)
$flapping = Update-ConnectionWatchState -State $flapping.State -IsHealthy $false -ProxyUri $changedProxy -Now $start.AddMinutes(5).AddSeconds(2)
Assert-Equal 'Suspect' $flapping.State.Status 'proxy-change failure starts a new suspect period'
$flapping = Update-ConnectionWatchState -State $flapping.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddMinutes(5).AddSeconds(3)
Assert-Equal 'Healthy' $flapping.State.Status 'brief failed proxy change can return to the active endpoint without restart'
Assert-Equal 'None' $flapping.Action 'brief failed proxy change does not evaluate full recovery'

# 已确认的长断线即使期间换过端口，也不能因为端口返回旧值丢掉恢复检查。
$returned = Update-ConnectionWatchState -State $longResult.State -IsHealthy $true -ProxyUri $changedProxy -Now $start.AddMinutes(6)
$returned = Update-ConnectionWatchState -State $returned.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddMinutes(6).AddSeconds(1)
Assert-Equal 'RecoveryPending' $returned.State.Status 'returning endpoint retains long-outage recovery requirement'
$returned = Update-ConnectionWatchState -State $returned.State -IsHealthy $true -ProxyUri $activeProxy -Now $start.AddMinutes(6).AddSeconds(16)
Assert-Equal 'EvaluateRecovery' $returned.Action 'long-outage endpoint return still evaluates recovery'

$processes = @(
    [pscustomobject]@{ Name = 'ChatGPT.exe'; ProcessId = 100; ParentProcessId = 1; CommandLine = 'ChatGPT.exe --proxy-server=http://127.0.0.1:7890' }
    [pscustomobject]@{ Name = 'ChatGPT.exe'; ProcessId = 101; ParentProcessId = 100; CommandLine = 'ChatGPT.exe --utility-sub-type=network.mojom.NetworkService' }
    [pscustomobject]@{ Name = 'codex.exe'; ProcessId = 102; ParentProcessId = 100; CommandLine = 'codex.exe app-server' }
    [pscustomobject]@{ Name = 'codex-code-mode-host.exe'; ProcessId = 103; ParentProcessId = 102; CommandLine = 'codex-code-mode-host.exe' }
    [pscustomobject]@{ Name = 'codex-command-runner.exe'; ProcessId = 104; ParentProcessId = 102; CommandLine = 'codex-command-runner.exe' }
    [pscustomobject]@{ Name = 'codex.exe'; ProcessId = 105; ParentProcessId = 102; CommandLine = 'codex.exe exec "another task"' }
    [pscustomobject]@{ Name = 'ChatGPT.exe'; ProcessId = 200; ParentProcessId = 1; CommandLine = 'ChatGPT.exe --proxy-server=http://127.0.0.1:9674' }
    [pscustomobject]@{ Name = 'ChatGPT.exe'; ProcessId = 201; ParentProcessId = 200; CommandLine = 'ChatGPT.exe --utility-sub-type=network.mojom.NetworkService' }
    [pscustomobject]@{ Name = 'codex.exe'; ProcessId = 202; ParentProcessId = 200; CommandLine = 'codex.exe app-server' }
)

$descendants = @(Get-DescendantProcessIds -Processes $processes -RootProcessId 100 | Sort-Object)
Assert-Equal '101,102,103,104,105' ($descendants -join ',') 'descendants are isolated to selected root'

$targets = @(Get-CodexConnectionTargets -Processes $processes -RootProcessId 100 | Sort-Object ProcessId)
Assert-Equal '101,102' (($targets | Select-Object -ExpandProperty ProcessId) -join ',') 'connection check selects only network and app-server targets'
Assert-Equal $false (Test-ProxyInternet -ProxyUri 'socks5://127.0.0.1:7890' -TimeoutMilliseconds 100) 'unsupported proxy probe fails closed'

Write-Host "Connection watchdog state tests passed. Assertions: $script:Passed"
