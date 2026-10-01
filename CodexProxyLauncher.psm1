Set-StrictMode -Version 2.0

if (-not ('CodexLauncher.NativeMethods' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace CodexLauncher {
    public static class NativeMethods {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CopyFileEx(
            string existingFile,
            string newFile,
            IntPtr progressRoutine,
            IntPtr data,
            ref bool cancel,
            uint copyFlags);
    }
}
"@
}

function Copy-CodexRuntimeFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $cancel = $false
    $allowDecryptedDestination = [uint32]0x00000008
    $copied = [CodexLauncher.NativeMethods]::CopyFileEx(
        $Source,
        $Destination,
        [IntPtr]::Zero,
        [IntPtr]::Zero,
        [ref]$cancel,
        $allowDecryptedDestination)
    if (-not $copied) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $error = New-Object ComponentModel.Win32Exception($code)
        throw "Failed to copy protected Codex runtime file '$Source': $($error.Message) (Win32 $code)"
    }
}

function ConvertTo-ProxyUri {
    [CmdletBinding()]
    param([AllowEmptyString()][string]$ProxyServer)

    if ([string]::IsNullOrWhiteSpace($ProxyServer)) {
        return $null
    }

    $candidate = $ProxyServer.Trim()
    $scheme = 'http'

    if ($candidate.Contains('=')) {
        $entries = @{}
        foreach ($part in ($candidate -split ';')) {
            if ($part -match '^\s*([^=]+)=(.+?)\s*$') {
                $entries[$matches[1].Trim().ToLowerInvariant()] = $matches[2].Trim()
            }
        }

        $candidate = $null
        foreach ($key in @('http', 'https', 'socks', 'socks5')) {
            if ($entries.ContainsKey($key)) {
                $candidate = $entries[$key]
                if ($key -like 'socks*') { $scheme = 'socks5' }
                break
            }
        }
        if (-not $candidate) { return $null }
    }

    if ($candidate -match '^([a-zA-Z][a-zA-Z0-9+.-]*)://(.+)$') {
        $scheme = $matches[1].ToLowerInvariant()
        $candidate = $matches[2]
    }

    if ($scheme -notin @('http', 'https', 'socks5')) { return $null }
    if ($candidate.EndsWith('/')) { $candidate = $candidate.Substring(0, $candidate.Length - 1) }
    if ($candidate -match '\s' -or $candidate -notmatch ':(\d+)$') { return $null }

    $uri = $null
    if (-not [Uri]::TryCreate("$scheme`://$candidate", [UriKind]::Absolute, [ref]$uri)) {
        return $null
    }
    if ($uri.Port -lt 1 -or $uri.Port -gt 65535 -or [string]::IsNullOrWhiteSpace($uri.Host) -or
        $uri.UserInfo -or $uri.AbsolutePath -notin @('', '/') -or $uri.Query -or $uri.Fragment) {
        return $null
    }

    return "$scheme`://$($uri.Host):$($uri.Port)"
}

function Find-CodexExecutable {
    [CmdletBinding()]
    param([string]$InstallLocation)

    $manifestExecutable = $null
    if ([string]::IsNullOrWhiteSpace($InstallLocation)) {
        $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
            Sort-Object { [version]$_.Version } -Descending |
            Select-Object -First 1
        if ($package) {
            $InstallLocation = $package.InstallLocation
            try {
                $application = $package | Get-AppxPackageManifest |
                    Select-Object -ExpandProperty Package |
                    Select-Object -ExpandProperty Applications |
                    Select-Object -ExpandProperty Application |
                    Select-Object -First 1
                if ($application.Executable) {
                    $manifestExecutable = ([string]$application.Executable).Replace('/', '\')
                }
            }
            catch { }
        }
    }

    if ([string]::IsNullOrWhiteSpace($InstallLocation)) { return $null }

    $candidates = @()
    if ($manifestExecutable) { $candidates += $manifestExecutable }
    $candidates += @('app\ChatGPT.exe', 'app\Codex.exe')
    foreach ($relativePath in ($candidates | Select-Object -Unique)) {
        $path = Join-Path $InstallLocation $relativePath
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            return $path
        }
    }
    return $null
}

