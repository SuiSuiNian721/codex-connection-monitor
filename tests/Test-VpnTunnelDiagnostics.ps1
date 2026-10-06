$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'ConnectionWatchdog.psm1') -Force
Import-Module (Join-Path $root 'VpnRecoveryGate.psm1') -Force
if (-not ('VpnTunnelFixture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading.Tasks;
public sealed class VpnTunnelFixture : IDisposable {
    private readonly TcpListener listener;
    private readonly Task worker;
    public readonly int Port;
    public VpnTunnelFixture(int code) {
        listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        Port = ((IPEndPoint)listener.LocalEndpoint).Port;
        worker = Task.Run(async () => {
            try {
                using (var peer = await listener.AcceptTcpClientAsync())
                using (var stream = peer.GetStream()) {
                    await stream.ReadAsync(new byte[8192], 0, 8192);
                    var bytes = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + " Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    await stream.WriteAsync(bytes, 0, bytes.Length);
                }
            } catch (SocketException) { } catch (ObjectDisposedException) { }
        });
    }
    public void Dispose() { listener.Stop(); worker.Wait(2000); }
}
'@
}
$passed = 0
foreach ($item in @(@{Code=403;Kind='ProxyHttpRestricted'}, @{Code=407;Kind='ProxyAuthenticationRequired'},
    @{Code=429;Kind='ProxyRateLimited'}, @{Code=503;Kind='ProxyServerError'})) {
    $server = [VpnTunnelFixture]::new($item.Code)
    try {
        $proxy = "http://127.0.0.1:$($server.Port)"
        $result = Get-ProxyInternetStatus -ProxyUri $proxy -ProbeUri 'https://probe.invalid/' -TimeoutMilliseconds 2000
        if ($result.Kind -ne $item.Kind -or $result.HttpStatus -ne $item.Code -or $result.Reachable) {
            throw "FAIL: CONNECT $($item.Code) 应分类为 $($item.Kind)，实际 $($result.Kind)/$($result.HttpStatus)"
        }
        $now = Get-Date
        $decision = Get-VpnRecoveryDecision -Status 'Outage' -FailureSince $now.AddSeconds(-180) -Now $now `
            -ProbeKind $result.Kind -LocalProxyHealthy $true -ProxyUri $proxy -ActiveProxyUri $proxy
        if ($decision.ShouldRun) { throw 'FAIL: HTTP CONNECT 拒绝不能触发换节点。' }
        $passed += 2
    }
    finally { $server.Dispose() }
}
Write-Host "VPN tunnel diagnostics passed. Assertions: $passed"
