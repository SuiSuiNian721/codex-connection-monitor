$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $projectRoot 'CodexProxyLauncher.psm1') -Force

$tempRoot = Join-Path $env:TEMP ('codex-cache-isolation-test-' + [guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA
$script:assertions = 0

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:assertions++
}

function Invoke-NativeCacheCleanupFixture {
    param([string]$DestinationRoot, [string]$CurrentHash)

    # Codex 26.1007.2314.0 removes other 16-digit cache directories containing
    # the same executable, even when its own current cache was already valid.
    $root = [IO.Path]::GetFullPath($DestinationRoot)
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot 'local-app-data\OpenAI\Codex\bin'))
    if ($root -cne $expectedRoot) { throw 'Unsafe native cleanup fixture root.' }
    foreach ($item in @(Get-ChildItem -LiteralPath $root -Directory)) {
        $target = [IO.Path]::GetFullPath($item.FullName)
        if ([IO.Path]::GetDirectoryName($target) -cne $root -or
            ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe native cleanup fixture target.' }
        if ($item.Name -cne $CurrentHash -and $item.Name -cmatch '^[0-9a-f]{16}$' -and
            (Test-Path -LiteralPath (Join-Path $target 'codex.exe') -PathType Leaf)) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
    }
}

try {
    $env:LOCALAPPDATA = Join-Path $tempRoot 'local-app-data'
    $appDirectory = Join-Path $tempRoot 'package\app'
    $resourcesDirectory = Join-Path $appDirectory 'resources'
    $guiExecutable = Join-Path $appDirectory 'ChatGPT.exe'
    $nativeRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $launcherRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\launcher-bin'
    New-Item -ItemType Directory -Path $resourcesDirectory -Force | Out-Null
    [IO.File]::WriteAllText($guiExecutable, 'fixture-gui', [Text.UTF8Encoding]::new($false))
    $expected = [ordered]@{
        'codex.exe' = 'fixture-cli'
        'codex-code-mode-host.exe' = 'fixture-code-mode-host'
        'codex-windows-sandbox-setup.exe' = 'fixture-sandbox-setup'
        'codex-windows-sandbox-service.exe' = 'fixture-sandbox-service'
        'codex-command-runner.exe' = 'fixture-command-runner'
    }
    foreach ($entry in $expected.GetEnumerator()) {
        [IO.File]::WriteAllText((Join-Path $resourcesDirectory $entry.Key), $entry.Value, [Text.UTF8Encoding]::new($false))
    }

    # Exercise the real default argument while redirecting LOCALAPPDATA only in
    # this test process. The explicit destination remains a supported override.
    $runtimeCli = Sync-CodexRuntime -CodexExecutable $guiExecutable
    $legacyCli = Sync-CodexRuntime -CodexExecutable $guiExecutable -DestinationRoot $nativeRoot
    Assert-True (Test-Path -LiteralPath $legacyCli -PathType Leaf) 'An explicit DestinationRoot must still work.'
    $nativeCurrent = Join-Path $nativeRoot '0000000000000000'
    New-Item -ItemType Directory -Path $nativeCurrent | Out-Null
    [IO.File]::WriteAllText((Join-Path $nativeCurrent 'codex.exe'), 'fixture-native-cli', [Text.UTF8Encoding]::new($false))
    $nativeUnrelated = Join-Path $nativeRoot '1111111111111111'
    New-Item -ItemType Directory -Path $nativeUnrelated | Out-Null
    [IO.File]::WriteAllText((Join-Path $nativeUnrelated 'rg.exe'), 'fixture-ripgrep', [Text.UTF8Encoding]::new($false))

    Invoke-NativeCacheCleanupFixture -DestinationRoot $nativeRoot -CurrentHash '0000000000000000'
    Assert-True (-not (Test-Path -LiteralPath $legacyCli)) 'The fixture must reproduce native removal of a launcher cache in native bin.'
    Assert-True (Test-Path -LiteralPath $runtimeCli -PathType Leaf) 'The default launcher CLI was removed by native cache cleanup; its cache must be isolated.'
    Assert-True ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($runtimeCli)) -ceq $launcherRoot) 'The default CLI cache must use OpenAI\Codex\launcher-bin.'
    Assert-True (Test-Path -LiteralPath (Join-Path $nativeCurrent 'codex.exe')) 'Native cleanup must retain the native current version.'
    Assert-True (Test-Path -LiteralPath (Join-Path $nativeUnrelated 'rg.exe')) 'Native cleanup must retain unrelated executable caches.'
    $runtimeDirectory = Split-Path $runtimeCli -Parent
    foreach ($entry in $expected.GetEnumerator()) {
        Assert-True ([IO.File]::ReadAllText((Join-Path $runtimeDirectory $entry.Key)) -ceq $entry.Value) "Isolated cache content changed: $($entry.Key)"
    }

    $before = (Get-Item -LiteralPath $runtimeCli).LastWriteTimeUtc
    $reused = Sync-CodexRuntime -CodexExecutable $guiExecutable
    Assert-True ($reused -ceq $runtimeCli) 'Repeated starts must reuse the same isolated CLI.'
    Assert-True ((Get-Item -LiteralPath $runtimeCli).LastWriteTimeUtc -eq $before) 'Reusing a cache must not rewrite its CLI.'
    Assert-True (@(Get-ChildItem -LiteralPath $launcherRoot -Directory).Count -eq 1) 'Repeated starts must not create additional cache directories.'

    $serviceName = 'codex-windows-sandbox-service.exe'
    [IO.File]::WriteAllText((Join-Path $resourcesDirectory $serviceName), 'fixture-sandbox-service-v2', [Text.UTF8Encoding]::new($false))
    $updatedCli = Sync-CodexRuntime -CodexExecutable $guiExecutable
    Assert-True ($updatedCli -cne $runtimeCli) 'A changed runtime companion must receive a new isolated cache.'
    Assert-True ([IO.File]::ReadAllText((Join-Path $runtimeDirectory $serviceName)) -ceq $expected[$serviceName]) 'An upgrade must preserve the previous runtime companion.'
    Assert-True ([IO.File]::ReadAllText((Join-Path (Split-Path $updatedCli -Parent) $serviceName)) -ceq 'fixture-sandbox-service-v2') 'The upgraded cache must contain the new runtime companion.'
    Invoke-NativeCacheCleanupFixture -DestinationRoot $nativeRoot -CurrentHash '0000000000000000'
    Assert-True ((Test-Path -LiteralPath $runtimeCli) -and (Test-Path -LiteralPath $updatedCli)) 'Native cleanup must leave both isolated runtime versions intact.'
    Assert-True (@(Get-ChildItem -LiteralPath $launcherRoot -Directory).Count -eq 2) 'An upgrade must preserve both complete isolated runtime versions.'

    Write-Host "Runtime cache isolation tests passed. Assertions=$script:assertions"
}
finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    $resolved = [IO.Path]::GetFullPath($tempRoot)
    if ([IO.Path]::GetDirectoryName($resolved) -ine [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') -or
        [IO.Path]::GetFileName($resolved) -notmatch '^codex-cache-isolation-test-[0-9a-f]{32}$') { throw 'Unsafe isolation test cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