function Test-LocalProxy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ProxyUri,
        [int]$TimeoutMilliseconds = 1500
    )

    $uri = $null
    $normalized = ConvertTo-ProxyUri -ProxyServer $ProxyUri
    if (-not $normalized -or -not [Uri]::TryCreate($normalized, [UriKind]::Absolute, [ref]$uri)) { return $false }
    if ($uri.DnsSafeHost -notin @('127.0.0.1', 'localhost', '::1')) { return $false }

    $client = New-Object System.Net.Sockets.TcpClient
    $waitHandle = $null
    try {
        $async = $client.BeginConnect($uri.DnsSafeHost, $uri.Port, $null, $null)
        $waitHandle = $async.AsyncWaitHandle
        if (-not $waitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
        if ($waitHandle) { $waitHandle.Dispose() }
    }
}

function Assert-CodexRuntimePath {
    param([Parameter(Mandatory)][string]$Path, [switch]$LeafOnly)

    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "CLI 运行环境路径不能经过链接（reparse）：$current"
        }
        if ($LeafOnly) { break }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Resolve-CodexRuntimeSourceDirectory {
    param([Parameter(Mandatory)][string]$Path)

    # Store packages moved to another drive may use a junction above resources.
    # Resolve those ancestors so physical source/cache overlap is still detected.
    $resolved = [IO.Path]::GetFullPath($Path)
    Assert-CodexRuntimePath -Path $resolved -LeafOnly
    for ($attempt = 0; $attempt -lt 32; $attempt++) {
        $current = [IO.Path]::GetDirectoryName($resolved)
        $changed = $false
        while ($current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
            if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                $targets = @($item.Target | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
                if ($targets.Count -ne 1) { throw "CLI 安装路径链接目标不可用：$current" }
                $targetPath = [string]$targets[0]
                if (-not [IO.Path]::IsPathFullyQualified($targetPath)) {
                    $targetPath = Join-Path ([IO.Path]::GetDirectoryName($current)) $targetPath
                }
                $target = Get-Item -LiteralPath $targetPath -Force -ErrorAction Stop
                if (-not $target.PSIsContainer) {
                    throw "CLI 安装路径链接目标不可用：$current"
                }
                $resolved = [IO.Path]::GetFullPath((Join-Path $target.FullName ([IO.Path]::GetRelativePath($current, $resolved))))
                $changed = $true
                break
            }
            $current = [IO.Path]::GetDirectoryName($current)
        }
        if (-not $changed) { return $resolved.TrimEnd('\') }
    }
    throw 'CLI 安装路径包含过多链接，无法解析运行环境。'
}

function Get-CodexRuntimeSourceState {
    param([Parameter(Mandatory)][string]$SourceDirectory)

    Assert-CodexRuntimePath -Path $SourceDirectory
    $names = @('codex.exe', 'codex-windows-sandbox-setup.exe', 'codex-command-runner.exe')
    $names += @(Get-ChildItem -LiteralPath $SourceDirectory -Filter 'codex-*.exe' -File -ErrorAction Stop |
        Sort-Object Name | Select-Object -ExpandProperty Name)
    $names = @($names | Select-Object -Unique)
    $hashes = [ordered]@{}
    $parts = @()
    foreach ($name in $names) {
        $source = Join-Path $SourceDirectory $name
        Assert-CodexRuntimePath -Path $source
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Codex runtime file is missing: $source"
        }
        $hashes[$name] = (Get-FileHash -LiteralPath $source -Algorithm SHA256 -ErrorAction Stop).Hash
        $parts += "$name|$($hashes[$name])"
    }
    $digest = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($parts -join "`n")))
    [pscustomobject]@{ Files = $names; Hashes = $hashes; Fingerprint = [Convert]::ToHexString($digest).ToLowerInvariant().Substring(0, 16) }
}

function Test-CodexRuntimeCache {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)]$SourceState)

    Assert-CodexRuntimePath -Path $Path
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    try {
        $items = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)
        if ($items.Count -ne $SourceState.Files.Count) { return $false }
        foreach ($item in $items) {
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
                -not $SourceState.Hashes.Contains($item.Name) -or
                (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash -cne $SourceState.Hashes[$item.Name]) {
                return $false
            }
        }
        return $true
    }
    catch { return $false }
}

