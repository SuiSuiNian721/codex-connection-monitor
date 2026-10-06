$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'ConnectionWatchdog.psm1') -Force
Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'VpnRecoveryGate.psm1') -Force

if (-not (Get-Command Get-ProxyInternetStatus -ErrorAction SilentlyContinue)) {
    throw 'FAIL: 网络探测必须返回故障类别、HTTP 状态和耗时，不能只返回布尔值。'
}

$script:passed = 0
function Assert-Equal($Expected, $Actual, [string]$Name) {
    if ($Expected -ne $Actual) { throw "FAIL [$Name]: expected '$Expected', got '$Actual'" }
    $script:passed++
}

# 本地假代理只响应测试请求，不访问互联网，也不需要管理员权限。
if (-not ('ConnectionProbeFixture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
public sealed class ConnectionProbeFixture : IDisposable {
    private readonly TcpListener listener;
    private readonly Task worker;
    public readonly int Port;
    public ConnectionProbeFixture(int code, int delayMs) {
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        worker = Task.Run(async () => {
            try {
                using (var peer = await listener.AcceptTcpClientAsync())
                using (var stream = peer.GetStream()) {
                    await stream.ReadAsync(new byte[8192], 0, 8192);
                    if (delayMs > 0) await Task.Delay(delayMs);
                    string location = code == 302 ? "Location: http://127.0.0.1:1/should-not-follow\r\n" : "";
                    byte[] response = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + " Test\r\n" + location + "Content-Length: 0\r\nConnection: close\r\n\r\n");
                    await stream.WriteAsync(response, 0, response.Length);
                }
            } catch (Exception) { }
        });
    }
    public void Dispose() { listener.Stop(); worker.Wait(2000); }
}
'@
}

foreach ($case in @(
    @{ Code = 204; Kind = 'HttpResponse'; Reachable = $true }
    @{ Code = 302; Kind = 'HttpResponse'; Reachable = $true }
    @{ Code = 403; Kind = 'HttpRestricted'; Reachable = $true }
    @{ Code = 407; Kind = 'ProxyAuthenticationRequired'; Reachable = $false }
    @{ Code = 429; Kind = 'RateLimited'; Reachable = $true }
    @{ Code = 503; Kind = 'ServerError'; Reachable = $true }
)) {
    $server = [ConnectionProbeFixture]::new($case.Code, 0)
    try {
        $result = Get-ProxyInternetStatus -ProxyUri "http://127.0.0.1:$($server.Port)" -ProbeUri 'http://probe.invalid/check?private=do-not-log' -TimeoutMilliseconds 2000
        Assert-Equal $case.Kind $result.Kind "HTTP $($case.Code) classification"
        Assert-Equal $case.Code $result.HttpStatus "HTTP $($case.Code) status retained"
        Assert-Equal $case.Reachable $result.Reachable "HTTP $($case.Code) transport meaning"
        Assert-Equal 'probe.invalid' $result.TargetHost 'only target host is retained'
        Assert-Equal $false (($result | ConvertTo-Json -Compress) -match 'do-not-log') 'query is not logged'
    }
    finally { $server.Dispose() }
}

$server = [ConnectionProbeFixture]::new(204, 600)
try {
    $result = Get-ProxyInternetStatus -ProxyUri "http://127.0.0.1:$($server.Port)" -ProbeUri 'http://probe.invalid/' -TimeoutMilliseconds 150
    Assert-Equal 'Timeout' $result.Kind 'silent proxy has a distinct timeout result'
    Assert-Equal $false $result.Reachable 'timeout is not reachable'
    Assert-Equal $true ($result.ElapsedMilliseconds -ge 100) 'elapsed time is recorded'
}
finally { $server.Dispose() }

