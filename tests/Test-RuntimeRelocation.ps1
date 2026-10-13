$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $projectRoot 'CodexProxyLauncher.psm1') -Force

function Assert-Fails([scriptblock]$Action, [string]$Pattern) {
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_ }
    if ($null -eq $caught -or $caught.ToString() -notmatch $Pattern) {
        throw "Expected failure [$Pattern]; actual: $caught"
    }
}

$tempRoot = Join-Path $env:TEMP ('codex-runtime-test-' + [guid]::NewGuid().ToString('N'))
try {
    $appDir = Join-Path $tempRoot 'package\app'
    $resourcesDir = Join-Path $appDir 'resources'
    $destinationRoot = Join-Path $tempRoot 'cache'
    New-Item -ItemType Directory -Force $resourcesDir | Out-Null

    $guiExecutable = Join-Path $appDir 'Codex.exe'
    [IO.File]::WriteAllText($guiExecutable, 'gui')
    $expected = @{
        'codex.exe' = 'current-cli'
        'codex-code-mode-host.exe' = 'current-code-mode-host'
        'codex-windows-sandbox-setup.exe' = 'current-sandbox'
        'codex-command-runner.exe' = 'current-runner'
    }
    foreach ($entry in $expected.GetEnumerator()) {
        [IO.File]::WriteAllText((Join-Path $resourcesDir $entry.Key), $entry.Value)
    }

    $runtimeCli = Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $destinationRoot
    if (-not (Test-Path -LiteralPath $runtimeCli -PathType Leaf)) {
        throw "Relocated CLI missing: $runtimeCli"
    }
    foreach ($entry in $expected.GetEnumerator()) {
        $actual = [IO.File]::ReadAllText((Join-Path (Split-Path $runtimeCli -Parent) $entry.Key))
        if ($actual -ne $entry.Value) {
            throw "Relocated content mismatch: $($entry.Key)"
        }
    }

    $second = Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $destinationRoot
    if ($second -ne $runtimeCli) { throw 'Runtime path must be stable for identical inputs.' }
    if (@(Get-ChildItem $destinationRoot -Directory).Count -ne 1) {
        throw 'Identical inputs must reuse one versioned runtime directory.'
    }

    Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $resourcesDir } 'overlap|重叠'
    Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot (Join-Path $resourcesDir 'inside') } 'overlap|重叠'
    Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot ([IO.Path]::GetPathRoot($tempRoot)) } 'root|根目录'
    $outside = Join-Path $tempRoot 'outside'
    New-Item -ItemType Directory -Path $outside | Out-Null
    $linkedCache = Join-Path $tempRoot 'linked-cache'
    New-Item -ItemType Junction -Path $linkedCache -Target $outside | Out-Null
    try { Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $linkedCache } 'reparse|链接' }
    finally { [IO.Directory]::Delete($linkedCache) }

    $packageAlias = Join-Path $tempRoot 'package-alias'
    New-Item -ItemType Junction -Path $packageAlias -Target (Join-Path $tempRoot 'package') | Out-Null
    try {
        $aliasExecutable = Join-Path $packageAlias 'app\Codex.exe'
        if ((Sync-CodexRuntime -CodexExecutable $aliasExecutable -DestinationRoot $destinationRoot) -cne $runtimeCli) {
            throw 'A Store package junction must resolve to the same runtime contents.'
        }
        Assert-Fails { Sync-CodexRuntime -CodexExecutable $aliasExecutable -DestinationRoot $resourcesDir } 'overlap|重叠'
    }
    finally { [IO.Directory]::Delete($packageAlias) }

    $cachedRunner = Join-Path (Split-Path $runtimeCli -Parent) 'codex-command-runner.exe'
    [IO.File]::WriteAllText($cachedRunner, 'corrupt')
    Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $destinationRoot } '缓存|cache'
    if ([IO.File]::ReadAllText($cachedRunner) -cne 'corrupt') { throw 'Corrupt existing runtime must not be moved or overwritten.' }
    [IO.File]::WriteAllText($cachedRunner, $expected['codex-command-runner.exe'])
    $unexpectedFile = Join-Path (Split-Path $runtimeCli -Parent) 'unexpected.exe'
    [IO.File]::WriteAllText($unexpectedFile, 'extra-file')
    try { Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $destinationRoot } '缓存|cache' }
    finally { Remove-Item -LiteralPath $unexpectedFile -Force }

    $module = Get-Module CodexProxyLauncher
    & $module {
        function script:Copy-CodexRuntimeFile {
            param([string]$Source, [string]$Destination)
            [IO.File]::Copy($Source, $Destination, $false)
            if ([IO.Path]::GetFileName($Source) -eq 'codex.exe') {
                [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $Source) 'codex-command-runner.exe'), 'source-changed-during-copy')
            }
        }
    }
    $changingCache = Join-Path $tempRoot 'changing-cache'
    Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $changingCache } '变化|changed|校验|verif'
    if (@(Get-ChildItem -LiteralPath $changingCache -Directory -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'Changed source must not publish a mixed runtime or leave staging.'
    }
    [IO.File]::WriteAllText((Join-Path $resourcesDir 'codex-command-runner.exe'), $expected['codex-command-runner.exe'])
    Import-Module (Join-Path $projectRoot 'CodexProxyLauncher.psm1') -Force
    $module = Get-Module CodexProxyLauncher
    & $module {
        function script:Copy-CodexRuntimeFile {
            param([string]$Source, [string]$Destination)
            [IO.File]::WriteAllText($Destination, 'damaged-copy')
        }
    }
    $damagedCache = Join-Path $tempRoot 'damaged-copy-cache'
    Assert-Fails { Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $damagedCache } '校验|verif'
    if (@(Get-ChildItem -LiteralPath $damagedCache -Directory -ErrorAction SilentlyContinue).Count -ne 0) {
        throw 'Damaged copy must not publish a runtime or leave staging.'
    }
    Import-Module (Join-Path $projectRoot 'CodexProxyLauncher.psm1') -Force

    $parallelCache = Join-Path $tempRoot 'parallel-cache'
    $jobs = @(1..2 | ForEach-Object {
        Start-Job -ScriptBlock {
            param($modulePath, $gui, $cache)
            $ErrorActionPreference = 'Stop'
            Import-Module $modulePath -Force
            & (Get-Module CodexProxyLauncher) {
                function script:Copy-CodexRuntimeFile {
                    param([string]$Source, [string]$Destination)
                    if ([IO.Path]::GetFileName($Source) -eq 'codex.exe') { Start-Sleep -Milliseconds 500 }
                    [IO.File]::Copy($Source, $Destination, $false)
                }
            }
            Sync-CodexRuntime -CodexExecutable $gui -DestinationRoot $cache
        } -ArgumentList (Join-Path $projectRoot 'CodexProxyLauncher.psm1'), $guiExecutable, $parallelCache
    })
    try {
        $jobs | Wait-Job -Timeout 30 | Out-Null
        foreach ($job in $jobs) {
            if ($job.State -ne 'Completed') { throw "Concurrent runtime preparation failed: $($job.State); $($job.ChildJobs[0].JobStateInfo.Reason)" }
        }
        $outputs = @($jobs | Receive-Job)
        if ($outputs.Count -ne 2 -or $outputs[0] -cne $outputs[1]) { throw 'Concurrent starts must reuse one fully verified runtime.' }
        if (@(Get-ChildItem -LiteralPath $parallelCache -Directory).Count -ne 1) { throw 'Concurrent starts must not leave a second staging directory.' }
    }
    finally { $jobs | Remove-Job -Force }

    Write-Host 'Runtime relocation test passed.'
}
finally {
    $resolved = [IO.Path]::GetFullPath($tempRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -ine [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') -or
        [IO.Path]::GetFileName($resolved) -notlike 'codex-runtime-test-*') { throw 'Unsafe test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