function Sync-CodexRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CodexExecutable,
        [string]$DestinationRoot = (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')
    )

    $ErrorActionPreference = 'Stop'
    $sourceDirectory = Resolve-CodexRuntimeSourceDirectory -Path (Join-Path (Split-Path -Parent $CodexExecutable) 'resources')
    $cacheRoot = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\')
    if ($cacheRoot -eq [IO.Path]::GetPathRoot($cacheRoot).TrimEnd('\') -or
        $cacheRoot.Equals($sourceDirectory, [StringComparison]::OrdinalIgnoreCase) -or
        $cacheRoot.StartsWith($sourceDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $sourceDirectory.StartsWith($cacheRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CLI 源目录与缓存目录不能重叠（overlap），缓存不能是磁盘根目录。'
    }
    Assert-CodexRuntimePath -Path $sourceDirectory
    Assert-CodexRuntimePath -Path $cacheRoot
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) { throw "未找到 CLI 运行环境：$sourceDirectory" }
    $mutexHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($cacheRoot.ToLowerInvariant()))).Substring(0, 24)
    $mutex = [Threading.Mutex]::new($false, "Local\CodexCliPrepare-$mutexHash")
    $ownsMutex = $false
    $stagingDirectory = $null
    try {
        try { $ownsMutex = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { throw '另一个启动器仍在准备 CLI 缓存，请等待后再试。' }
        $sourceState = Get-CodexRuntimeSourceState -SourceDirectory $sourceDirectory
        $destinationDirectory = Join-Path $cacheRoot $sourceState.Fingerprint
        $runtimeCli = Join-Path $destinationDirectory 'codex.exe'
        Assert-CodexRuntimePath -Path $destinationDirectory
        if (Test-Path -LiteralPath $destinationDirectory) {
            if (-not (Test-CodexRuntimeCache -Path $destinationDirectory -SourceState $sourceState)) {
                throw "已有 CLI 缓存不完整或与源文件不符；为保护正在运行的 GPT，未移动或覆盖缓存：$destinationDirectory"
            }
            if ((Get-CodexRuntimeSourceState -SourceDirectory $sourceDirectory).Fingerprint -cne $sourceState.Fingerprint) {
                throw 'CLI 源文件在校验期间发生变化，请重新启动启动器。'
            }
            return $runtimeCli
        }

        New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
        Assert-CodexRuntimePath -Path $cacheRoot
        $stagingDirectory = Join-Path $cacheRoot ('.staging-' + $sourceState.Fingerprint + '-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $stagingDirectory | Out-Null
        foreach ($name in $sourceState.Files) {
            Copy-CodexRuntimeFile -Source (Join-Path $sourceDirectory $name) -Destination (Join-Path $stagingDirectory $name)
        }
        if (-not (Test-CodexRuntimeCache -Path $stagingDirectory -SourceState $sourceState) -or
            (Get-CodexRuntimeSourceState -SourceDirectory $sourceDirectory).Fingerprint -cne $sourceState.Fingerprint) {
            throw 'CLI 源文件在准备期间发生变化或复制校验失败，未发布缓存。'
        }
        Assert-CodexRuntimePath -Path $destinationDirectory
        try {
            [IO.Directory]::Move($stagingDirectory, $destinationDirectory)
            $stagingDirectory = $null
        }
        catch {
            # Another native component may have published the same complete runtime.
            if (-not (Test-CodexRuntimeCache -Path $destinationDirectory -SourceState $sourceState)) { throw }
        }
        return $runtimeCli
    }
    finally {
        try {
            if ($stagingDirectory -and (Test-Path -LiteralPath $stagingDirectory)) {
                $resolved = [IO.Path]::GetFullPath($stagingDirectory)
                if ([IO.Path]::GetDirectoryName($resolved) -ine $cacheRoot -or
                    [IO.Path]::GetFileName($resolved) -notmatch '^\.staging-[0-9a-f]{16}-[0-9a-f]{32}$') { throw 'Unsafe CLI staging cleanup path.' }
                Assert-CodexRuntimePath -Path $resolved
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
        }
        finally {
            if ($ownsMutex) { $mutex.ReleaseMutex() }
            $mutex.Dispose()
        }
    }
}

Export-ModuleMember -Function ConvertTo-ProxyUri, Find-CodexExecutable, Test-LocalProxy, Sync-CodexRuntime
