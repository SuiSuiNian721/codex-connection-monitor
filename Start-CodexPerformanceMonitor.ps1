[CmdletBinding()]
param(
    [string]$CodexHome,
    [string]$StateDirectory,
    [switch]$OpenPanel,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot
$serverPath = Join-Path $scriptRoot 'performance-monitor\server.mjs'
$runtimeRevision = '2026.10.06-panel.2'

function ConvertTo-PerformanceNativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function ConvertTo-PerformanceStartedAt {
    param($Value)
    if ($Value -isnot [string] -and $Value -isnot [datetime] -and $Value -isnot [DateTimeOffset]) { return $null }
    try { return ([DateTimeOffset]$Value).ToUniversalTime().ToString('o') } catch { return $null }
}

function Get-ReadyPerformanceService {
    param([string]$ManifestPath, [string]$ExpectedHomeKey)
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $null }
    try {
        $manifestFile = Get-Item -LiteralPath $ManifestPath -Force
        if ($manifestFile.Length -gt 8192 -or ($manifestFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid-manifest' }
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        $manifestStartedAt = ConvertTo-PerformanceStartedAt $manifest.startedAt
        if ($manifest.version -ne 1 -or $manifest.homeKey -cne $ExpectedHomeKey -or
            [string]$manifest.pid -notmatch '^[1-9][0-9]{0,9}$' -or [long]$manifest.pid -gt [int]::MaxValue -or
            $manifest.instanceId -cnotmatch '^[a-f0-9]{32}$' -or $manifest.url -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}/$' -or
            ([uri]$manifest.url).Port -lt 1 -or ([uri]$manifest.url).Port -ne $manifest.port -or -not $manifestStartedAt) { throw 'invalid-manifest' }
    } catch { throw '性能监测服务清单无法核对，未停止任何进程；请检查当前安装目录的监测状态。' }
    try {
        $health = Invoke-RestMethod -Uri ($manifest.url + 'api/health') -TimeoutSec 2 -NoProxy
    } catch {
        $existingProcess = @(Get-Process -Id $manifest.pid -ErrorAction SilentlyContinue)
        if (-not $existingProcess.Count) { return $null }
        throw '性能监测健康信息无法核对，未停止任何进程；请稍后重试，或手动关闭已确认的旧监测服务。'
    }
    $manifestRevision = if ($manifest.PSObject.Properties['runtimeRevision']) { [string]$manifest.runtimeRevision } else { '' }
    $healthRevision = if ($health.PSObject.Properties['runtimeRevision']) { [string]$health.runtimeRevision } else { '' }
    $healthStartedAt = ConvertTo-PerformanceStartedAt $health.startedAt
    if ($health.service -cne 'codex-performance-monitor' -or $health.version -ne 1 -or $health.homeKey -cne $ExpectedHomeKey -or
        $health.instanceId -cne $manifest.instanceId -or $health.pid -ne $manifest.pid -or
        $healthStartedAt -cne $manifestStartedAt -or $healthRevision -cne $manifestRevision -or $health.ready -isnot [bool]) {
        throw '性能监测清单与健康响应身份不一致，未停止任何进程；请检查旧监测服务。'
    }
    return [pscustomobject]@{ pid=[int]$manifest.pid; homeKey=$ExpectedHomeKey; instanceId=$manifest.instanceId
        url=$manifest.url; startedAt=$manifestStartedAt; ready=$health.ready; runtimeRevision=$manifestRevision }
}

function Split-PerformanceNativeCommandLine {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or $CommandLine.Length -gt 32768) { return @() }
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
                elseif ($quoted -and $index + 1 -lt $CommandLine.Length -and $CommandLine[$index + 1] -eq '"') { [void]$part.Append('"'); $index++ }
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
    return $parts.ToArray()
}

function Test-PerformanceUnlinkedPath {
    param([string]$LiteralPath)
    try {
        if (-not [IO.Path]::IsPathFullyQualified($LiteralPath)) { return $false }
        $current = [IO.Path]::GetFullPath($LiteralPath)
        while ($current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
            $parent = [IO.Path]::GetDirectoryName($current)
            if ($parent -eq $current) { break }
            $current = $parent
        }
        return $true
    } catch { return $false }
}

