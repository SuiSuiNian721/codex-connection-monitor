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

function ConvertTo-PerformanceNativeArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Get-ReadyPerformanceService {
    param([string]$ManifestPath, [string]$ExpectedHomeKey)
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $null }
    try {
        if ((Get-Item -LiteralPath $ManifestPath).Length -gt 8192) { return $null }
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($manifest.homeKey -ne $ExpectedHomeKey -or $manifest.url -notmatch '^http://127\.0\.0\.1:[0-9]{1,5}/$') { return $null }
        $health = Invoke-RestMethod -Uri ($manifest.url + 'api/health') -TimeoutSec 2 -NoProxy
        if ($health.service -eq 'codex-performance-monitor' -and $health.homeKey -eq $ExpectedHomeKey -and
            $health.instanceId -eq $manifest.instanceId -and $health.pid -eq $manifest.pid -and $health.ready) {
            return $manifest
        }
    } catch { }
    return $null
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
$StateDirectory = [IO.Path]::GetFullPath($StateDirectory)
$manifestPath = Join-Path $StateDirectory 'service.json'
if ($DryRun) {
    return [pscustomobject]@{ DryRun=$true; CodexHome=$CodexHome; NodeExecutable=$node.Source; StateDirectory=$StateDirectory }
}

$service = Get-ReadyPerformanceService -ManifestPath $manifestPath -ExpectedHomeKey $homeKey
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
        if ($service) { break }
        $startedProcess.Refresh()
        if ($startedProcess.HasExited -and $startedProcess.ExitCode -ne 0) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $service) { throw '性能采集器尚未就绪；可稍后重新打开面板，原 Codex 不受影响。' }
}

if ($OpenPanel) { Start-Process -FilePath $service.url | Out-Null }
[pscustomobject]@{ Url=$service.url; ProcessId=$service.pid; StateDirectory=$StateDirectory; Background=$true }
