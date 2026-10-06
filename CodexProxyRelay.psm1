Set-StrictMode -Version 2.0
$script:RelayRoot = $PSScriptRoot

function ConvertTo-RelayEndpoint {
    param([AllowEmptyString()][string]$Value)
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or $uri.Port -lt 1 -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { return $null }
    if ($uri.DnsSafeHost -notin @('127.0.0.1', 'localhost', '::1')) { return $null }
    $hostPart = if ($uri.DnsSafeHost -eq '::1') { '[::1]' } else { $uri.DnsSafeHost.ToLowerInvariant() }
    '{0}://{1}:{2}' -f $uri.Scheme, $hostPart, $uri.Port
}

function Read-RelayManifest {
    param([string]$StatePath)
    try {
        $item = Get-Item -LiteralPath $StatePath -ErrorAction Stop
        if ($item.PSIsContainer -or $item.Length -gt 16384 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
        $data = Get-Content -LiteralPath $StatePath -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
        if ($data.service -cne 'codex-proxy-relay' -or $data.version -ne 1 -or
            $data.pid -lt 1 -or $data.instanceId -notmatch '^[a-zA-Z0-9-]{16,80}$' -or
            $data.statusToken -notmatch '^[a-zA-Z0-9_-]{32,128}$' -or
            $data.mode -notin @('System', 'Explicit') -or
            $data.statusUri -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}/status$' -or
            $data.clientProxyUri -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}$') { return $null }
        if (-not (ConvertTo-RelayEndpoint $data.clientProxyUri) -or ([uri]$data.statusUri).Port -lt 1) { return $null }
        if ($data.upstreamProxyUri -and -not (ConvertTo-RelayEndpoint $data.upstreamProxyUri)) { return $null }
        return $data
    }
    catch { return $null }
}

function Get-CodexProxyRelayStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StatePath,
        [string]$ExpectedClientProxyUri
    )
    $result = [ordered]@{
        Known = $false; Ready = $false; ClientProxyUri = $null; UpstreamProxyUri = $null
        Mode = $null; InstanceId = $null; ProcessId = $null; ErrorKind = 'RelayUnavailable'
    }
    $manifest = Read-RelayManifest $StatePath
    if (-not $manifest) { return [pscustomobject]$result }
    if ($ExpectedClientProxyUri -and $manifest.clientProxyUri -ine (ConvertTo-RelayEndpoint $ExpectedClientProxyUri)) {
        $result.ErrorKind = 'ClientProxyMismatch'
        return [pscustomobject]$result
    }
    try {
        $headers = @{ Authorization = 'Bearer ' + $manifest.statusToken }
        $status = Invoke-RestMethod -Uri $manifest.statusUri -Headers $headers -NoProxy -TimeoutSec 2 -ErrorAction Stop
        if ($status.service -cne 'codex-proxy-relay' -or $status.version -ne 1 -or
            $status.instanceId -cne $manifest.instanceId -or $status.pid -ne $manifest.pid -or
            $status.clientProxyUri -cne $manifest.clientProxyUri -or $status.mode -cne $manifest.mode) {
            $result.ErrorKind = 'RelayIdentityMismatch'
            return [pscustomobject]$result
        }
        $upstream = if ($status.upstreamProxyUri) { ConvertTo-RelayEndpoint $status.upstreamProxyUri } else { $null }
        if ($status.upstreamProxyUri -and -not $upstream) { return [pscustomobject]$result }
        $result.Known = $true
        $result.Ready = [bool]$status.ready -and [bool]$upstream
        $result.ClientProxyUri = $status.clientProxyUri
        $result.UpstreamProxyUri = $upstream
        $result.Mode = $status.mode
        $result.InstanceId = $status.instanceId
        $result.ProcessId = [int]$status.pid
        $result.ErrorKind = $status.error
    }
    catch { }
    [pscustomobject]$result
}

function ConvertTo-RelayNativeArgument {
    param([string]$Value)
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    '"' + $escaped + '"'
}

