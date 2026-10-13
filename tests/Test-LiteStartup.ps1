$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot 'Start-CodexWithProxy.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw '轻量版启动器语法错误。' }
if ($ast.Extent.Text -match 'PerformanceMonitor|GenerationBridge|CodexProxyRelay|node\.exe') { throw '轻量版混入了面板依赖。' }
foreach ($name in @('Get-CodexStartupBackgroundRoot', 'Complete-CodexStartup', 'Confirm-CodexWindowReady')) {
    $definition = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if (-not $definition) { throw "缺少启动处理函数：$name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Assert-Condition { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
$script:executable = 'C:\fixture\ChatGPT.exe'
$script:launchTime = [datetime]'2026-10-13T04:25:00Z'
$script:root = [pscustomobject]@{ Id = 101; Path = $script:executable; StartTime = $script:launchTime.AddSeconds(1) }
$script:record = [pscustomobject]@{
    ProcessId = 101; ExecutablePath = $script:executable; CreationDate = $script:root.StartTime
    CommandLine = '"C:\fixture\ChatGPT.exe" --proxy-server=http://127.0.0.1:7890'
}
$script:watched = @()
function Get-RunningCodexProcesses { param($ExecutablePath) $script:root }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) $script:record }
function Write-LauncherLog { param($Message, $Level) }
function Start-ConnectionWatchdog {
    param($RootProcessId, $CodexExecutable, $ProxyUri, $ProxyMode)
    if ($ProxyUri -ne 'http://127.0.0.1:7890' -or $ProxyMode -ne 'Explicit') { throw '轻量版代理参数改变。' }
    $script:watched += $RootProcessId
}
function Start-Process { throw '测试不得启动真实进程。' }
function Stop-Process { throw '测试不得终止真实进程。' }
function Invoke-Fixture {
    param([string]$Status, [switch]$NoWatchdog)
    $result = [pscustomobject]@{ Status = $Status; Process = [pscustomobject]@{ Id = 202 }; ProcessIds = @(101); ElapsedSeconds = 90 }
    Complete-CodexStartup -StartupWindow $result -CodexExecutable $script:executable `
        -LaunchStartedAt $script:launchTime -ProxyUri 'http://127.0.0.1:7890' -ProxyMode Explicit -NoWatchdog:$NoWatchdog
}
function Assert-Incomplete {
    param([string]$Status = 'TimedOut', [switch]$NoWatchdog)
    $caught = $false
    try { $null = Invoke-Fixture -Status $Status -NoWatchdog:$NoWatchdog }
    catch {
        $caught = $true
        Assert-Condition ($_.Exception.Message -match '启动未完成') '未返回真实窗口未就绪错误。'
    }
    Assert-Condition $caught '没有窗口时误报成功。'
}
$ready = Invoke-Fixture Ready
Assert-Condition ($ready.Id -eq 202 -and $script:watched[0] -eq 202) '就绪时没有绑定实际窗口进程。'
$script:watched = @()
Assert-Incomplete
Assert-Condition ($script:watched.Count -eq 1 -and $script:watched[0] -eq 101) '窗口超时后丢失连接监测。'
foreach ($command in @('"C:\fixture\ChatGPT.exe" --type=renderer --proxy-server=http://127.0.0.1:7890',
    '"C:\fixture\ChatGPT.exe" --proxy-server=http://127.0.0.1:7891', '"C:\fixture\ChatGPT.exe"')) {
    $script:record.CommandLine = $command
    $script:watched = @()
    Assert-Incomplete
    Assert-Condition ($script:watched.Count -eq 0) '其他入口或子进程被错误绑定。'
}
$script:record.CommandLine = '"C:\fixture\ChatGPT.exe" --proxy-server=http://127.0.0.1:7890'
$script:watched = @()
Assert-Incomplete -NoWatchdog
Assert-Condition ($script:watched.Count -eq 0) '禁用开关未生效。'
Assert-Incomplete -Status Exited
Assert-Condition ($script:watched.Count -eq 0) '已退出时仍启动监测。'
Write-Host 'Lite startup: visible window, timeout monitoring, identity/proxy guards, disabled monitor and exit checks passed.'