function Test-PerformanceProcessIdentity {
    param($Service, $Process, $CimProcess, [string]$ExpectedNode, [string]$ExpectedScript, [string]$ExpectedHome, [string]$ExpectedState)
    try {
        if (-not $Process -or -not $CimProcess -or $Process.HasExited -or $Process.Id -ne $Service.pid -or $CimProcess.ProcessId -ne $Service.pid) { return $false }
        foreach ($candidatePath in @($ExpectedNode, $ExpectedScript, $ExpectedHome, $ExpectedState)) {
            if (-not (Test-PerformanceUnlinkedPath $candidatePath)) { return $false }
        }
        if ([IO.Path]::GetFullPath([string]$Process.Path) -ine $ExpectedNode -or
            [IO.Path]::GetFullPath([string]$CimProcess.ExecutablePath) -ine $ExpectedNode) { return $false }
        $parts = @(Split-PerformanceNativeCommandLine ([string]$CimProcess.CommandLine))
        if ($parts.Count -ne 6 -or -not [IO.Path]::IsPathFullyQualified($parts[0]) -or -not [IO.Path]::IsPathFullyQualified($parts[1]) -or
            [IO.Path]::GetFullPath($parts[0]) -ine $ExpectedNode -or [IO.Path]::GetFullPath($parts[1]) -ine $ExpectedScript) { return $false }
        $settings = @{}
        for ($index = 2; $index -lt $parts.Count; $index += 2) {
            if ($parts[$index] -cnotin @('--codex-home', '--state-dir') -or $settings.ContainsKey($parts[$index])) { return $false }
            $settings[$parts[$index]] = $parts[$index + 1]
        }
        if (-not [IO.Path]::IsPathFullyQualified($settings['--codex-home']) -or -not [IO.Path]::IsPathFullyQualified($settings['--state-dir']) -or
            [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($settings['--codex-home'])) -ine $ExpectedHome -or
            [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($settings['--state-dir'])) -ine $ExpectedState) { return $false }
        $createdAt = ([datetime]$CimProcess.CreationDate).ToUniversalTime()
        $processStartedAt = $Process.StartTime.ToUniversalTime()
        $serviceStartedAt = ([DateTimeOffset]::Parse($Service.startedAt)).UtcDateTime
        if ([Math]::Abs(($createdAt - $processStartedAt).TotalMilliseconds) -gt 1 -or
            $serviceStartedAt -lt $createdAt.AddMilliseconds(-1) -or $serviceStartedAt -gt $createdAt.AddSeconds(30) -or
            $serviceStartedAt -gt [DateTime]::UtcNow.AddSeconds(2)) { return $false }
        return $true
    } catch { return $false }
}

function Stop-VerifiedPerformanceService {
    param($Service, [string]$ManifestPath, [string]$ExpectedNode, [string]$ExpectedScript, [string]$ExpectedHome, [string]$ExpectedState)
    $stopIssued = $false
    try {
        if ($Service.runtimeRevision -cnotin @('', '2026.10.06-panel.1')) { throw 'unknown-runtime' }
        $monitor = Get-Process -Id $Service.pid -ErrorAction Stop
        # 持有现有 Process 对象的句柄，再二次核对；不按名称或重用后的 PID 批量停止。
        $null = $monitor.Handle
        $monitor.Refresh()
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($Service.pid)" -ErrorAction Stop
        $identity = @{ Service=$Service; Process=$monitor; CimProcess=$cim; ExpectedNode=$ExpectedNode; ExpectedScript=$ExpectedScript; ExpectedHome=$ExpectedHome; ExpectedState=$ExpectedState }
        if (-not (Test-PerformanceProcessIdentity @identity)) { throw 'unverified-process' }
        $latest = Get-ReadyPerformanceService -ManifestPath $ManifestPath -ExpectedHomeKey $Service.homeKey
        if (-not $latest -or -not $latest.ready) { throw 'service-changed' }
        foreach ($field in @('pid', 'homeKey', 'instanceId', 'startedAt', 'runtimeRevision', 'url')) {
            if ($latest.$field -cne $Service.$field) { throw 'service-changed' }
        }
        $monitor.Refresh()
        $identity.CimProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($Service.pid)" -ErrorAction Stop
        if (-not (Test-PerformanceProcessIdentity @identity)) { throw 'process-changed' }
        $stopIssued = $true
        Stop-Process -InputObject $monitor -Force -ErrorAction Stop
        if (-not $monitor.WaitForExit(5000)) { throw 'process-did-not-exit' }
    } catch {
        if ($stopIssued) { throw '旧性能监测服务停止或退出确认失败，未启动替换进程；Codex 会话和代理未操作。' }
        throw '无法安全核对旧性能监测进程，未停止任何进程。仅支持当前安装目录原位升级；请手动关闭已确认的旧监测服务后重试。'
    }
}