function Get-CodexProxyRelayStatePath {
    [CmdletBinding()]
    param(
        [ValidateSet('System', 'Explicit')][string]$ProxyMode = 'System',
        [string]$InitialProxyUri,
        [string]$StateDirectory
    )
    if (-not $StateDirectory) {
        $identity = $script:RelayRoot.ToLowerInvariant() + '|' + $ProxyMode
        if ($ProxyMode -eq 'Explicit') { $identity += '|' + (ConvertTo-RelayEndpoint $InitialProxyUri) }
        $key = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identity))).Substring(0, 24).ToLowerInvariant()
        $StateDirectory = Join-Path $script:RelayRoot "runtime\proxy-$key"
    }
    Join-Path ([IO.Path]::GetFullPath($StateDirectory)) 'service.json'
}

function Start-CodexProxyRelay {
    [CmdletBinding()]
    param(
        [ValidateSet('System', 'Explicit')][string]$ProxyMode = 'System',
        [Parameter(Mandatory)][string]$InitialProxyUri,
        [string]$StateDirectory,
        [switch]$DryRun
    )
    $ErrorActionPreference = 'Stop'
    $upstream = ConvertTo-RelayEndpoint $InitialProxyUri
    if (-not $upstream) { throw '转发入口仅支持不含凭据的本机 HTTP/HTTPS 代理。' }
    $source = Join-Path $script:RelayRoot 'proxy-relay\relay.mjs'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw '缺少本地代理转发程序。' }
    $node = Get-Command node.exe -ErrorAction Stop
    $version = & $node.Source --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw '本地代理入口需要 Node.js 20 或更新版本。' }
    $statePath = Get-CodexProxyRelayStatePath -ProxyMode $ProxyMode -InitialProxyUri $upstream -StateDirectory $StateDirectory
    $directory = Split-Path $statePath -Parent
    if ($directory -eq [IO.Path]::GetPathRoot($directory)) { throw '代理状态目录不能是磁盘根目录。' }
    $ancestor = $directory
    while ($ancestor) {
        $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '代理状态目录不能经过目录链接。' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    if ($DryRun) { return [pscustomobject]@{ DryRun = $true; StatePath = $statePath; NodeExecutable = $node.Source; Mode = $ProxyMode } }

    $mutexKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($statePath.ToLowerInvariant()))).Substring(0, 24)
    $mutex = [Threading.Mutex]::new($false, "Local\CodexProxyRelay-$mutexKey")
    $owned = $false
    try {
        try { $owned = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $owned = $true }
        if (-not $owned) { throw '另一个启动器正在准备本地代理入口，请稍候。' }
        $status = Get-CodexProxyRelayStatus -StatePath $statePath
        $previous = Read-RelayManifest $statePath
        if ($status.Known) {
            if ($status.Mode -ne $ProxyMode -or ($ProxyMode -eq 'Explicit' -and $status.UpstreamProxyUri -ine $upstream)) {
                throw '已有本地入口属于其他代理配置；未修改正在使用的服务。'
            }
            if ($ProxyMode -eq 'System' -and -not $status.Ready) {
                $expected = $status
                $recoveryWait = [Diagnostics.Stopwatch]::StartNew()
                # 状态查询最多两秒；四秒后不再发起查询，总等待约六秒以内。
                while (-not $status.Ready -and $recoveryWait.Elapsed.TotalSeconds -lt 4) {
                    Start-Sleep -Milliseconds 150
                    if ($recoveryWait.Elapsed.TotalSeconds -ge 4) { break }
                    $status = Get-CodexProxyRelayStatus -StatePath $statePath -ExpectedClientProxyUri $expected.ClientProxyUri
                    if (-not $status.Known -or $status.Mode -ne $ProxyMode -or
                        $status.InstanceId -cne $expected.InstanceId -or $status.ProcessId -ne $expected.ProcessId -or
                        $status.ClientProxyUri -cne $expected.ClientProxyUri) {
                        throw '已有本地入口的身份或代理配置在等待期间发生变化，未继续复用。'
                    }
                }
            }
            if (-not $status.Ready) { throw '已有本地入口尚无可用上游，请先启用系统代理后重试。' }
            return [pscustomobject]@{ ClientProxyUri = $status.ClientProxyUri; UpstreamProxyUri = $status.UpstreamProxyUri; ProcessId = $status.ProcessId; InstanceId = $status.InstanceId; StatePath = $statePath; StartedNew = $false }
        }
        # 服务崩溃后保留原客户端端口，已运行的 Codex 才能原地重连。
        $listenPort = 0
        if ($previous) {
            if ($previous.mode -ne $ProxyMode -or ($ProxyMode -eq 'Explicit' -and $previous.upstreamProxyUri -ine $upstream)) { throw '状态文件属于其他代理配置，未覆盖。' }
            $listenPort = ([uri]$previous.clientProxyUri).Port
        }
        [void][IO.Directory]::CreateDirectory($directory)
        $instanceId = [guid]::NewGuid().ToString('N')
        $arguments = @(
            (ConvertTo-RelayNativeArgument $source), '--mode', $ProxyMode,
            '--initial-proxy-uri', (ConvertTo-RelayNativeArgument $upstream),
            '--state-file', (ConvertTo-RelayNativeArgument $statePath),
            '--instance-id', $instanceId, '--listen-port', $listenPort
        )
        $started = Start-Process -FilePath $node.Source -ArgumentList $arguments -WorkingDirectory $script:RelayRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $directory 'relay.stdout.log') -RedirectStandardError (Join-Path $directory 'relay.stderr.log')
        $deadline = [DateTime]::UtcNow.AddSeconds(12)
        do {
            Start-Sleep -Milliseconds 150
            $status = Get-CodexProxyRelayStatus -StatePath $statePath
            if ($status.Known -and $status.InstanceId -ceq $instanceId) { break }
            $started.Refresh()
            if ($started.HasExited) { break }
        } while ([DateTime]::UtcNow -lt $deadline)
        if (-not $status.Known -or -not $status.Ready -or $status.InstanceId -cne $instanceId) {
            throw '本地代理入口未就绪；未启动 Codex，也不会回退到直连。请检查 relay.stderr.log。'
        }
        [pscustomobject]@{ ClientProxyUri = $status.ClientProxyUri; UpstreamProxyUri = $status.UpstreamProxyUri; ProcessId = $status.ProcessId; InstanceId = $status.InstanceId; StatePath = $statePath; StartedNew = $true }
    }
    finally {
        if ($owned) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Restore-CodexProxyRelay {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$CodexExecutable,
        [ValidateSet('System', 'Explicit')][string]$ProxyMode = 'System',
        [Parameter(Mandatory)][string]$InitialProxyUri,
        [string]$StateDirectory,
        [object[]]$Processes
    )
    $statePath = Get-CodexProxyRelayStatePath -ProxyMode $ProxyMode -InitialProxyUri $InitialProxyUri -StateDirectory $StateDirectory
    $manifest = Read-RelayManifest $statePath
    if (-not $manifest) { return $null }
    if (-not $PSBoundParameters.ContainsKey('Processes')) {
        try { $Processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ExecutablePath, CommandLine) }
        catch { return $null }
    }
    $expected = [IO.Path]::GetFullPath($CodexExecutable)
    $bound = @($Processes | Where-Object {
        try {
            $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $expected -and
                $_.CommandLine -notmatch '(?:^|\s)--type=' -and
                $_.CommandLine -match '(?:^|\s)--proxy-server="?(http://127\.0\.0\.1:[0-9]{1,5})"?(?=\s|$)' -and
                $Matches[1] -ceq $manifest.clientProxyUri
        }
        catch { $false }
    })
    if ($bound.Count -eq 0) { return $null }
    # 只恢复该进程已经绑定的入口；不修改进程参数，也不重启 Codex。
    Start-CodexProxyRelay -ProxyMode $ProxyMode -InitialProxyUri $InitialProxyUri -StateDirectory $StateDirectory
}

Export-ModuleMember -Function Get-CodexProxyRelayStatePath, Get-CodexProxyRelayStatus, Start-CodexProxyRelay, Restore-CodexProxyRelay
