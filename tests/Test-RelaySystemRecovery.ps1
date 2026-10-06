[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$module = Import-Module (Join-Path $projectRoot 'CodexProxyRelay.psm1') -Force -PassThru
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-relay-system-recovery-' + [guid]::NewGuid().ToString('N'))
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$script:passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:passed++
}

function New-SystemRelayFixture([string]$Name) {
    $directory = Join-Path $fixtureRoot $Name
    [void][IO.Directory]::CreateDirectory($directory)
    $statePath = Join-Path $directory 'service.json'
    $controlPath = Join-Path $directory 'control.txt'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    foreach ($argument in @($script:fixtureScript, (Join-Path $projectRoot 'proxy-relay\relay.mjs'), $statePath, $controlPath)) {
        $startInfo.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::Start($startInfo)
    $ownedProcesses.Add($process)
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 30
        $status = Get-CodexProxyRelayStatus -StatePath $statePath
        if ($status.Known) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    Assert-True ($status.Known -and -not $status.Ready) '真实 System fixture 必须先返回已验证身份、尚未就绪。'
    [pscustomobject]@{ Directory=$directory; StatePath=$statePath; ControlPath=$controlPath; Process=$process; Status=$status }
}

try {
    [void][IO.Directory]::CreateDirectory($fixtureRoot)
    $script:fixtureScript = Join-Path $fixtureRoot 'fixture.mjs'
    @'
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
const [modulePath, stateFile, controlFile] = process.argv.slice(2);
const { createProxyRelay } = await import(pathToFileURL(modulePath));
const upstream = net.createServer(socket => socket.destroy());
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
let changedIdentity = false;
const relay = await createProxyRelay({
  mode: 'System', stateFile, pollIntervalMs: 3000,
  systemProxyResolver: async () => {
    const control = await readFile(controlFile, 'utf8').catch(() => 'disabled');
    if (control === 'ready') return `http://127.0.0.1:${upstream.address().port}`;
    if (control === 'identity' && !changedIdentity) {
      changedIdentity = true;
      setTimeout(async () => {
        const state = JSON.parse(await readFile(stateFile, 'utf8'));
        state.instanceId = 'replacement-identity-000000000000';
        await writeFile(stateFile, JSON.stringify(state), 'utf8');
      }, 25);
    }
    return null;
  },
});
async function close() {
  await relay.close();
  upstream.close();
}
process.once('SIGINT', close);
process.once('SIGTERM', close);
'@ | Set-Content -LiteralPath $script:fixtureScript -Encoding utf8

    # 仅覆盖被测模块作用域，任何意外新增服务都会让测试失败。
    & $module { function script:Start-Process { throw 'Known relay must not start another process.' } }

    $recovering = New-SystemRelayFixture 'recovering'
    [IO.File]::WriteAllText($recovering.ControlPath, 'ready', [Text.UTF8Encoding]::new($false))
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $service = Start-CodexProxyRelay -ProxyMode System -InitialProxyUri 'http://127.0.0.1:7890' -StateDirectory $recovering.Directory
    $timer.Stop()
    Assert-True ($service.ProcessId -eq $recovering.Process.Id -and -not $service.StartedNew) '变为 Ready 后必须复用原进程。'
    Assert-True ($service.InstanceId -ceq $recovering.Status.InstanceId -and $service.ClientProxyUri -ceq $recovering.Status.ClientProxyUri) '等待后必须保留原身份和入口。'
    Assert-True ($timer.Elapsed.TotalSeconds -ge 0.5 -and $timer.Elapsed.TotalSeconds -lt 6.5) '应等待现有轮询生效，并保持约六秒以内的等待上限。'

    $disabled = New-SystemRelayFixture 'disabled'
    $timer.Restart()
    $failure = $null
    try { Start-CodexProxyRelay -ProxyMode System -InitialProxyUri 'http://127.0.0.1:7890' -StateDirectory $disabled.Directory | Out-Null }
    catch { $failure = $_.Exception.Message }
    $timer.Stop()
    Assert-True ($failure -match '尚无可用上游') '持续未就绪必须有界失败，不能创建重复服务。'
    Assert-True ($timer.Elapsed.TotalSeconds -ge 3.5 -and $timer.Elapsed.TotalSeconds -lt 6.5) '持续未就绪也必须遵守查询预算和等待上限。'

    $changed = New-SystemRelayFixture 'identity'
    [IO.File]::WriteAllText($changed.ControlPath, 'identity', [Text.UTF8Encoding]::new($false))
    $failure = $null
    try { Start-CodexProxyRelay -ProxyMode System -InitialProxyUri 'http://127.0.0.1:7890' -StateDirectory $changed.Directory | Out-Null }
    catch { $failure = $_.Exception.Message }
    Assert-True ($failure -match '身份|配置') '等待中身份变化必须失败，不能接受新的实例。'

    $failure = $null
    try { Start-CodexProxyRelay -ProxyMode Explicit -InitialProxyUri $service.UpstreamProxyUri -StateDirectory $recovering.Directory | Out-Null }
    catch { $failure = $_.Exception.Message }
    Assert-True ($failure -match '其他代理配置') '已有入口模式不匹配必须继续拒绝。'
    Write-Host "System relay recovery tests passed. Assertions: $script:passed"
}
finally {
    foreach ($owned in $ownedProcesses) {
        $owned.Refresh()
        if (-not $owned.HasExited) { $owned.Kill(); [void]$owned.WaitForExit(5000) }
        $owned.Dispose()
    }
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'codex-relay-system-recovery-*') { throw '测试目录边界无效。' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
