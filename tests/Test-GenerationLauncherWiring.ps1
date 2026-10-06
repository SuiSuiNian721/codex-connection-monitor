$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$launcherPath = Join-Path $projectRoot 'Start-CodexWithProxy.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($launcherPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw '启动器语法错误。' }
$initializer = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Initialize-GenerationCollection'
}, $true)
if (-not $initializer) { throw '缺少实时采集初始化。' }
# 单独执行启动器的实际初始化函数，避免启动 Codex、VPN 或代理进程。
. ([scriptblock]::Create($initializer.Extent.Text))
$scriptRoot = $projectRoot
$script:moduleRequests = 0
$script:configurationRequests = 0
$script:shouldFail = $false
$script:warnings = @()
function Import-Module { param($Name, [switch]$Force) $script:moduleRequests++ }
function Write-LauncherLog { param($Message, $Level) $script:warnings += $Message }
function Get-CodexGenerationConfiguration {
    param($RealCliPath, $CodexHome, $ProjectRoot)
    $script:configurationRequests++
    if ($script:shouldFail) { throw '模拟桥接预检失败' }
    if ($CodexHome -ne $env:CODEX_HOME -or $ProjectRoot -ne $scriptRoot) { throw '采集配置目录不正确。' }
    [pscustomobject]@{
        NodeExecutable = 'C:\fixture\node.exe'; ScriptPath = 'C:\fixture\桥接.mjs'
        RealCliPath = $RealCliPath; StateDirectory = 'C:\fixture\generation'
        LaunchId = 'a' * 32; HomeKey = 'b' * 24; ForwarderPath = 'C:\fixture\forwarder.exe'
    }
}
function Assert-Condition { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
$environmentNames = @('CODEX_HOME', 'CODEX_CLI_PATH', 'CODEX_GENERATION_NODE', 'CODEX_GENERATION_SCRIPT',
    'CODEX_GENERATION_REAL_CLI', 'CODEX_GENERATION_STATE_DIR', 'CODEX_GENERATION_LAUNCH_ID', 'CODEX_GENERATION_HOME_KEY')
$before = @{}
foreach ($name in $environmentNames) { $before[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:CODEX_HOME = 'F:\fixture\codex'
    $configuration = Initialize-GenerationCollection -RealCliPath 'C:\fixture\real.exe'
    Assert-Condition ($null -ne $configuration -and $env:CODEX_CLI_PATH -eq $configuration.ForwarderPath) '正常启动未接入桥接器。'
    Assert-Condition ($env:CODEX_GENERATION_REAL_CLI -eq 'C:\fixture\real.exe' -and
        $env:CODEX_GENERATION_HOME_KEY -eq ('b' * 24) -and $env:CODEX_GENERATION_LAUNCH_ID -eq ('a' * 32)) '桥接器未收到真实 CLI 和本次启动身份。'
    $moduleBefore = $script:moduleRequests
    $configuration = Initialize-GenerationCollection -RealCliPath 'C:\fixture\real.exe' -Disabled
    Assert-Condition ($null -eq $configuration -and $script:moduleRequests -eq $moduleBefore) '禁用监测仍加载了实时采集模块。'
    foreach ($name in $environmentNames | Where-Object { $_ -like 'CODEX_GENERATION_*' }) {
        Assert-Condition ($null -eq [Environment]::GetEnvironmentVariable($name, 'Process')) "禁用监测未清除旧变量 $name。"
    }
    Assert-Condition ($env:CODEX_CLI_PATH -eq 'C:\fixture\real.exe') '禁用后未回到真实 CLI。'
    $env:CODEX_GENERATION_NODE = '残留变量'
    $script:shouldFail = $true
    $configuration = Initialize-GenerationCollection -RealCliPath 'C:\fixture\real.exe'
    Assert-Condition ($null -eq $configuration -and $env:CODEX_CLI_PATH -eq 'C:\fixture\real.exe' -and
        $null -eq [Environment]::GetEnvironmentVariable('CODEX_GENERATION_NODE', 'Process') -and $script:warnings.Count -eq 1) '预检失败未安全回退到真实 CLI。'
    $text = $ast.Extent.Text
    Assert-Condition ($text.IndexOf('duplicate launch skipped.') -lt $text.IndexOf('$generationConfiguration = Initialize-GenerationCollection')) '已运行会话被实时接线改变。'
    Assert-Condition ($text.IndexOf('$generationConfiguration = Initialize-GenerationCollection') -lt $text.IndexOf('$started = Start-Process')) '实时接线发生在启动之后。'
    Assert-Condition ($text.IndexOf('Register-CodexGenerationBinding -Configuration') -lt $text.IndexOf('if (-not $NoWatchdog)')) '实时绑定错误依赖连接监视器。'
    Write-Host 'Generation launcher wiring: enabled, disabled, fallback and launch ordering passed; no app was launched.'
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $before[$name], 'Process') }
}