$result = Get-ProxyInternetStatus -ProxyUri 'socks5://127.0.0.1:1'
Assert-Equal 'InvalidProxy' $result.Kind 'unsupported proxy fails closed'
Assert-Equal $false (Test-ProxyInternet -ProxyUri 'socks5://127.0.0.1:1') 'existing boolean API is preserved'
$result = Get-ProxyInternetStatus -ProxyUri 'http://127.0.0.1:1' -ProbeUri 'file:///C:/Windows/win.ini'
Assert-Equal 'InvalidTarget' $result.Kind 'probe does not read local files'

$server = [ConnectionProbeFixture]::new(403, 0)
try {
    Assert-Equal $true (Test-ProxyInternet -ProxyUri "http://127.0.0.1:$($server.Port)" -ProbeUri 'http://probe.invalid/') 'HTTP 403 is not a network outage'
}
finally { $server.Dispose() }

Assert-Equal 30 (Get-ConnectionProbeIntervalSeconds -Status 'Healthy' -PollSeconds 3) 'healthy uses low frequency'
Assert-Equal 30 (Get-ConnectionProbeIntervalSeconds -Status 'Outage' -PollSeconds 3) 'continuous outage does not hammer TLS'
Assert-Equal 10 (Get-ConnectionProbeIntervalSeconds -Status 'Suspect' -PollSeconds 3) 'suspect connection is checked sooner'
Assert-Equal 3 (Get-ConnectionProbeIntervalSeconds -Status 'RecoveryPending' -PollSeconds 3) 'recovery stability still samples every poll'
Assert-Equal 30 (Get-ConnectionProbeIntervalSeconds -Status 'RecoveryEvaluationRequested' -PollSeconds 3) 'passive natural-recovery wait does not hammer HTTP probes'
Assert-Equal 45 (Get-ConnectionProbeIntervalSeconds -Status 'Healthy' -PollSeconds 45) 'probe interval cannot be shorter than the poll'

$watchdog = Get-Content -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'Watch-CodexConnection.ps1') -Raw -Encoding utf8
Assert-Equal $true ($watchdog -match 'Get-ProxyInternetStatus -ProxyUri \$proxyUri -TimeoutMilliseconds 8000') 'live watchdog uses structured diagnostics and an eight-second timeout'
Assert-Equal $true ($watchdog -match 'Get-ConnectionProbeIntervalSeconds -Status \$state.Status -PollSeconds \$PollSeconds') 'live watchdog uses the bounded probe schedule'
Assert-Equal $true ($watchdog -match '\$lastInternetProbeAt = Get-Date') 'probe age starts at completion, not before the network wait'
Assert-Equal $true ($watchdog -match 'ProbeKind=') 'live watchdog records the diagnostic category'