if (-not $CodexHome) {
    $CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
}
$CodexHome = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($CodexHome))
if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) { throw 'Codex 数据目录不存在，请先正常启动一次 Codex。' }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw '缺少性能采集程序，请检查 performance-monitor 目录。' }
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw '性能监测需要 Node.js 20 或更新版本；原 Codex 连接监测不受影响。' }
$nodeVersion = & $node.Source --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
    throw '性能监测需要 Node.js 20 或更新版本。'
}
$homeKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($CodexHome.ToLowerInvariant()))).Substring(0, 24).ToLowerInvariant()
if (-not $StateDirectory) { $StateDirectory = Join-Path $scriptRoot "runtime\performance-$homeKey" }
$StateDirectory = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($StateDirectory))
$manifestPath = Join-Path $StateDirectory 'service.json'
if ($DryRun) {
    return [pscustomobject]@{ DryRun=$true; CodexHome=$CodexHome; NodeExecutable=$node.Source; StateDirectory=$StateDirectory }
}

$service = Get-ReadyPerformanceService -ManifestPath $manifestPath -ExpectedHomeKey $homeKey
if ($service -and -not $service.ready) { throw '性能监测服务仍在初始化，未停止任何进程；请稍后重试。' }
if ($service -and $service.runtimeRevision -cne $runtimeRevision) {
    Stop-VerifiedPerformanceService -Service $service -ManifestPath $manifestPath -ExpectedNode $node.Source `
        -ExpectedScript $serverPath -ExpectedHome $CodexHome -ExpectedState $StateDirectory
    $service = $null
}
if (-not $service) {
    [void](New-Item -ItemType Directory -Path $StateDirectory -Force)
    $arguments = @(
        (ConvertTo-PerformanceNativeArgument $serverPath),
        '--codex-home', (ConvertTo-PerformanceNativeArgument $CodexHome),
        '--state-dir', (ConvertTo-PerformanceNativeArgument $StateDirectory)
    )
    $startedProcess = Start-Process -FilePath $node.Source -ArgumentList $arguments -WorkingDirectory $scriptRoot `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $StateDirectory 'server.stdout.log') `
        -RedirectStandardError (Join-Path $StateDirectory 'server.stderr.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 200
        $service = Get-ReadyPerformanceService -ManifestPath $manifestPath -ExpectedHomeKey $homeKey
        if ($service -and $service.runtimeRevision -cne $runtimeRevision) { throw '性能监测运行版本仍不匹配，未复用旧服务；请检查当前安装目录。' }
        if ($service -and $service.ready) { break }
        $service = $null
        $startedProcess.Refresh()
        if ($startedProcess.HasExited -and $startedProcess.ExitCode -ne 0) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $service) { throw '性能采集器尚未就绪；可稍后重新打开面板，原 Codex 不受影响。' }
}

if ($OpenPanel) { Start-Process -FilePath $service.url | Out-Null }
[pscustomobject]@{ Url=$service.url; ProcessId=$service.pid; StateDirectory=$StateDirectory; Background=$true; RuntimeRevision=$service.runtimeRevision }
