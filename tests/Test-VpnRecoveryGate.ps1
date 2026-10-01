$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$module = Join-Path $root 'VpnRecoveryGate.psm1'
if (-not (Test-Path -LiteralPath $module)) { throw 'FAIL: 长期故障恢复门控模块尚未实现。' }
Import-Module $module -Force

$script:passed = 0
function Assert-Equal($Expected, $Actual, [string]$Name) {
    if ($Expected -ne $Actual) { throw "FAIL [$Name]: expected '$Expected', got '$Actual'" }
    $script:passed++
}
$now = [datetime]'2026-10-01T22:00:00'
$base = @{
    Status = 'Outage'; FailureSince = $now.AddSeconds(-180); Now = $now
    OutageSeconds = 180; CooldownSeconds = 600; LastAttemptAt = [datetime]::MinValue
    ProbeKind = 'Timeout'; LocalProxyHealthy = $true
    ProxyUri = 'http://127.0.0.1:7890'; ActiveProxyUri = 'http://127.0.0.1:7890'
}
Assert-Equal $true (Get-VpnRecoveryDecision @base).ShouldRun '长时间硬故障允许评估'
foreach ($kind in @('Timeout','TlsFailure','ConnectionFailure','NameResolutionFailure','ResponseFailure')) {
    $args = $base.Clone(); $args.ProbeKind = $kind
    Assert-Equal $true (Get-VpnRecoveryDecision @args).ShouldRun "硬故障 $kind"
}
foreach ($kind in @('HttpResponse','HttpRestricted','RateLimited','ServerError','ProxyAuthenticationRequired','ProxyTunnelFailure','RequestFailure','InvalidProxy','NotProbed')) {
    $args = $base.Clone(); $args.ProbeKind = $kind
    Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun "不因 $kind 切节点"
}
foreach ($seconds in @(0,30,179)) {
    $args = $base.Clone(); $args.FailureSince = $now.AddSeconds(-$seconds)
    Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun "短故障 $seconds"
}
foreach ($status in @('Healthy','Suspect','RecoveryPending','RecoveryEvaluationRequested')) {
    $args = $base.Clone(); $args.Status = $status
    Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun "不在 $status 操作"
}
$args = $base.Clone(); $args.LocalProxyHealthy = $false
Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun 'VPN本地服务关闭不切远端'
Assert-Equal 'LocalProxyUnavailable' (Get-VpnRecoveryDecision @args).Reason '本地故障有明确原因'
$args = $base.Clone(); $args.LastAttemptAt = $now.AddSeconds(-599)
Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun '恢复调用有冷却'
$args.LastAttemptAt = $now.AddSeconds(-600)
Assert-Equal $true (Get-VpnRecoveryDecision @args).ShouldRun '冷却边界允许评估'
$args = $base.Clone(); $args.ProxyUri = 'http://127.0.0.1:9674'
Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun '不操作Codex尚未接入的新代理端口'
$args = $base.Clone(); $args.FailureSince = $null
Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun '未知故障起点拒绝操作'
$args = $base.Clone(); $args.FailureSince = $now.AddSeconds(1)
Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun '时钟倒退拒绝操作'

$missing = Invoke-VpnAutoAssist -ProxyUri $base.ProxyUri -ProbeKind 'Timeout' -HelperPath (Join-Path $PSScriptRoot 'not-existing-vpn-helper.exe')
Assert-Equal 'HelperUnavailable' $missing.Status '缺helper安全降级'
Assert-Equal 'None' $missing.Action '缺helper无动作'
$since = Update-VpnTransportFailureSince -FailureSince $null -Now $now -ProbeKind 'Timeout' -LocalProxyHealthy $true -ProxyUri $base.ProxyUri -PreviousProxyUri $base.ProxyUri
Assert-Equal $now $since '独立连续硬故障时钟开始'
$since = Update-VpnTransportFailureSince -FailureSince $since -Now $now.AddSeconds(200) -ProbeKind 'RateLimited' -LocalProxyHealthy $true -ProxyUri $base.ProxyUri -PreviousProxyUri $base.ProxyUri
Assert-Equal $null $since '429重置硬故障时钟'
$later = $now.AddSeconds(600)
$since = Update-VpnTransportFailureSince -FailureSince $since -Now $later -ProbeKind 'Timeout' -LocalProxyHealthy $true -ProxyUri $base.ProxyUri -PreviousProxyUri $base.ProxyUri
Assert-Equal $later $since '恢复后的新故障不得复用旧起点'
$args = $base.Clone(); $args.Now = $later.AddSeconds(179); $args.FailureSince = $since
Assert-Equal $false (Get-VpnRecoveryDecision @args).ShouldRun '新一轮需重新连续180秒'
foreach ($kind in @('HttpResponse','HttpRestricted','ServerError','ProxyAuthenticationRequired','NotProbed')) {
    Assert-Equal $null (Update-VpnTransportFailureSince -FailureSince $now -Now $later -ProbeKind $kind -LocalProxyHealthy $true -ProxyUri $base.ProxyUri -PreviousProxyUri $base.ProxyUri) "重置 $kind"
}
Assert-Equal $later (Update-VpnTransportFailureSince -FailureSince $now -Now $later -ProbeKind 'Timeout' -LocalProxyHealthy $true -ProxyUri 'http://127.0.0.1:9674' -PreviousProxyUri $base.ProxyUri) '新代理使用独立起点'
Write-Host "VPN recovery gate tests passed. Assertions: $script:passed"
