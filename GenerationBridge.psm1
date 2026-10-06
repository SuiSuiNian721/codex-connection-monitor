Set-StrictMode -Version Latest

function Assert-GenerationPath {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [ValidateSet('File', 'Directory')][string]$Kind
    )
    $absolute = [IO.Path]::GetFullPath($LiteralPath)
    $item = Get-Item -LiteralPath $absolute -Force -ErrorAction Stop
    if (($Kind -eq 'File' -and $item.PSIsContainer) -or ($Kind -eq 'Directory' -and -not $item.PSIsContainer)) {
        throw '生成速度采集路径类型不正确。'
    }
    $current = $item
    while ($null -ne $current) {
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw '生成速度采集不使用重解析路径。'
        }
        $parentPath = Split-Path -Parent $current.FullName
        if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -eq $current.FullName) { break }
        $current = Get-Item -LiteralPath $parentPath -Force -ErrorAction Stop
    }
    return $absolute
}

function Get-CodexGenerationConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RealCliPath,
        [Parameter(Mandatory = $true)][string]$CodexHome,
        [string]$ProjectRoot = $PSScriptRoot
    )
    $ProjectRoot = [IO.Path]::TrimEndingDirectorySeparator((Assert-GenerationPath -LiteralPath $ProjectRoot -Kind Directory))
    $RealCliPath = Assert-GenerationPath -LiteralPath $RealCliPath -Kind File
    $CodexHome = [IO.Path]::TrimEndingDirectorySeparator((Assert-GenerationPath -LiteralPath $CodexHome -Kind Directory))
    $forwarderPath = Assert-GenerationPath -LiteralPath (Join-Path $ProjectRoot 'bridge\CodexGenerationForwarder.exe') -Kind File
    $scriptPath = Assert-GenerationPath -LiteralPath (Join-Path $ProjectRoot 'performance-monitor\generation-bridge.mjs') -Kind File
    if ($RealCliPath -eq $forwarderPath) { throw '真实 CLI 不能是生成速度桥接器本身。' }
    $node = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $nodePath = Assert-GenerationPath -LiteralPath $node.Source -Kind File
    $nodeVersion = & $nodePath --version
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) {
        throw '生成速度采集需要 Node.js 20 或更新版本。'
    }
    $homeKey = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($CodexHome.ToLowerInvariant()))).Substring(0, 24).ToLowerInvariant()
    $launchId = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()
    $stateDirectory = Join-Path $ProjectRoot "runtime\performance-$homeKey\generation"
    # 逐层核对现有目录；避免 New-Item 沿着已有 junction 写到项目外。
    $current = $ProjectRoot
    foreach ($part in @('runtime', "performance-$homeKey", 'generation', $launchId)) {
        $current = Join-Path $current $part
        if (-not (Test-Path -LiteralPath $current)) { [void](New-Item -ItemType Directory -Path $current -ErrorAction Stop) }
        [void](Assert-GenerationPath -LiteralPath $current -Kind Directory)
    }
    [pscustomobject]@{
        Enabled = $true
        ForwarderPath = $forwarderPath
        RealCliPath = $RealCliPath
        NodeExecutable = $nodePath
        ScriptPath = $scriptPath
        StateDirectory = $stateDirectory
        HomeKey = $homeKey
        LaunchId = $launchId
        ProjectRoot = $ProjectRoot
    }
}

function Register-CodexGenerationBinding {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Configuration,
        [Parameter(Mandatory = $true)][Diagnostics.Process]$CodexProcess
    )
    if (-not $Configuration.Enabled -or $Configuration.HomeKey -notmatch '^[a-f0-9]{24}$' -or $Configuration.LaunchId -notmatch '^[a-f0-9]{32}$') {
        throw '生成速度采集启动身份不正确。'
    }
    $root = Assert-GenerationPath -LiteralPath $Configuration.ProjectRoot -Kind Directory
    $expected = [IO.Path]::GetFullPath((Join-Path $root "runtime\performance-$($Configuration.HomeKey)\generation"))
    $actual = Assert-GenerationPath -LiteralPath $Configuration.StateDirectory -Kind Directory
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw '生成速度采集目录不属于本次配置。' }
    [void](Assert-GenerationPath -LiteralPath (Join-Path $actual $Configuration.LaunchId) -Kind Directory)
    $CodexProcess.Refresh()
    if ($CodexProcess.HasExited) { throw 'Codex 已退出，无法注册实时采集身份。' }
    $current = Get-Process -Id $CodexProcess.Id -ErrorAction Stop
    if ($current.StartTime.ToUniversalTime() -ne $CodexProcess.StartTime.ToUniversalTime() -or $current.Path -ne $CodexProcess.Path) {
        throw 'Codex 根进程身份已经改变。'
    }
    $binding = [ordered]@{
        version = 1
        launchId = $Configuration.LaunchId
        homeKey = $Configuration.HomeKey
        codexPid = $current.Id
        codexStartedAt = $current.StartTime.ToUniversalTime().ToString('o')
        codexExecutable = $current.Path
    }
    $destination = Join-Path $actual 'binding.json'
    if (Test-Path -LiteralPath $destination) { [void](Assert-GenerationPath -LiteralPath $destination -Kind File) }
    $temporary = Join-Path $actual ('binding-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $content = $binding | ConvertTo-Json -Compress
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($content)
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        [void](Assert-GenerationPath -LiteralPath $actual -Kind Directory)
        if (Test-Path -LiteralPath $destination) { [void](Assert-GenerationPath -LiteralPath $destination -Kind File) }
        [IO.File]::Move($temporary, $destination, $true)
    } finally {
        # 不枚举或删除旧 snapshot，只清理本次写入自己的临时文件。
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue }
    }
}

Export-ModuleMember -Function Get-CodexGenerationConfiguration, Register-CodexGenerationBinding
