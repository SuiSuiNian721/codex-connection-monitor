$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$modulePath = Join-Path $projectRoot 'CuaRuntime.psm1'
if (-not (Test-Path -LiteralPath $modulePath)) { throw 'Missing CUA runtime preparation module.' }
Import-Module $modulePath -Force
$tempRoot = Join-Path $env:TEMP ('codex-cua-test-' + [guid]::NewGuid().ToString('N'))
$script:assertions = 0
function Assert-True($Value, [string]$Message) {
    if (-not $Value) { throw $Message }
    $script:assertions++
}
function Assert-Fails([scriptblock]$Action, [string]$Pattern) {
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_ }
    Assert-True ($null -ne $caught -and $caught.ToString() -match $Pattern) "Expected failure: $Pattern; actual: $caught"
}
try {
    $src = Join-Path $tempRoot 'package\app\resources\cua_node'
    $cache = Join-Path $tempRoot 'cache'
    $gui = Join-Path $tempRoot 'package\app\ChatGPT.exe'
    New-Item -ItemType Directory -Path (Join-Path $src 'bin\node_modules\中文 空格') -Force | Out-Null
    $contents = [ordered]@{
        'manifest.json' = '{"platform":"windows","arch":"x64","node_path":"bin/node.exe","node_modules":"bin/node_modules","node_repl_path":"bin/node_repl.exe"}'
        'bin/node.exe' = 'fake-node'
        'bin/node_repl.exe' = 'fake-repl'
        'bin/node_modules/中文 空格/index.js' = 'module.exports = "你好";'
    }
    foreach ($entry in $contents.GetEnumerator()) {
        [IO.File]::WriteAllText((Join-Path $src $entry.Key), $entry.Value, [Text.UTF8Encoding]::new($false))
    }
    # Independent reference: literal digest input follows the app's name/NUL/hash/NUL format.
    $inputText = ''
    foreach ($name in @('manifest.json', 'bin/node.exe', 'bin/node_repl.exe')) {
        $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($contents[$name]))).ToLowerInvariant()
        $inputText += $name + [char]0 + $digest + [char]0
    }
    $expected = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($inputText))).ToLowerInvariant().Substring(0,16)
    $events = [Collections.Generic.List[object]]::new()
    $result = Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache -OnProgress { param($p) $events.Add($p) }
    Assert-True ($result.Fingerprint -eq $expected) 'Fingerprint must match the native app algorithm.'
    Assert-True ($result.Status -eq 'Prepared') 'First call must prepare the cache.'
    Assert-True ($result.FileCount -eq 4) 'All runtime files must be counted.'
    $receiptPath = Join-Path $cache ('.verified-' + $expected + '.json')
    Assert-True (Test-Path -LiteralPath $receiptPath) 'Verified cache must create a receipt outside the runtime directory.'
    foreach ($entry in $contents.GetEnumerator()) {
        Assert-True ([IO.File]::ReadAllText((Join-Path $result.Path $entry.Key)) -ceq $entry.Value) "Copy mismatch: $($entry.Key)"
    }
    Assert-True ($events.Count -gt 0 -and $events[$events.Count-1].CompletedFiles -eq 4) 'Progress must finish at the total file count.'
    $copied = Join-Path $result.Path 'bin\node_modules\中文 空格\index.js'
    $before = (Get-Item -LiteralPath $copied).LastWriteTimeUtc
    $again = Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache
    Assert-True ($again.Status -eq 'Reused' -and $again.Path -eq $result.Path) 'Second call must reuse the same cache.'
    Assert-True ($again.Validation -eq 'Metadata') 'Unchanged verified cache should use the metadata fast path.'
    Assert-True ((Get-Item -LiteralPath $copied).LastWriteTimeUtc -eq $before) 'Reuse must not rewrite files.'
    [IO.File]::WriteAllText($receiptPath, '{invalid')
    $revalidated = Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache
    Assert-True ($revalidated.Validation -eq 'Full') 'Invalid receipt must cause full verification, not a cache rewrite.'
    [IO.File]::WriteAllText($receiptPath, '[1,2]')
    $wrongShape = Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache
    Assert-True ($wrongShape.Validation -eq 'Full') 'Wrong-shaped JSON receipt must fall back to full verification.'
    $unexpected = Join-Path $result.Path 'bin\node_modules\unexpected.js'
    [IO.File]::WriteAllText($unexpected, 'extra')
    try { Assert-Fails { Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache } '缓存|cache' }
    finally { Remove-Item -LiteralPath $unexpected }
    [IO.File]::WriteAllText($copied, ($contents['bin/node_modules/中文 空格/index.js'] -replace '你好','再见'), [Text.UTF8Encoding]::new($false))
    Assert-Fails { Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache } '缓存|cache'
    [IO.File]::WriteAllText($copied, 'corrupt')
    Assert-Fails { Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache } '缓存|cache'
    Assert-True ([IO.File]::ReadAllText($copied) -ceq 'corrupt') 'Corrupt existing cache must not be overwritten.'
    [IO.File]::WriteAllText($copied, $contents['bin/node_modules/中文 空格/index.js'], [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $src 'bin\node.exe'), 'new-node')
    $updated = Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache
    Assert-True ($updated.Path -ne $result.Path -and $updated.Status -eq 'Prepared') 'Changed core runtime must get a new cache.'
    Assert-True (Test-Path -LiteralPath $result.Path) 'Old cache must be preserved.'
    $raceRoot = Join-Path $tempRoot 'race-cache'
    $raceDestination = Join-Path $raceRoot $updated.Fingerprint
    $race = Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $raceRoot -OnProgress {
        param($p)
        if (-not (Test-Path -LiteralPath $raceDestination)) {
            foreach ($relative in $contents.Keys) {
                $target = Join-Path $raceDestination $relative
                New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
                Copy-Item -LiteralPath (Join-Path $src $relative) -Destination $target
            }
        }
    }
    Assert-True ($race.Status -eq 'Reused') 'A concurrent complete native cache should be verified and adopted.'
    Assert-True (@(Get-ChildItem -LiteralPath $raceRoot -Directory -Filter '.prepare-*').Count -eq 0) 'Concurrent adoption must clean only its own staging directory.'
    $raceWarm = Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $raceRoot
    Assert-True ($raceWarm.Validation -eq 'Metadata') 'Concurrent adoption must produce a usable verification receipt.'
    $addedDuringCopy = Join-Path $src 'bin\node_modules\added-during-copy.js'
    try {
        Assert-Fails {
            Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot (Join-Path $tempRoot 'changed-source-cache') -OnProgress {
                param($p)
                if (-not (Test-Path -LiteralPath $addedDuringCopy)) { [IO.File]::WriteAllText($addedDuringCopy, 'new-file') }
            }
        } '变化|校验'
    }
    finally { if (Test-Path -LiteralPath $addedDuringCopy) { Remove-Item -LiteralPath $addedDuringCopy } }
    $lock = [IO.File]::Open((Join-Path $src 'bin\node_modules\中文 空格\index.js'), 'Open', 'Read', 'None')
    try { Assert-Fails { Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot (Join-Path $tempRoot 'locked-cache') } '.*' } finally { $lock.Dispose() }
    Assert-True (@(Get-ChildItem -LiteralPath (Join-Path $tempRoot 'locked-cache') -Directory -ErrorAction SilentlyContinue).Count -eq 0) 'Failed preparation must not publish a partial cache or leave staging.'
    $outside = Join-Path $tempRoot 'outside'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $junction = Join-Path $src 'bin\node_modules\external-link'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    try { Assert-Fails { Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache } '链接|reparse' } finally { [IO.Directory]::Delete($junction) }
    Assert-Fails { Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $src } '重叠|overlap'
    [IO.File]::WriteAllText((Join-Path $src 'manifest.json'), '{bad json')
    Assert-Fails { Sync-CodexCuaRuntime -CodexExecutable $gui -DestinationRoot $cache } 'manifest|JSON'
    Write-Host "CUA runtime tests passed. Assertions=$script:assertions"
}
finally {
    $resolved = [IO.Path]::GetFullPath($tempRoot)
    $parent = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'codex-cua-test-*') { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
