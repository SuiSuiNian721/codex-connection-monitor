Set-StrictMode -Version 2.0

function Get-CuaFingerprint {
    param([Parameter(Mandatory)][string]$Source)

    $text = ''
    foreach ($relative in @('manifest.json', 'bin/node.exe', 'bin/node_repl.exe')) {
        $digest = (Get-FileHash -LiteralPath (Join-Path $Source $relative) -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
        $text += $relative + [char]0 + $digest + [char]0
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '').ToLowerInvariant().Substring(0, 16)
    }
    finally { $sha.Dispose() }
}

function Assert-CuaDestination {
    param([Parameter(Mandatory)][string]$Path)

    # Reject linked cache parents too, so cleanup/publish cannot escape via a junction.
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "缓存路径不能经过链接（reparse）：$current"
            }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Sync-CodexCuaRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$CodexExecutable,
        [string]$DestinationRoot = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'),
        [scriptblock]$OnProgress
    )

    $ErrorActionPreference = 'Stop'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $source = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $CodexExecutable) 'resources\cua_node')).TrimEnd('\')
    $cacheRoot = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
    if ($cacheRoot -eq [IO.Path]::GetPathRoot($cacheRoot).TrimEnd('\') -or
        $cacheRoot.Equals($source, [StringComparison]::OrdinalIgnoreCase) -or
        $cacheRoot.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $source.StartsWith($cacheRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CUA 源目录与缓存目录不能重叠（overlap），缓存也不能是磁盘根目录。'
    }
    Assert-CuaDestination -Path $cacheRoot
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "未找到 CUA 运行环境：$source" }
    if (-not ('CodexLauncher.CuaCopyJob' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'CuaRuntimeCopy.cs')
    }
    [CodexLauncher.CuaCopyJob]::AssertNoReparse($source)
    $items = @(Get-ChildItem -LiteralPath $source -Recurse -Force -ErrorAction Stop)
    foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "CUA 源目录包含不支持的链接（reparse）：$($item.FullName)" }
    }
    $files = [string[]]@($items | Where-Object { -not $_.PSIsContainer } | ForEach-Object { [IO.Path]::GetRelativePath($source, $_.FullName) })
    $directories = [string[]]@($items | Where-Object PSIsContainer | ForEach-Object { [IO.Path]::GetRelativePath($source, $_.FullName) })
    try {
        $manifest = Get-Content -LiteralPath (Join-Path $source 'manifest.json') -Raw -Encoding utf8 | ConvertFrom-Json
        if ($manifest.platform -cne 'windows' -or $manifest.node_path -cne 'bin/node.exe' -or
            $manifest.node_repl_path -cne 'bin/node_repl.exe' -or $manifest.node_modules -cne 'bin/node_modules') {
            throw 'Unsupported manifest layout.'
        }
    }
    catch { throw "CUA manifest JSON 校验失败：$($_.Exception.Message)" }
    if (-not (Test-Path -LiteralPath (Join-Path $source 'bin\node_modules') -PathType Container)) { throw 'CUA manifest 指定的 node_modules 不存在。' }
    $fingerprint = Get-CuaFingerprint -Source $source
    $destination = Join-Path $cacheRoot $fingerprint
    $receiptPath = Join-Path $cacheRoot ('.verified-' + $fingerprint + '.json')
    $mutexHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($cacheRoot.ToLowerInvariant()))).Substring(0,24)
    $mutex = [Threading.Mutex]::new($false, "Local\CodexCuaPrepare-$mutexHash")
    $ownsMutex = $false
    $staging = $null
    $job = $null
    try {
        try { $ownsMutex = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { throw '另一个启动器仍在准备 CUA 缓存，请等待后再试。' }
        Assert-CuaDestination -Path $destination
        Assert-CuaDestination -Path $receiptPath
        $status = 'Reused'
        $validation = 'Full'
        $signature = $null
        if (Test-Path -LiteralPath $destination) {
            $signature = [CodexLauncher.CuaCopyJob]::MetadataSignature($source, $destination, $files, $directories)
            if (-not $signature) { throw "CUA 缓存或源目录的完整文件清单不一致，未覆盖缓存：$destination" }
            $receipt = $null
            try {
                if ((Test-Path -LiteralPath $receiptPath -PathType Leaf) -and (Get-Item -LiteralPath $receiptPath).Length -lt 4096) {
                    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
                }
            }
            catch { $receipt = $null }
            if ($receipt -is [Collections.IDictionary] -and $receipt['SchemaVersion'] -eq 1 -and $receipt['Source'] -ceq $source -and
                $receipt['Path'] -ceq $destination -and $receipt['Signature'] -ceq $signature) {
                $validation = 'Metadata'
            }
            elseif (-not [CodexLauncher.CuaCopyJob]::Matches($source, $destination, $files, $directories)) {
                throw "已有 CUA 缓存不完整或与源文件不符；为保护正在运行的 GPT，未覆盖缓存：$destination"
            }
            if ($validation -eq 'Full' -and $signature -cne [CodexLauncher.CuaCopyJob]::MetadataSignature($source, $destination, $files, $directories)) {
                throw 'CUA 缓存或源文件在校验期间发生变化，未生成验证记录。'
            }
        }
        else {
            New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
            $staging = Join-Path $cacheRoot ('.prepare-' + $fingerprint + '-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $staging | Out-Null
            foreach ($relative in $directories) { [IO.Directory]::CreateDirectory((Join-Path $staging $relative)) | Out-Null }
            $job = [CodexLauncher.CuaCopyJob]::new($source, $staging, $files)
            do {
                $progress = [pscustomobject]@{ CompletedFiles = $job.CompletedFiles; TotalFiles = $files.Length; ElapsedSeconds = [math]::Round($clock.Elapsed.TotalSeconds, 1) }
                if ($OnProgress) { & $OnProgress $progress | Out-Null }
                if (-not $job.Work.IsCompleted) { Start-Sleep -Milliseconds 200 }
            } while (-not $job.Work.IsCompleted)
            $job.Work.GetAwaiter().GetResult()
            $signature = [CodexLauncher.CuaCopyJob]::MetadataSignature($source, $staging, $files, $directories)
            if ((Get-CuaFingerprint -Source $source) -cne $fingerprint -or
                -not $signature -or -not [CodexLauncher.CuaCopyJob]::Matches($source, $staging, $files, $directories) -or
                $signature -cne [CodexLauncher.CuaCopyJob]::MetadataSignature($source, $staging, $files, $directories)) {
                throw 'CUA 源文件在准备期间发生变化或校验失败，未发布缓存。'
            }
            Assert-CuaDestination -Path $destination
            try { [IO.Directory]::Move($staging, $destination); $staging = $null; $status = 'Prepared' }
            catch {
                # A concurrently starting native app may have published the same cache.
                $signature = [CodexLauncher.CuaCopyJob]::MetadataSignature($source, $destination, $files, $directories)
                if (-not (Test-Path -LiteralPath $destination -PathType Container) -or
                    -not $signature -or -not [CodexLauncher.CuaCopyJob]::Matches($source, $destination, $files, $directories) -or
                    $signature -cne [CodexLauncher.CuaCopyJob]::MetadataSignature($source, $destination, $files, $directories)) { throw }
            }
        }
        if ($validation -eq 'Full') {
            # This receipt is a trusted-local-cache optimization, not tamper-proof attestation.
            # Every call still fingerprints the source core and scans both complete inventories.
            $temporaryReceipt = $receiptPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
            try {
                Assert-CuaDestination -Path $receiptPath
                $json = [ordered]@{ SchemaVersion = 1; Source = $source; Path = $destination; Signature = $signature } | ConvertTo-Json -Compress
                [IO.File]::WriteAllText($temporaryReceipt, $json, [Text.UTF8Encoding]::new($false))
                [IO.File]::Move($temporaryReceipt, $receiptPath, $true)
            }
            catch { Write-Warning "缓存已完整校验，但无法保存复用记录，下次将重新校验：$($_.Exception.Message)" }
            finally {
                try { if (Test-Path -LiteralPath $temporaryReceipt) { Remove-Item -LiteralPath $temporaryReceipt -Force } }
                catch { Write-Warning "无法清理本次验证记录临时文件：$($_.Exception.Message)" }
            }
        }
        if ($OnProgress) { & $OnProgress ([pscustomobject]@{ CompletedFiles = $files.Length; TotalFiles = $files.Length; ElapsedSeconds = [math]::Round($clock.Elapsed.TotalSeconds, 1) }) | Out-Null }
        [pscustomobject]@{ Status = $status; Validation = $validation; Path = $destination; Fingerprint = $fingerprint; FileCount = $files.Length; ElapsedSeconds = [math]::Round($clock.Elapsed.TotalSeconds, 3) }
    }
    finally {
        if ($job) { $job.Dispose() }
        try {
            if ($staging -and (Test-Path -LiteralPath $staging)) {
                $resolved = [IO.Path]::GetFullPath($staging)
                if ([IO.Path]::GetDirectoryName($resolved) -ine $cacheRoot -or
                    [IO.Path]::GetFileName($resolved) -notmatch '^\.prepare-[0-9a-f]{16}-[0-9a-f]{32}$') { throw 'Unsafe CUA staging cleanup path.' }
                Assert-CuaDestination -Path $resolved
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
        }
        finally {
            if ($ownsMutex) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }
}

Export-ModuleMember -Function Sync-CodexCuaRuntime
