[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $projectRoot 'GenerationBridge.psm1'
if (-not (Test-Path -LiteralPath $modulePath -PathType Leaf)) { throw '缺少新生成速度桥接模块。' }
Import-Module -Name $modulePath -Force

function Assert-Generation([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('generation-module-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path (Join-Path $testRoot 'bridge') -Force)
[void](New-Item -ItemType Directory -Path (Join-Path $testRoot 'performance-monitor') -Force)
[void](New-Item -ItemType Directory -Path (Join-Path $testRoot 'home 中文') -Force)
try {
    Copy-Item -LiteralPath (Join-Path $projectRoot 'bridge\CodexGenerationForwarder.exe') -Destination (Join-Path $testRoot 'bridge\CodexGenerationForwarder.exe')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'performance-monitor\generation-bridge.mjs') -Destination (Join-Path $testRoot 'performance-monitor\generation-bridge.mjs')
    $nodePath = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $configuration = Get-CodexGenerationConfiguration -RealCliPath $nodePath -CodexHome (Join-Path $testRoot 'home 中文') -ProjectRoot $testRoot
    Assert-Generation $configuration.Enabled '配置未启用。'
    Assert-Generation ($configuration.RealCliPath -eq $nodePath) '真实 CLI 路径改变。'
    Assert-Generation ($configuration.NodeExecutable -eq $nodePath) 'Node 路径不正确。'
    Assert-Generation ($configuration.HomeKey -match '^[0-9a-f]{24}$') 'HomeKey 格式不正确。'
    Assert-Generation ($configuration.LaunchId -match '^[0-9a-f]{32}$') 'LaunchId 格式不正确。'
    Assert-Generation (Test-Path -LiteralPath $configuration.StateDirectory -PathType Container) '没有建立固定 runtime 目录。'
    Assert-Generation (Test-Path -LiteralPath (Join-Path $configuration.StateDirectory $configuration.LaunchId) -PathType Container) '没有建立本次启动独立采样目录。'
    $second = Get-CodexGenerationConfiguration -RealCliPath $nodePath -CodexHome (Join-Path $testRoot 'home 中文') -ProjectRoot $testRoot
    Assert-Generation ($second.HomeKey -eq $configuration.HomeKey -and $second.LaunchId -ne $configuration.LaunchId) '启动身份必须唯一，数据目录身份必须稳定。'
    $process = Get-Process -Id $PID
    Register-CodexGenerationBinding -Configuration $configuration -CodexProcess $process
    $bindingPath = Join-Path $configuration.StateDirectory 'binding.json'
    $bindingText = Get-Content -LiteralPath $bindingPath -Raw -Encoding utf8
    $binding = $bindingText | ConvertFrom-Json -DateKind String
    Assert-Generation ($binding.version -eq 1 -and $binding.launchId -eq $configuration.LaunchId -and $binding.codexPid -eq $PID) '绑定身份不正确。'
    Assert-Generation ($binding.codexExecutable -eq $process.Path) '缺少精确根进程路径。'
    Assert-Generation ([DateTimeOffset]::Parse($binding.codexStartedAt).UtcDateTime -eq $process.StartTime.ToUniversalTime()) '根进程时间未保留精度。'
    Assert-Generation ($bindingText -notmatch 'token|auth|PRIVATE') '绑定记录不应包含认证内容。'
    $bytes = [IO.File]::ReadAllBytes($bindingPath)
    Assert-Generation (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) '绑定 JSON 不应有 BOM。'
    $configuration.StateDirectory = Join-Path $testRoot 'outside'
    $rejected = $false
    try { Register-CodexGenerationBinding -Configuration $configuration -CodexProcess $process } catch { $rejected = $true }
    Assert-Generation $rejected '篡改的状态目录未被拒绝。'
    $missingRejected = $false
    try { Get-CodexGenerationConfiguration -RealCliPath (Join-Path $testRoot 'missing.exe') -CodexHome (Join-Path $testRoot 'home 中文') -ProjectRoot $testRoot } catch { $missingRejected = $true }
    Assert-Generation $missingRejected '缺失真实 CLI 时未拒绝。'
    $linkedRoot = Join-Path $testRoot 'linked-project'
    [void](New-Item -ItemType Directory -Path (Join-Path $linkedRoot 'bridge') -Force)
    [void](New-Item -ItemType Directory -Path (Join-Path $linkedRoot 'performance-monitor') -Force)
    Copy-Item -LiteralPath (Join-Path $testRoot 'bridge\CodexGenerationForwarder.exe') -Destination (Join-Path $linkedRoot 'bridge\CodexGenerationForwarder.exe')
    Copy-Item -LiteralPath (Join-Path $testRoot 'performance-monitor\generation-bridge.mjs') -Destination (Join-Path $linkedRoot 'performance-monitor\generation-bridge.mjs')
    $outside = Join-Path $testRoot 'unrelated-target'
    [void](New-Item -ItemType Directory -Path $outside)
    [void](New-Item -ItemType Junction -Path (Join-Path $linkedRoot 'runtime') -Target $outside)
    $linkedRejected = $false
    try { Get-CodexGenerationConfiguration -RealCliPath $nodePath -CodexHome (Join-Path $testRoot 'home 中文') -ProjectRoot $linkedRoot } catch { $linkedRejected = $true }
    Assert-Generation $linkedRejected 'runtime 重解析路径未被拒绝。'
    Assert-Generation (@(Get-ChildItem -LiteralPath $outside -Force).Count -eq 0) '读取配置沿重解析路径写入了外部目录。'
    Remove-Item -LiteralPath (Join-Path $linkedRoot 'runtime') -Force
    Remove-Item -LiteralPath (Join-Path $testRoot 'bridge\CodexGenerationForwarder.exe')
    $missingRejected = $false
    try { Get-CodexGenerationConfiguration -RealCliPath $nodePath -CodexHome (Join-Path $testRoot 'home 中文') -ProjectRoot $testRoot } catch { $missingRejected = $true }
    Assert-Generation $missingRejected '缺失原生桥接器时未拒绝。'
    Write-Output 'Generation bridge configuration checks passed'
} finally {
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolved.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^generation-module-[a-f0-9]{32}$') {
        throw '测试临时目录边界校验失败。'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
