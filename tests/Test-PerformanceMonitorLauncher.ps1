[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $projectRoot 'Start-CodexPerformanceMonitor.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) { throw '缺少性能监测启动脚本。' }
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw '性能监测启动脚本存在语法错误。' }

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-performance-launcher-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixtureRoot)
$statePath = Join-Path $fixtureRoot 'state'
try {
    $result = & $scriptPath -CodexHome $fixtureRoot -StateDirectory $statePath -DryRun
    if (-not $result.DryRun) { throw 'DryRun 没有返回预检结果。' }
    if ($result.CodexHome -ne [IO.Path]::GetFullPath($fixtureRoot)) { throw 'Codex 数据目录解析错误。' }
    if (Test-Path -LiteralPath $statePath) { throw 'DryRun 不得创建状态目录或启动服务。' }
    if (-not (Test-Path -LiteralPath $result.NodeExecutable -PathType Leaf)) { throw 'Node 路径无效。' }
    $withTrailingSeparator = & $scriptPath -CodexHome ($fixtureRoot + '\') -StateDirectory $statePath -DryRun
    if ($withTrailingSeparator.CodexHome -ne $result.CodexHome) { throw '目录末尾分隔符不得改变后台服务身份。' }

    $source = Get-Content -LiteralPath $scriptPath -Raw -Encoding utf8
    if ($source -notmatch 'WindowStyle\s+Hidden') { throw '后台启动必须隐藏窗口。' }
    if ($source -match 'Stop-Process|taskkill|Set-ItemProperty') { throw '监测入口不得停止现有进程或更改系统代理。' }
    $main = Get-Content -LiteralPath (Join-Path $projectRoot 'Start-CodexWithProxy.ps1') -Raw -Encoding utf8
    if ($main -notmatch 'Start-CodexPerformanceMonitor\.ps1') { throw '原启动器尚未接入性能采集。' }
    if ($main -notmatch '\[switch\]\$NoPerformanceMonitor') { throw '原启动器需要可选关闭性能采集。' }
    Write-Host 'Performance monitor launcher tests passed.'
}
finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedFixture) -notlike 'codex-performance-launcher-*') {
        throw '测试临时目录边界不正确。'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
