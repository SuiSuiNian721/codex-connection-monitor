[CmdletBinding()]
param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

function ConvertTo-NetworkLocalProxy {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $candidate = $Value.Trim()
    $scheme = 'http'
    if ($candidate.Contains('=')) {
        $entries = @{}
        foreach ($part in ($candidate -split ';')) {
            if ($part -match '^\s*([^=]+)=(.+?)\s*$') {
                $entries[$Matches[1].Trim().ToLowerInvariant()] = $Matches[2].Trim()
            }
        }
        $candidate = $null
        foreach ($key in @('https', 'http', 'socks', 'socks5')) {
            if ($entries.ContainsKey($key)) {
                $candidate = $entries[$key]
                if ($key -like 'socks*') { $scheme = 'socks5' }
                break
            }
        }
        if (-not $candidate) { return $null }
    }
    if ($candidate -match '^([a-zA-Z][a-zA-Z0-9+.-]*)://(.+)$') {
        $scheme = $Matches[1].ToLowerInvariant()
        $candidate = $Matches[2]
    }
    if ($scheme -notin @('http', 'https', 'socks5') -or
        $candidate -match '\s' -or $candidate.TrimEnd('/') -notmatch ':(\d+)$') { return $null }
    $uri = $null
    if (-not [Uri]::TryCreate("$scheme`://$candidate", [UriKind]::Absolute, [ref]$uri) -or
        $uri.DnsSafeHost -notin @('127.0.0.1', 'localhost', '::1') -or
        $uri.Port -lt 1 -or $uri.Port -gt 65535 -or $uri.UserInfo -or
        $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { return $null }
    $hostPart = if ($uri.DnsSafeHost -eq '::1') { '[::1]' } else { $uri.DnsSafeHost.ToLowerInvariant() }
    '{0}://{1}:{2}' -f $uri.Scheme, $hostPart, $uri.Port
}

function Split-NetworkNativeCommandLine {
    param([string]$CommandLine)

    if ([string]::IsNullOrWhiteSpace($CommandLine) -or $CommandLine.Length -gt 32768) { return @() }
    # Windows 参数中的空格、双引号与反斜线必须一起解析，不能在 -Command 文本里误找 -File。
    $parts = [Collections.Generic.List[string]]::new()
    $index = 0
    while ($index -lt $CommandLine.Length) {
        while ($index -lt $CommandLine.Length -and [char]::IsWhiteSpace($CommandLine[$index])) { $index++ }
        if ($index -ge $CommandLine.Length) { break }
        $quoted = $false
        $part = [Text.StringBuilder]::new()
        while ($index -lt $CommandLine.Length) {
            $slashes = 0
            while ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '\') { $slashes++; $index++ }
            if ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '"') {
                [void]$part.Append('\', [int][Math]::Floor($slashes / 2))
                if ($slashes % 2) { [void]$part.Append('"') }
                elseif ($quoted -and $index + 1 -lt $CommandLine.Length -and $CommandLine[$index + 1] -eq '"') {
                    [void]$part.Append('"')
                    $index++
                }
                else { $quoted = -not $quoted }
                $index++
                continue
            }
            [void]$part.Append('\', $slashes)
            if ($index -ge $CommandLine.Length -or (-not $quoted -and [char]::IsWhiteSpace($CommandLine[$index]))) { break }
            [void]$part.Append($CommandLine[$index])
            $index++
        }
        if ($quoted) { return @() }
        $parts.Add($part.ToString())
    }
    $parts.ToArray()
}

function Get-NetworkWatchdogArguments {
    param([string]$CommandLine, [string]$ExpectedScript)

    $parts = @(Split-NetworkNativeCommandLine $CommandLine)
    if ($parts.Count -lt 3) { return $null }
    $fileIndex = -1
    for ($index = 1; $index -lt $parts.Count; $index++) {
        if ($parts[$index] -in @('-Command', '-c', '-EncodedCommand', '-ec', '-CommandWithArgs')) { return $null }
        if ($parts[$index] -ieq '-File') { $fileIndex = $index; break }
    }
    if ($fileIndex -lt 1 -or $fileIndex + 1 -ge $parts.Count) { return $null }
    try {
        if (-not [IO.Path]::IsPathFullyQualified($parts[$fileIndex + 1]) -or
            [IO.Path]::GetFullPath($parts[$fileIndex + 1]) -ine [IO.Path]::GetFullPath($ExpectedScript)) { return $null }
    }
    catch { return $null }
    $arguments = @{}
    for ($index = $fileIndex + 2; $index -lt $parts.Count; $index++) {
        $key = $parts[$index]
        if ($key -in @('-RootProcessId', '-CodexExecutable', '-InitialProxyUri', '-RelayStatePath')) {
            if ($arguments.ContainsKey($key) -or $index + 1 -ge $parts.Count) { return $null }
            $arguments[$key] = $parts[++$index]
        }
    }
    $rootId = 0
    if (-not [int]::TryParse([string]$arguments['-RootProcessId'], [ref]$rootId) -or $rootId -lt 1 -or
        -not [IO.Path]::IsPathFullyQualified([string]$arguments['-CodexExecutable'])) { return $null }
    $clientProxy = ConvertTo-NetworkLocalProxy $arguments['-InitialProxyUri']
    if (-not $clientProxy) { return $null }
    [pscustomobject]@{
        RootProcessId = $rootId
        CodexExecutable = [IO.Path]::GetFullPath($arguments['-CodexExecutable'])
        ClientProxyUri = $clientProxy
        RelayStatePath = $arguments['-RelayStatePath']
    }
}

function Find-NetworkWatchdogBinding {
    param(
        [object[]]$Watchdogs,
        [string]$Root,
        [scriptblock]$ReadRoot = { param($RootId) Get-Process -Id $RootId -ErrorAction Stop }
    )

    $expectedScript = Join-Path $Root 'Watch-CodexConnection.ps1'
    # 先核对本项目脚本，再限制候选数量；其它短命 pwsh 进程不能挤掉真正的监视器。
    $candidates = foreach ($watchdog in $Watchdogs) {
        try {
            $arguments = Get-NetworkWatchdogArguments -CommandLine ([string]$watchdog.CommandLine) -ExpectedScript $expectedScript
            if (-not $arguments -or -not $watchdog.CreationDate) { continue }
            [pscustomobject]@{ Arguments = $arguments; CreationDate = $watchdog.CreationDate }
        }
        catch { }
    }
    foreach ($candidate in @($candidates | Sort-Object CreationDate -Descending | Select-Object -First 16)) {
        try {
            $arguments = $candidate.Arguments
            $rootProcess = & $ReadRoot $arguments.RootProcessId
            if (-not $rootProcess -or [int]$rootProcess.Id -ne $arguments.RootProcessId -or
                -not $rootProcess.StartTime -or
                $rootProcess.StartTime.ToUniversalTime() -gt ([datetime]$candidate.CreationDate).ToUniversalTime() -or
                [IO.Path]::GetFullPath([string]$rootProcess.Path) -ine $arguments.CodexExecutable) { continue }
            [pscustomobject]@{
                ProcessId = $arguments.RootProcessId
                StartedAt = $rootProcess.StartTime.ToUniversalTime().ToString('o')
                ClientProxyUri = $arguments.ClientProxyUri
                RelayStatePath = $arguments.RelayStatePath
            }
            return
        }
        catch { }
    }
    return $null
}

function Test-NetworkRelayStatePath {
    param([string]$StatePath, [string]$Root)

    try {
        if (-not [IO.Path]::IsPathFullyQualified($StatePath)) { return $false }
        $resolved = [IO.Path]::GetFullPath($StatePath)
        $runtime = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath((Join-Path $Root 'runtime')))
        if (-not $resolved.StartsWith($runtime + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        $ancestor = $resolved
        while ($ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
            $ancestor = [IO.Path]::GetDirectoryName($ancestor)
        }
        $leaf = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        -not $leaf.PSIsContainer -and $leaf.Length -le 16384
    }
    catch { return $false }
}

function Get-NetworkLocalInventory {
    $result = [ordered]@{ activeAdapterCount = $null; hasDefaultRoute = $null; dnsConfigured = $null }
    try {
        $active = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {
            $_.OperationalStatus -eq [Net.NetworkInformation.OperationalStatus]::Up -and
                $_.NetworkInterfaceType -ne [Net.NetworkInformation.NetworkInterfaceType]::Loopback -and
                $_.GetIPProperties().UnicastAddresses.Count -gt 0
        })
        $result.activeAdapterCount = $active.Count
        $indexes = [Collections.Generic.HashSet[int]]::new()
        $result.dnsConfigured = $false
        foreach ($adapter in $active) {
            $properties = $adapter.GetIPProperties()
            if ($properties.DnsAddresses.Count -gt 0) { $result.dnsConfigured = $true }
            if ($adapter.Supports([Net.NetworkInformation.NetworkInterfaceComponent]::IPv4)) {
                [void]$indexes.Add($properties.GetIPv4Properties().Index)
            }
            if ($adapter.Supports([Net.NetworkInformation.NetworkInterfaceComponent]::IPv6)) {
                [void]$indexes.Add($properties.GetIPv6Properties().Index)
            }
        }
        try {
            # 查询实际活动路由表，不能把网卡保存的网关设置当成实时默认路由。
            $routes = @(Get-NetRoute -DestinationPrefix @('0.0.0.0/0', '::/0') -PolicyStore ActiveStore -ErrorAction Stop |
                Where-Object { $indexes.Contains([int]$_.InterfaceIndex) })
            $result.hasDefaultRoute = $routes.Count -gt 0
        }
        catch { }
    }
    catch { }
    [pscustomobject]$result
}

$result = [ordered]@{
    observedAt = [DateTime]::UtcNow.ToString('o')
    platform = 'win32'
    local = [pscustomobject]@{ activeAdapterCount = $null; hasDefaultRoute = $null; dnsConfigured = $null }
    systemProxyUri = $null
    clientProxyUri = $null
    upstreamProxyUri = $null
    proxySource = 'unknown'
    codex = [pscustomobject]@{ running = $null; pid = $null; startedAt = $null; monitored = $false }
    relay = [pscustomobject]@{ known = $false; ready = $false; errorKind = $null }
    message = $null
}

try {
    $resolvedRoot = [IO.Path]::GetFullPath($ProjectRoot)
    $result.local = Get-NetworkLocalInventory
    try {
        $settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ([int]$settings.ProxyEnable -eq 1) {
            $result.systemProxyUri = ConvertTo-NetworkLocalProxy ([string]$settings.ProxyServer)
        }
    }
    catch { }
    $watchdogs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'pwsh.exe'" -ErrorAction Stop |
        Select-Object CreationDate, CommandLine)
    $binding = Find-NetworkWatchdogBinding -Watchdogs $watchdogs -Root $resolvedRoot
    if ($binding) {
        $result.codex = [pscustomobject]@{ running = $true; pid = $binding.ProcessId; startedAt = $binding.StartedAt; monitored = $true }
        $result.clientProxyUri = $binding.ClientProxyUri
        $result.proxySource = 'watchdog'
        if ($binding.RelayStatePath) {
            $result.proxySource = 'relay'
            $result.relay.errorKind = 'RelayUnavailable'
            if (Test-NetworkRelayStatePath -StatePath $binding.RelayStatePath -Root $resolvedRoot) {
                try {
                    Import-Module (Join-Path $resolvedRoot 'CodexProxyRelay.psm1') -Force -WarningAction SilentlyContinue | Out-Null
                    $status = Get-CodexProxyRelayStatus -StatePath $binding.RelayStatePath -ExpectedClientProxyUri $binding.ClientProxyUri
                    $result.relay.known = [bool]$status.Known
                    $result.relay.ready = [bool]$status.Ready
                    if ($status.ErrorKind -in @('RelayUnavailable', 'ClientProxyMismatch', 'RelayIdentityMismatch',
                        'SystemProxyDisabled', 'SystemProxyReadFailed', 'InvalidSystemProxy', 'InvalidExplicitProxy', 'ProxyLoop')) {
                        $result.relay.errorKind = [string]$status.ErrorKind
                    }
                    elseif (-not $status.ErrorKind -and $status.Known) { $result.relay.errorKind = $null }
                    else { $result.relay.errorKind = 'RelayUnavailable' }
                    if ($status.Known) { $result.upstreamProxyUri = ConvertTo-NetworkLocalProxy ([string]$status.UpstreamProxyUri) }
                }
                catch { }
            }
            else { $result.relay.errorKind = 'UnsafeStatePath' }
            if (-not $result.relay.known) { $result.message = '已核对 Codex 客户端入口，relay 的当前上游暂不可确认。' }
        }
        else { $result.upstreamProxyUri = $binding.ClientProxyUri }
    }
    else {
        $result.clientProxyUri = $result.systemProxyUri
        $result.upstreamProxyUri = $result.systemProxyUri
        if ($result.systemProxyUri) { $result.proxySource = 'system' }
        $result.message = '未找到可核对的 Codex 监视会话；探测仅对应当前系统代理。'
    }
}
catch { $result.message = '部分 Windows 网络或运行路径信息暂不可读取。' }

# 只返回公开的计数、时间和本机端点，异常、命令行及 relay 鉴权字段不会进入输出。
$result.observedAt = [DateTime]::UtcNow.ToString('o')
$result | ConvertTo-Json -Compress -Depth 6
