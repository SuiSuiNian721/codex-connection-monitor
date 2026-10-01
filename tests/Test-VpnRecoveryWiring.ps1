$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$watch = Get-Content -LiteralPath (Join-Path $root 'Watch-CodexConnection.ps1') -Raw -Encoding utf8
foreach ($pattern in @('VpnRecoveryGate\.psm1', '\$NoVpnAssist', '\$VpnAssistCooldownSeconds\s*=\s*600',
    'Get-VpnRecoveryDecision', 'Invoke-VpnAutoAssist', '\$lastVpnAssistAt\s*=\s*Get-Date')) {
    if ($watch -notmatch $pattern) { throw "FAIL: 监测器缺少长故障接线 $pattern" }
}
if ($watch -match 'Stop-Process|Start-Process|PUT\s+/configs|ForceSet|restartCore') {
    throw 'FAIL: 监测器不能重启客户端、重载VPN或解除人工固定。'
}
$gate = Get-Content -LiteralPath (Join-Path $root 'VpnRecoveryGate.psm1') -Raw -Encoding utf8
if ($gate -notmatch 'CreateNoWindow\s*=\s*\$true' -or $gate -notmatch 'RedirectStandardError\s*=\s*\$true') {
    throw 'FAIL: helper必须隐藏启动，并隔离原始错误输出。'
}
Write-Host 'VPN recovery wiring tests passed.'
