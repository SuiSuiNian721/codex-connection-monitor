$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$text = Get-Content -LiteralPath (Join-Path $root 'Start-CodexWithProxy.ps1') -Raw -Encoding utf8
if ($text -notmatch 'CuaRuntime\.psm1') { throw 'Launcher must import the CUA preparation module.' }
$prepare = $text.IndexOf('Sync-CodexCuaRuntime -CodexExecutable')
$dryRun = $text.IndexOf('if ($DryRun)')
$launch = $text.IndexOf('    $started = Start-Process -FilePath $codexExecutable')
if ($prepare -lt $dryRun -or $launch -lt 0 -or $prepare -ge $launch) { throw 'CUA preparation must run after DryRun and before launching GPT.' }
if ($text -notmatch 'CUA runtime ready' -or $text -notmatch 'OnProgress') { throw 'Launcher must report preparation progress and timing.' }
if ($text -match 'CODEX_BROWSER_USE_NODE_PATH|CODEX_NODE_REPL_PATH') { throw 'Use the native cache contract, not new runtime environment overrides.' }
$module = Get-Content -LiteralPath (Join-Path $root 'CuaRuntime.psm1') -Raw -Encoding utf8
$race = [regex]::Match($module, '(?s)# A concurrently starting native app.*?\n            }').Value
if ($race -notmatch '(?s)MetadataSignature.*?::Matches.*?MetadataSignature') {
    throw 'Concurrent publication adoption must compare metadata before and after full hash validation.'
}
Write-Host 'CUA runtime wiring tests passed.'
