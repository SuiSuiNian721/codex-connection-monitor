$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$cmdPath = Join-Path $projectRoot '启动 Codex（代理）.cmd'

if (-not (Test-Path -LiteralPath $cmdPath -PathType Leaf)) {
    throw "CMD shim missing: $cmdPath"
}
$content = Get-Content -Raw -LiteralPath $cmdPath
if ($content -notmatch 'pwsh\.exe') {
    throw 'CMD shim must use PowerShell 7 for UTF-8 without BOM compatibility.'
}
if ($content -match 'WindowsPowerShell') {
    throw 'CMD shim must not use Windows PowerShell 5.1 for UTF-8 source files.'
}
if ($content -notmatch [regex]::Escape('%~dp0Start-CodexWithProxy.ps1')) {
    throw 'CMD shim does not call the launcher beside itself.'
}
if ($content -notmatch 'if not "%exitCode%"=="0"') {
    throw 'CMD shim must pause only after a launcher failure.'
}
Write-Host 'CMD shim test passed.'
