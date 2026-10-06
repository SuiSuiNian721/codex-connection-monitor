[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$modulePath = Join-Path $projectRoot 'CodexProxyRelay.psm1'
if (-not (Test-Path -LiteralPath $modulePath)) { throw 'FAIL: 缺少稳定代理入口的启动和身份校验模块。' }
Import-Module $modulePath -Force

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-relay-launcher-' + [guid]::NewGuid().ToString('N'))
$fakeProxy = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$ownedProcesses = [Collections.Generic.List[object]]::new()
$passed = 0
function Assert-True([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAIL: $Message" }
    $script:passed++
}
try {
    foreach ($endpoint in @('http://127.0.0.1:80', 'https://localhost:443', 'http://[::1]:80')) {
        $normalized = & (Get-Module CodexProxyRelay) { param($Value) ConvertTo-RelayEndpoint $Value } $endpoint
        Assert-True ($normalized -ceq $endpoint) '默认 HTTP/HTTPS 端口也必须显式传给转发程序。'
    }
    $fakeProxy.Start()
    $upstream = 'http://127.0.0.1:' + $fakeProxy.LocalEndpoint.Port
    $stateDirectory = Join-Path $fixtureRoot 'state with spaces'
    $dryRun = Start-CodexProxyRelay -ProxyMode Explicit -InitialProxyUri $upstream -StateDirectory $stateDirectory -DryRun
    Assert-True $dryRun.DryRun 'DryRun 应返回预检结果。'
    Assert-True (-not (Test-Path -LiteralPath $stateDirectory)) 'DryRun 不得创建目录或启动服务。'

    $service = Start-CodexProxyRelay -ProxyMode Explicit -InitialProxyUri $upstream -StateDirectory $stateDirectory
    $ownedProcesses.Add((Get-Process -Id $service.ProcessId))
    Assert-True ($service.ClientProxyUri -ne $upstream) '客户端入口与 VPN 上游应分离。'
    $status = Get-CodexProxyRelayStatus -StatePath $service.StatePath -ExpectedClientProxyUri $service.ClientProxyUri
    Assert-True ($status.Known -and $status.Ready) '需要通过带身份校验的实时状态确认服务。'
    Assert-True ($status.UpstreamProxyUri -eq $upstream) '显式上游不得被真实系统代理替换。'

    $reused = Start-CodexProxyRelay -ProxyMode Explicit -InitialProxyUri $upstream -StateDirectory $stateDirectory
    Assert-True ($reused.ProcessId -eq $service.ProcessId) '重复启动应复用同一服务。'
    $mismatch = Get-CodexProxyRelayStatus -StatePath $service.StatePath -ExpectedClientProxyUri 'http://127.0.0.1:1'
    Assert-True (-not $mismatch.Known) '不能把其他入口的状态用于当前 Codex。'

    $manifest = Get-Content -LiteralPath $service.StatePath -Raw -Encoding utf8 | ConvertFrom-Json
    $tamperedPath = Join-Path $fixtureRoot 'tampered.json'
    $manifest.statusToken = 'incorrect-test-token'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tamperedPath -Encoding utf8
    $tampered = Get-CodexProxyRelayStatus -StatePath $tamperedPath -ExpectedClientProxyUri $service.ClientProxyUri
    Assert-True (-not $tampered.Known) '错误凭据不能通过服务身份验证。'

    $manifest.statusUri = 'http://example.invalid/status'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tamperedPath -Encoding utf8
    $unsafe = Get-CodexProxyRelayStatus -StatePath $tamperedPath -ExpectedClientProxyUri $service.ClientProxyUri
    Assert-True (-not $unsafe.Known) '状态文件不得让监测器访问非本机地址。'

    Stop-Process -Id $service.ProcessId -ErrorAction Stop
    $ownedProcesses[0].WaitForExit(5000) | Out-Null
    $fixtureApp = 'C:\fixture\ChatGPT.exe'
    $otherBinding = @([pscustomobject]@{ ExecutablePath = $fixtureApp; CommandLine = 'ChatGPT.exe --proxy-server=http://127.0.0.1:1' })
    $ignored = Restore-CodexProxyRelay -CodexExecutable $fixtureApp -ProxyMode Explicit -InitialProxyUri $upstream -StateDirectory $stateDirectory -Processes $otherBinding
    Assert-True ($null -eq $ignored) '旧会话使用其他入口时，不得擅自创建或替换代理。'
    $matchingBinding = @([pscustomobject]@{ ExecutablePath = $fixtureApp; CommandLine = ('ChatGPT.exe --proxy-server=' + $service.ClientProxyUri) })
    $restored = Restore-CodexProxyRelay -CodexExecutable $fixtureApp -ProxyMode Explicit -InitialProxyUri $upstream -StateDirectory $stateDirectory -Processes $matchingBinding
    $ownedProcesses.Add((Get-Process -Id $restored.ProcessId))
    Assert-True ($restored.ClientProxyUri -eq $service.ClientProxyUri) '转发器恢复后必须保留原客户端端口。'
    Assert-True ($restored.ProcessId -ne $service.ProcessId) '测试应真正恢复一个新转发进程。'
    $status = Get-CodexProxyRelayStatus -StatePath $restored.StatePath -ExpectedClientProxyUri $service.ClientProxyUri
    Assert-True ($status.Known -and $status.Ready) '恢复后的实例应重新通过身份校验。'
    Write-Host "Proxy relay launcher tests passed. Assertions: $passed"
}
finally {
    foreach ($owned in $ownedProcesses) {
        $owned.Refresh()
        if (-not $owned.HasExited) { $owned.Kill(); $owned.WaitForExit(5000) | Out-Null }
        $owned.Dispose()
    }
    $fakeProxy.Stop()
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'codex-relay-launcher-*') { throw '测试目录边界无效。' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