# 直接执行正式脚本的一轮监视循环；代理、进程和睡眠均使用本地替身，不碰正在运行的 GPT。
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($watchdog, [ref]$tokens, [ref]$parseErrors)
Assert-Equal 0 $parseErrors.Count 'watchdog syntax is valid'
$loopAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.WhileStatementAst] -and $node.Extent.Text -match '^while\s*\(\$true\)' }, $true)
$loopBody = [scriptblock]::Create($loopAst.Extent.Text)
$identityAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-WatchdogRootIdentity' }, $true)
. ([scriptblock]::Create($identityAst.Extent.Text))
$runOneCycle = {
    param($Mock, [scriptblock]$Loop)
    $RootProcessId = 999999
    $CodexExecutable = 'C:\fixture\ChatGPT.exe'
    $rootStartedAt = Get-Date
    $PollSeconds = 3
    $OutageSeconds = 180
    $RecoverySeconds = 15
    $NoVpnAssist = $false
    $VpnAssistCooldownSeconds = 600
    $lastVpnAssistAt = [datetime]::MinValue
    $vpnFailureSince = $null
    $lastVpnFailureProxy = ''
    $InitialProxyUri = 'http://127.0.0.1:7890'
    $ProxyMode = 'System'
    $RelayStatePath = ''
    $state = New-ConnectionWatchState -InitialProxyUri $InitialProxyUri -Now (Get-Date)
    $lastInternetProbeAt = [datetime]::MinValue
    $lastProbedProxyUri = 'http://127.0.0.1:7890'
    $lastInternetHealthy = $true
    $lastInternetResult = $Mock.Result
    $lastDiagnosticKey = $null
    $lastDiagnosticAt = [datetime]::MinValue
    $checks = [Collections.Generic.Queue[bool]]::new()
    $checks.Enqueue($true)
    $checks.Enqueue($false)
    $messages = [Collections.Generic.List[string]]::new()
    $timeouts = [Collections.Generic.List[int]]::new()
    function Get-Process {
        [CmdletBinding()]param([int]$Id)
        if ($checks.Dequeue()) { [pscustomobject]@{ Id = $Id; Path = $CodexExecutable; StartTime = $rootStartedAt } }
    }
    function Get-CurrentSystemProxyUri { $Mock.ProxyUri }
    function Test-LocalProxy { param($ProxyUri, $TimeoutMilliseconds) $Mock.LocalHealthy }
    function Get-ProxyInternetStatus {
        param($ProxyUri, [int]$TimeoutMilliseconds)
        $timeouts.Add($TimeoutMilliseconds)
        $Mock.Result
    }
    function Write-WatchdogLog { param($Message, $Level) $messages.Add("$Level $Message") }
    function Start-Sleep { param($Seconds) }
    function Get-LiveProcessSnapshot { throw 'Test must not query real processes.' }
    function Start-Process { throw 'Observation-only test must never start GPT.' }
    function Stop-Process { throw 'Observation-only test must never stop GPT.' }
    . $Loop
    [pscustomobject]@{ Messages = $messages; Timeouts = $timeouts; State = $state; LastProxy = $lastProbedProxyUri }
}
$httpResult = [pscustomobject]@{ Reachable = $true; Kind = 'HttpRestricted'; HttpStatus = 403; TargetHost = 'chatgpt.com'; ElapsedMilliseconds = 900; ErrorType = $null; SocketErrorCode = $null }
foreach ($case in @(
    @{ ProxyUri = 'http://127.0.0.1:7890'; LocalHealthy = $true; Result = $httpResult; Kind = 'HttpRestricted'; State = 'Healthy'; Probes = 1 }
    @{ ProxyUri = $null; LocalHealthy = $false; Result = $httpResult; Kind = 'LocalProxyUnavailable'; State = 'Suspect'; Probes = 0 }
    @{ ProxyUri = $null; LocalHealthy = $true; Result = $httpResult; Kind = 'HttpRestricted'; State = 'Healthy'; Probes = 1 }
    @{ ProxyUri = 'http://127.0.0.1:7890'; LocalHealthy = $false; Result = $httpResult; Kind = 'LocalProxyUnavailable'; State = 'Suspect'; Probes = 0 }
    @{ ProxyUri = 'http://127.0.0.1:7890'; LocalHealthy = $true; Result = [pscustomobject]@{ Reachable = $false; Kind = 'Timeout'; HttpStatus = $null; TargetHost = 'chatgpt.com'; ElapsedMilliseconds = 8000; ErrorType = 'System.TimeoutException'; SocketErrorCode = $null }; Kind = 'Timeout'; State = 'Suspect'; Probes = 1 }
)) {
    $cycle = & $runOneCycle $case $loopBody
    Assert-Equal $case.State $cycle.State.Status "cycle $($case.Kind) state"
    Assert-Equal $case.Probes $cycle.Timeouts.Count "cycle $($case.Kind) probe count"
    Assert-Equal $true (($cycle.Messages -join '\n') -match "ProbeKind=$($case.Kind)") "cycle $($case.Kind) diagnostic log"
    if ($case.Probes -gt 0) { Assert-Equal 8000 $cycle.Timeouts[0] 'runtime timeout is eight seconds' }
    else { Assert-Equal '' ([string]$cycle.LastProxy) 'local outage invalidates the cached remote result' }
}

Write-Host "Connection diagnostics tests passed. Assertions: $script:passed"
